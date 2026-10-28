import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Media leases belong to a trusted main frame, not a remote window, iframe, or replaced renderer.
const require = createRequire(import.meta.url);
const { registerPlaybackSourceIpc } = require('../../../electron/playbackBackends/ipc.cjs');

const setup = () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const contents = Object.assign(new EventEmitter(), { id: 7, mainFrame: {} });
    const files = { stage: vi.fn(), release: vi.fn() };
    const streams = { create: vi.fn(), release: vi.fn(), releaseOwner: vi.fn(), getError: vi.fn() };
    registerPlaybackSourceIpc({ ipcMain: { handle: (name: string, action: any) => handlers.set(name, action) }, files, streams,
        isTrusted: (sender: unknown) => sender === contents });
    const event = { sender: contents, senderFrame: contents.mainFrame };
    return { handlers, contents, files, streams, event };
};

describe('playback stream IPC', () => {
    it('gates every operation and assigns the owner in the host', async () => {
        const s = setup();
        for (const handle of s.handlers.values()) {
            await expect(Promise.resolve().then(() => handle({ ...s.event, senderFrame: {} }, 'test'))).rejects.toThrow('Untrusted');
            await expect(Promise.resolve().then(() => handle({ ...s.event, sender: { mainFrame: s.event.senderFrame } }, 'test'))).rejects.toThrow('Untrusted');
        }
        s.handlers.get('playback-source-stream')!(s.event, 'https://cdn.test/signed');
        expect(s.streams.create).toHaveBeenCalledWith('https://cdn.test/signed', 7);
        s.handlers.get('playback-source-stream-error')!(s.event, 'id');
        expect(s.streams.getError).toHaveBeenCalledWith('id', 7);
        await s.handlers.get('playback-source-release')!(s.event, 'id');
        expect(s.streams.release).toHaveBeenCalledWith('id', 7);
        expect(s.files.release).toHaveBeenCalledWith('id');
    });
    it('revokes on main navigation, renderer loss and destruction without accumulating listeners', () => {
        const s = setup();
        for (let i = 0; i < 3; i++) s.handlers.get('playback-source-stream')!(s.event, 'https://cdn.test/audio');
        expect(s.contents.listenerCount('did-start-navigation')).toBe(1);
        s.contents.emit('did-start-navigation', {}, 'page', true, true);
        s.contents.emit('did-start-navigation', {}, 'page', false, false);
        expect(s.streams.releaseOwner).not.toHaveBeenCalled();
        s.contents.emit('did-start-navigation', {}, 'page', false, true);
        s.contents.emit('render-process-gone');
        s.contents.emit('destroyed');
        expect(s.streams.releaseOwner).toHaveBeenCalledTimes(3);
        expect(s.streams.releaseOwner).toHaveBeenLastCalledWith(7);
    });
});
