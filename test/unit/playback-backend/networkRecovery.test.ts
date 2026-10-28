import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackendController } from '../../../src/services/playbackBackend/controller';
import type { PlaybackBackendDefinition, PlaybackBackendEvent } from '../../../src/services/playbackBackend/types';

// Outages freeze the clock; only the latest explicit transport intent may restore audio.
const setup = async () => {
    let report!: (event: PlaybackBackendEvent) => void;
    let failure: { code: string; retryable: boolean } | null = null;
    const probe = vi.fn(async () => { failure = null; return { ready: true, retryable: true }; });
    const cancelProbe = vi.fn(async () => {});
    const session = { open: vi.fn(async () => {}), pause: vi.fn(async () => {}), play: vi.fn(async () => {}),
        seek: vi.fn(async (_seconds: number) => {}), setVolume: vi.fn(async () => {}), dispose: vi.fn(async () => {}) };
    const definition: PlaybackBackendDefinition = { name: 'Fake', capabilities: { seek: true, volume: true, http: true },
        create: callback => { report = callback; return session; } };
    const release = vi.fn(async () => {});
    const c = createBackendController(async (url, sourceId) => ({ source: { url, sourceId }, release, probe, cancelProbe,
        getError: async () => failure?.code ?? null,
        getTransfer: async () => ({ receivedBytes: 8192, bytesPerSecond: 4096, failure }) }));
    const events: PlaybackBackendEvent[] = [];
    c.subscribe(event => events.push(event));
    await c.setBackend(definition); await c.open('https://synthetic.test/audio'); await c.play();
    const id = c.getStatus().sourceId;
    report({ type: 'status', status: { sourceId: id, state: 'playing', position: 42, duration: 180 } });
    const interrupt = (retryable = true, type: 'ended' | 'error' = 'ended') => {
        failure = { code: 'SOURCE_UNREACHABLE', retryable };
        report({ type: 'status', status: { sourceId: id, state: 'stopped', position: 0, duration: 0 } });
        report(type === 'ended' ? { type, sourceId: id } : { type, sourceId: id, message: 'decoder read failed' });
    };
    return { c, session, definition, report: (event: PlaybackBackendEvent) => report(event), id, probe, cancelProbe, interrupt, events, release };
};
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const controllers: Awaited<ReturnType<typeof setup>>[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
    for (const s of controllers.splice(0)) await s.c.setBackend(null);
    vi.useRealTimers();
});
const tracked = async () => { const s = await setup(); controllers.push(s); return s; };

describe('HTTP backend network recovery', () => {
    it('waits with a frozen clock and resumes the same lease and previous position without advancing', async () => {
        const s = await tracked();
        await s.c.setVolume(0.2);
        s.interrupt(); await flush();
        expect(s.c.getStatus()).toMatchObject({ state: 'loading', position: 42, duration: 180 });
        expect(s.c.getTransferStatus()).toMatchObject({ buffering: true, bytesPerSecond: 4096 });
        s.report({ type: 'status', status: { sourceId: s.id, state: 'playing', position: 0, duration: 180 } });
        expect(s.c.getPosition()).toBe(42);
        await vi.advanceTimersByTimeAsync(1000);
        expect(s.session.open).toHaveBeenCalledTimes(2);
        expect(s.session.seek).toHaveBeenLastCalledWith(42);
        expect(s.session.setVolume).toHaveBeenLastCalledWith(0.2);
        expect(s.session.play).toHaveBeenCalledTimes(2);
        expect(s.c.getStatus().state).toBe('playing');
        expect(s.c.getStatus().sourceId).not.toBe(s.id);
        s.report({ type: 'status', status: { sourceId: s.id, state: 'playing', position: 1, duration: 180 } });
        expect(s.c.getStatus().position).toBe(42);
        expect(s.events.filter(event => event.type !== 'status')).toEqual([]);
    });
    it('keeps waiting through failed network probes with bounded backoff', async () => {
        const s = await tracked();
        s.probe.mockResolvedValue({ ready: false, retryable: true });
        s.interrupt(); await flush();
        await vi.advanceTimersByTimeAsync(31000);
        expect(s.probe).toHaveBeenCalledTimes(5);
        expect(s.session.open).toHaveBeenCalledOnce();
        expect(s.c.isWaitingForNetwork()).toBe(true);
        expect(s.c.getPosition()).toBe(42);
    });
    it('pause cancels waiting and play explicitly resumes it', async () => {
        const s = await tracked();
        s.interrupt(); await flush(); await s.c.pause();
        await vi.advanceTimersByTimeAsync(12000);
        expect(s.probe).not.toHaveBeenCalled();
        expect(s.c.getTransferStatus()?.buffering).toBe(false);
        expect(s.c.getStatus().state).toBe('paused');
        await s.c.seek(73); await s.c.play();
        await vi.advanceTimersByTimeAsync(1000);
        expect(s.session.seek).toHaveBeenLastCalledWith(73);
        expect(s.session.play).toHaveBeenCalledTimes(2);
    });
    it.each(['pause', 'track', 'backend'] as const)('cancels an in-flight probe on %s without late playback', async action => {
        const s = await tracked();
        let finish!: (value: { ready: boolean; retryable: boolean }) => void;
        s.probe.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        s.interrupt(); await flush(); await vi.advanceTimersByTimeAsync(1000);
        if (action === 'pause') await s.c.pause();
        if (action === 'track') await s.c.open('https://synthetic.test/new');
        if (action === 'backend') await s.c.setBackend(null);
        const opens = s.session.open.mock.calls.length;
        finish({ ready: true, retryable: true }); await flush();
        expect(s.session.open).toHaveBeenCalledTimes(opens);
        expect(s.session.play).toHaveBeenCalledOnce();
    });
    it('a pause during restore prevents the pending seek and play', async () => {
        const s = await tracked();
        let finish!: () => void;
        s.session.open.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
        s.interrupt(); await flush(); await vi.advanceTimersByTimeAsync(1000);
        const paused = s.c.pause(); finish(); await paused; await flush();
        expect(s.session.seek).not.toHaveBeenCalled();
        expect(s.session.play).toHaveBeenCalledOnce();
    });
    it('keeps non-network failures and restore device errors terminal', async () => {
        const s = await tracked();
        s.interrupt(false, 'error'); await flush();
        await vi.advanceTimersByTimeAsync(10000);
        expect(s.probe).not.toHaveBeenCalled();
        expect(s.events.at(-1)?.type).toBe('error');
        await s.c.play();
        s.session.open.mockRejectedValueOnce(new Error('device refused'));
        s.interrupt(); await flush(); await vi.advanceTimersByTimeAsync(1000);
        expect(s.events.at(-1)).toMatchObject({ type: 'error', message: 'device refused' });
        expect(s.c.isWaitingForNetwork()).toBe(false);
    });
    it('can wait after the first open fails due to the audio network', async () => {
        const s = await tracked();
        s.session.open.mockImplementationOnce(async () => { s.interrupt(); throw new Error('read failed'); });
        await s.c.open('https://synthetic.test/second'); await s.c.play(); await flush();
        expect(s.c.isWaitingForNetwork()).toBe(true);
        await vi.advanceTimersByTimeAsync(1000);
        expect(s.c.getStatus().state).toBe('playing');
    });
    it('does not retry after a fatal probe response or for a backend without seek', async () => {
        const s = await tracked();
        s.probe.mockResolvedValueOnce({ ready: false, retryable: false });
        s.interrupt(); await flush(); await vi.advanceTimersByTimeAsync(1000);
        expect(s.events.at(-1)?.type).toBe('error');
        expect(s.c.isWaitingForNetwork()).toBe(false);
        s.definition.capabilities.seek = false;
        await s.c.play(); s.interrupt(); await flush(); await vi.advanceTimersByTimeAsync(10000);
        expect(s.probe).toHaveBeenCalledOnce();
        expect(s.session.open).toHaveBeenCalledOnce();
    });
});
