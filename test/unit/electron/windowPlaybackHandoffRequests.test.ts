import fs from 'node:fs';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Execute the actual main-process handshake with fake windows, storage and timers only.
const source = fs.readFileSync(new URL('../../../electron/main.cjs', import.meta.url), 'utf8');
const start = source.indexOf('function rememberWindowPlaybackHandoff(');
const end = source.indexOf('function patchRemoteControlSnapshot(', start);
const setup = () => {
    const save = vi.fn(() => true);
    const send = vi.fn();
    let serial = 0;
    const context: any = vm.createContext({
        windowPlaybackHandoffStore: { save }, pendingWindowPlaybackHandoffRequests: new Map(),
        mainWindow: { isDestroyed: () => false, webContents: { send } },
        crypto: { randomUUID: () => `request-${++serial}` }, console,
        setTimeout, clearTimeout, WINDOW_PLAYBACK_HANDOFF_REQUEST_TIMEOUT_MS: 15000,
    });
    vm.runInContext(source.slice(start, end), context);
    return { context, save, send };
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('main-window playback cleanup handshake', () => {
    it('waits for the renderer to acknowledge completed output cleanup', async () => {
        const { context, save, send } = setup();
        const request = context.requestWindowPlaybackHandoff();
        const { requestId } = send.mock.calls[0][1];
        const handoff = { version: 1, playbackBackendId: 'any:output' };
        expect(save).not.toHaveBeenCalled();
        expect(context.resolvePendingWindowPlaybackHandoffRequest(requestId, handoff)).toBe(true);
        await expect(request).resolves.toBe(handoff);
        expect(save).toHaveBeenCalledExactlyOnceWith(handoff);
    });
    it('rejects mode changes instead of rebuilding over failed cleanup', async () => {
        const { context, save, send } = setup();
        const request = context.requestWindowPlaybackHandoff();
        const rejected = expect(request).rejects.toThrow('cleanup failed');
        context.resolvePendingWindowPlaybackHandoffRequest(send.mock.calls[0][1].requestId, null, 'cleanup failed');
        await rejected;
        expect(save).not.toHaveBeenCalled();
    });
    it('rejects a timeout and never persists a late response for an unrelated rebuild', async () => {
        const { context, save, send } = setup();
        const request = context.requestWindowPlaybackHandoff();
        const rejected = expect(request).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(15000);
        await rejected;
        expect(context.resolvePendingWindowPlaybackHandoffRequest(send.mock.calls[0][1].requestId, { version: 1 })).toBe(false);
        expect(save).not.toHaveBeenCalled();
    });
});

describe('desktop window mode entry points', () => {
    it('does not tear down playback for an unchanged transparency setting', async () => {
        const request = vi.fn();
        const apply = vi.fn();
        const context: any = vm.createContext({
            isTransparentPlayerBackgroundEnabled: () => true,
            requestWindowPlaybackHandoff: request, setMainWindowTransparentMode: apply,
        });
        const from = source.indexOf('async function setMainWindowTransparentModeFromRemote(');
        const to = source.indexOf('app.whenReady()', from);
        vm.runInContext(source.slice(from, to), context);
        await expect(context.setMainWindowTransparentModeFromRemote(true)).resolves.toBe(true);
        expect(request).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });
    it('refuses an unsupported transparent wallpaper before touching playback', async () => {
        const request = vi.fn();
        const context: any = vm.createContext({
            process: { platform: 'win32' }, isTransparentPlayerBackgroundEnabled: () => false,
            isWindowsWallpaperMode: () => true, isWindowsWallpaperTransparentSupported: () => false,
            requestWindowPlaybackHandoff: request, setMainWindowTransparentMode: async () => false,
        });
        const from = source.indexOf('async function setMainWindowTransparentModeFromRemote(');
        const to = source.indexOf('app.whenReady()', from);
        vm.runInContext(source.slice(from, to), context);
        await expect(context.setMainWindowTransparentModeFromRemote(true)).resolves.toBe(false);
        expect(request).not.toHaveBeenCalled();
    });
    it('Windows wallpaper rebuild waits for the cleanup handoff', async () => {
        const handoff = { playbackBackendId: 'not-hqplayer:output' };
        const rebuild = vi.fn();
        let release!: () => void;
        const gate = new Promise(resolve => { release = () => resolve(handoff); });
        const context: any = vm.createContext({
            process: { platform: 'win32' }, requestWindowPlaybackHandoff: () => gate,
            wallpaperModeRelaunchGeneration: 2, isTransparentPlayerBackgroundEnabled: () => false,
            recreateMainWindowWithTransparencyMode: rebuild,
        });
        const from = source.indexOf('async function relaunchForWallpaperModeChange(');
        const to = source.indexOf('// Rebuilds the main window before a mac wallpaper entry', from);
        vm.runInContext(source.slice(from, to), context);
        const changing = context.relaunchForWallpaperModeChange(true, 2);
        expect(rebuild).not.toHaveBeenCalled();
        release();
        await changing;
        expect(rebuild).toHaveBeenCalledExactlyOnceWith(false, handoff);
    });
    it('Windows wallpaper does not rebuild if old output cleanup fails', async () => {
        const rebuild = vi.fn();
        const context: any = vm.createContext({
            process: { platform: 'win32' }, wallpaperModeRelaunchGeneration: 2,
            requestWindowPlaybackHandoff: async () => { throw new Error('output still active'); },
            recreateMainWindowWithTransparencyMode: rebuild,
        });
        const from = source.indexOf('async function relaunchForWallpaperModeChange(');
        const to = source.indexOf('// Rebuilds the main window before a mac wallpaper entry', from);
        vm.runInContext(source.slice(from, to), context);
        await expect(context.relaunchForWallpaperModeChange(true, 2)).rejects.toThrow('output still active');
        expect(rebuild).not.toHaveBeenCalled();
    });
    it('desktop lyrics awaits the transparent-mode handoff before enabling click-through', async () => {
        const clicks = vi.fn();
        let release!: () => void;
        const changing = new Promise<void>(resolve => { release = resolve; });
        const context: any = vm.createContext({
            isWallpaperModeEnabled: () => false, isTransparentPlayerBackgroundEnabled: () => false,
            setMainWindowClickThroughEnabled: clicks, setMainWindowAlwaysOnTop: vi.fn(),
            persistMainWindowSkipTaskbarEnabled: vi.fn(), setMainWindowTransparentModeFromRemote: () => changing,
        });
        const from = source.indexOf('async function setDesktopLyricMode(');
        const to = source.indexOf('async function resetMainWindowPresentation(', from);
        vm.runInContext(source.slice(from, to), context);
        const pending = context.setDesktopLyricMode(true);
        expect(clicks).toHaveBeenCalledExactlyOnceWith(false);
        release();
        await pending;
        expect(clicks).toHaveBeenLastCalledWith(true);
    });
});
