import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import activate from '../../../extensions/hqplayer/client.mjs';

// The real mod client/lease communicate through memory-only RPC; no player or network is used.
const require = createRequire(import.meta.url);
const { createRendererLease } = require('../../../extensions/hqplayer/rendererLease.cjs');
let lease: { observe: (event: unknown) => void; dispose: () => Promise<void> };
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(async () => { await lease?.dispose().catch(() => {}); vi.useRealTimers(); });

const setup = async () => {
    const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
    const listeners = new Set<(event: any) => void>();
    const send = (_name: string, event: any) => listeners.forEach(listener => listener(event));
    const engine = {
        configure: vi.fn(async () => {}),
        open: vi.fn(async () => {}),
        play: vi.fn(async () => {}), pause: vi.fn(async () => {}),
        seek: vi.fn(async () => {}), setVolume: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
    };
    const log = { warn: vi.fn(), error: vi.fn() };
    lease = createRendererLease({ rpc: { handle: (name: string, callback: any) => handlers.set(name, callback), send }, log }, engine);
    let backend: any;
    await activate({
        env: { context: 'main', locale: 'en' },
        experimental: { 'playback.backends': { register: (value: any) => { backend = value; return { unregister() {} }; } } },
        rpc: {
            call: (name: string, ...args: any[]) => name === 'hqplayer.ensureRunning' ? Promise.resolve() : handlers.get(name)!(...args),
            on: (_name: string, listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        },
        registries: {
            settingsSections: { register: () => ({ settings: { get: () => ({}), onChange() {} } }) },
            commands: { register() {} },
        },
        every() {}, onDispose() {}, playback: { pause() {} }, ui: { toast() {} }, log,
    });
    const report = vi.fn();
    const session = backend.create(report);
    await session.open({ sourceId: 'one', filePath: 'C:\\isolated.audio' });
    await session.play();
    const status = { type: 'status', status: { sourceId: 'one', state: 'playing', position: 83, duration: 180 } };
    lease.observe(status);
    send('hqplayer.event', status);
    return { handlers, engine, report, session, send, log };
};

describe('HQPlayer renderer lease', () => {
    it('notifies the host, ignores late playing status, and does not resume on heartbeats', async () => {
        const s = await setup();
        await vi.advanceTimersByTimeAsync(16000);
        expect(s.engine.dispose).toHaveBeenCalledOnce();
        expect(s.report).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', sourceId: 'one' }));
        expect(s.report).toHaveBeenCalledWith({ type: 'status', status: { sourceId: 'one', state: 'paused', position: 83, duration: 180 } });
        const count = s.report.mock.calls.length;
        s.send('hqplayer.event', { type: 'status', status: { sourceId: 'one', state: 'playing', position: 84, duration: 180 } });
        await s.handlers.get('hqplayer.heartbeat')!();
        expect(s.report).toHaveBeenCalledTimes(count);
        expect(s.engine.play).toHaveBeenCalledOnce();
        expect(s.engine.open).toHaveBeenCalledOnce();
    });
    it('reloads only on explicit Play and restores the last confirmed position', async () => {
        const s = await setup();
        await vi.advanceTimersByTimeAsync(16000);
        await s.session.play();
        expect(s.engine.configure).toHaveBeenCalledTimes(2);
        expect(s.engine.open).toHaveBeenCalledTimes(2);
        expect(s.engine.seek).toHaveBeenLastCalledWith(83);
        expect(s.engine.play).toHaveBeenCalledTimes(2);
        expect(s.engine.dispose.mock.invocationCallOrder[0]).toBeLessThan(s.engine.open.mock.invocationCallOrder[1]);
    });
    it('waits for cleanup before explicit replay can open another source', async () => {
        const s = await setup();
        let done!: () => void;
        s.engine.dispose.mockReturnValueOnce(new Promise<void>(resolve => { done = resolve; }));
        await vi.advanceTimersByTimeAsync(16000);
        const playing = s.session.play();
        await Promise.resolve();
        expect(s.engine.open).toHaveBeenCalledOnce();
        done();
        await playing;
        expect(s.engine.open).toHaveBeenCalledTimes(2);
    });
    it('does not reopen output after failed cleanup', async () => {
        const s = await setup();
        s.engine.dispose.mockRejectedValueOnce(new Error('output state unknown'));
        await vi.advanceTimersByTimeAsync(16000);
        await expect(s.session.play()).rejects.toThrow('output state unknown');
        expect(s.engine.open).toHaveBeenCalledOnce();
        expect(s.engine.play).toHaveBeenCalledOnce();
        expect(s.log.error).toHaveBeenCalled();
    });
    it('keeps pause and seek silent after expiry, and uses the requested seek on Play', async () => {
        const s = await setup();
        await vi.advanceTimersByTimeAsync(16000);
        await s.session.pause();
        await s.session.seek(12);
        expect(s.engine.pause).not.toHaveBeenCalled();
        expect(s.engine.seek).not.toHaveBeenCalled();
        expect(s.engine.open).toHaveBeenCalledOnce();
        await s.session.play();
        expect(s.engine.seek).toHaveBeenLastCalledWith(12);
    });
    it('does not expire an active heartbeat or a disposed session', async () => {
        const s = await setup();
        for (let i = 0; i < 5; i++) {
            await vi.advanceTimersByTimeAsync(10000);
            await s.handlers.get('hqplayer.heartbeat')!();
        }
        expect(s.engine.dispose).not.toHaveBeenCalled();
        await s.session.dispose();
        await vi.advanceTimersByTimeAsync(20000);
        expect(s.engine.dispose).toHaveBeenCalledOnce();
    });
});
