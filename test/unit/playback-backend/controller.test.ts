import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBackendController } from '../../../src/services/playbackBackend/controller';
import { getPlaybackBackend, registerPlaybackBackend, selectedPlaybackBackend, selectPlaybackBackend } from '../../../src/services/playbackBackend/registry';
import type { PlaybackBackendDefinition, PlaybackBackendEvent, PlaybackBackendSession } from '../../../src/services/playbackBackend/types';

// Transport races and explicit selection must not turn into unintended audio output.
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
const mockBackend = () => {
    let report!: (event: PlaybackBackendEvent) => void;
    const session: PlaybackBackendSession = {
        open: vi.fn(async () => {}), play: vi.fn(async () => {}), pause: vi.fn(async () => {}),
        seek: vi.fn(async () => {}), setVolume: vi.fn(async () => {}), dispose: vi.fn(async () => {}),
    };
    const definition: PlaybackBackendDefinition = {
        name: 'Test', capabilities: { seek: true, volume: true, http: true },
        create: callback => { report = callback; return session; },
    };
    return { definition, session, report: (event: PlaybackBackendEvent) => report(event) };
};
const staged = () => {
    const release = vi.fn(async () => {});
    const prepare = vi.fn(async (url: string, sourceId: string) => ({ source: { sourceId, url }, release }));
    return { prepare, release };
};
afterEach(() => { selectPlaybackBackend(null); });

describe('backend registry', () => {
    it('does not select on registration, and never falls back after removal', () => {
        const { definition } = mockBackend();
        const off = registerPlaybackBackend('test:one', definition);
        expect(selectedPlaybackBackend()).toBeNull();
        selectPlaybackBackend('test:one');
        off();
        expect(selectedPlaybackBackend()).toBe('test:one');
        expect(getPlaybackBackend()).toBeNull();
        const newer = registerPlaybackBackend('test:one', definition);
        off();
        expect(getPlaybackBackend()?.definition).toBe(definition);
        newer();
    });
    it('rejects unknown selections and duplicates', () => {
        expect(() => selectPlaybackBackend('missing')).toThrow('not-found');
        const { definition } = mockBackend();
        const off = registerPlaybackBackend('test:two', definition);
        try { expect(() => registerPlaybackBackend('test:two', definition)).toThrow('duplicate'); }
        finally { off(); }
    });
});

describe('backend controller', () => {
    it('reports archive progress only for valid, current playing status, never a paused clock or EOF', async () => {
        const b = mockBackend(), progress = vi.fn(), markPlayed = vi.fn();
        const c = createBackendController(async (url, sourceId) => ({ source: { sourceId, url }, release: async () => {}, progress, markPlayed }));
        await c.setBackend(b.definition); await c.open('https://test/current');
        const sourceId = c.getStatus().sourceId;
        b.report({ type: 'status', status: { sourceId, state: 'paused', position: 90, duration: 100 } });
        b.report({ type: 'status', status: { sourceId: 'stale', state: 'playing', position: 90, duration: 100 } });
        b.report({ type: 'status', status: { sourceId, state: 'playing', position: NaN, duration: 100 } });
        expect(progress).not.toHaveBeenCalled();
        b.report({ type: 'status', status: { sourceId, state: 'playing', position: 80, duration: 100 } });
        expect(markPlayed).toHaveBeenCalledOnce(); expect(progress).toHaveBeenCalledExactlyOnceWith(80);
        b.report({ type: 'ended', sourceId }); expect(progress).toHaveBeenCalledOnce();
        await c.setBackend(null);
    });
    it('turns a failed host stream into an error instead of advancing the queue', async () => {
        const b = mockBackend();
        const source = staged();
        const getError = vi.fn(async () => 'SOURCE_UNREACHABLE');
        const c = createBackendController(async (url, id) => ({ ...await source.prepare(url, id), getError }));
        const events: PlaybackBackendEvent[] = [];
        c.subscribe(event => events.push(event));
        await c.setBackend(b.definition);
        await c.open('https://test/signed');
        b.report({ type: 'ended', sourceId: c.getStatus().sourceId });
        await vi.waitFor(() => expect(events.at(-1)?.type).toBe('error'));
        expect(events.some(event => event.type === 'ended')).toBe(false);
        expect(c.getStatus().state).toBe('paused');
        await c.setBackend(null);
    });
    it('does not let an asynchronous EOF check affect a newer source', async () => {
        const b = mockBackend();
        let answer!: (code: string | null) => void;
        const getError = vi.fn(() => new Promise<string | null>(resolve => { answer = resolve; }));
        const c = createBackendController(async (url, sourceId) => ({ source: { sourceId, url }, release: async () => {}, getError }));
        const events: PlaybackBackendEvent[] = [];
        c.subscribe(event => events.push(event));
        await c.setBackend(b.definition);
        await c.open('https://test/old');
        const id = c.getStatus().sourceId;
        b.report({ type: 'ended', sourceId: id });
        await c.open('https://test/new');
        answer('SOURCE_UNREACHABLE');
        await Promise.resolve();
        expect(events.some(event => event.type === 'ended' || event.type === 'error')).toBe(false);
        b.report({ type: 'ended', sourceId: id });
        expect(getError).toHaveBeenCalledTimes(1);
        await c.setBackend(null);
    });
    it('retains failed cleanup and never creates another output or releases its source until disposal succeeds', async () => {
        const old = mockBackend();
        const next = mockBackend();
        const create = vi.spyOn(next.definition, 'create');
        const source = staged();
        const c = createBackendController(source.prepare);
        await c.setBackend(old.definition);
        await c.open('https://test/playing');
        vi.mocked(old.session.dispose).mockRejectedValueOnce(new Error('output still active'));
        await expect(c.setBackend(next.definition)).rejects.toThrow('output still active');
        expect(create).not.toHaveBeenCalled();
        expect(source.release).not.toHaveBeenCalled();
        await c.setBackend(next.definition);
        expect(old.session.dispose).toHaveBeenCalledTimes(2);
        expect(source.release).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledOnce();
        await c.setBackend(null);
    });
    it('awaits backend creation when selection and open happen together', async () => {
        const b = mockBackend();
        const s = staged();
        const c = createBackendController(s.prepare);
        const switching = c.setBackend(b.definition);
        const loading = c.open('https://test/a');
        await Promise.all([switching, loading]);
        expect(b.session.open).toHaveBeenCalledOnce();
        await c.setBackend(null);
        expect(s.release).toHaveBeenCalledOnce();
    });
    it('pause cancels play intent while open is pending', async () => {
        const b = mockBackend();
        const gate = deferred();
        vi.mocked(b.session.open).mockImplementation(() => gate.promise);
        const c = createBackendController(staged().prepare);
        await c.setBackend(b.definition);
        const loading = c.open('https://test/a');
        const playing = c.play();
        const paused = c.pause();
        gate.resolve();
        await Promise.all([loading, playing, paused]);
        expect(b.session.play).not.toHaveBeenCalled();
        await c.setBackend(null);
    });
    it('a pause arriving during play lands after it', async () => {
        const b = mockBackend();
        const gate = deferred();
        vi.mocked(b.session.play).mockImplementation(() => gate.promise);
        const c = createBackendController(staged().prepare);
        await c.setBackend(b.definition);
        await c.open('https://test/a');
        const playing = c.play();
        await Promise.resolve();
        await c.pause();
        gate.resolve();
        await playing;
        expect(b.session.pause).toHaveBeenCalledTimes(3);
        await c.setBackend(null);
    });
    it('ignores old source events and releases replaced copies', async () => {
        const b = mockBackend();
        const s = staged();
        const c = createBackendController(s.prepare);
        await c.setBackend(b.definition);
        await c.open('https://test/a');
        const old = c.getStatus().sourceId;
        await c.open('https://test/b');
        b.report({ type: 'status', status: { sourceId: old, state: 'playing', position: 8, duration: 10 } });
        expect(c.getPosition()).toBe(0);
        expect(s.release).toHaveBeenCalledOnce();
        const current = c.getStatus().sourceId;
        b.report({ type: 'status', status: { sourceId: current, state: 'paused', position: 3, duration: 10 } });
        expect(c.getPosition()).toBe(3);
        await c.setBackend(null);
        b.report({ type: 'ended', sourceId: current });
        expect(c.getStatus().state).toBe('stopped');
        expect(s.release).toHaveBeenCalledTimes(2);
    });
    it('releases a superseded source being staged and never opens it', async () => {
        const b = mockBackend();
        const gate = deferred();
        const s = staged();
        s.prepare.mockImplementationOnce(async (url, sourceId) => { await gate.promise; return { source: { url, sourceId }, release: s.release }; });
        const c = createBackendController(s.prepare);
        await c.setBackend(b.definition);
        const first = c.open('https://test/a');
        await vi.waitFor(() => expect(s.prepare).toHaveBeenCalledOnce());
        const second = c.open('https://test/b');
        gate.resolve();
        await Promise.all([first, second]);
        expect(b.session.open).toHaveBeenCalledTimes(1);
        expect(s.release).toHaveBeenCalledOnce();
        await c.setBackend(null);
    });
    it('can retry the same URL after failure, with volume and no fallback', async () => {
        const b = mockBackend();
        vi.mocked(b.session.open).mockRejectedValueOnce(new Error('exclusive-refused'));
        const s = staged();
        const c = createBackendController(s.prepare);
        await c.setBackend(b.definition);
        await expect(c.open('https://test/a')).rejects.toThrow('exclusive-refused');
        expect(s.release).toHaveBeenCalledOnce();
        await c.setVolume(0.2);
        await c.open('https://test/a');
        expect(b.session.setVolume).toHaveBeenLastCalledWith(0.2);
        await c.setBackend(null);
        await expect(c.open('https://test/a')).rejects.toThrow('unavailable');
    });
    it('stopping clears the source/device but preserves an available backend for the next track', async () => {
        const b = mockBackend();
        const s = staged();
        const c = createBackendController(s.prepare);
        await c.setBackend(b.definition);
        await c.open('https://test/a');
        await c.stop();
        expect(c.getStatus().state).toBe('stopped');
        expect(s.release).toHaveBeenCalledOnce();
        expect(b.session.dispose).toHaveBeenCalledOnce();
        await c.open('https://test/b');
        expect(b.session.open).toHaveBeenCalledTimes(2);
        await c.setBackend(null);
    });
    it('a retired asynchronous play cannot report success to the host', async () => {
        const b = mockBackend();
        const gate = deferred();
        vi.mocked(b.session.play).mockImplementation(() => gate.promise);
        const c = createBackendController(staged().prepare);
        await c.setBackend(b.definition);
        await c.open('https://test/a');
        const starting = c.play();
        await Promise.resolve();
        await c.setBackend(null);
        gate.resolve();
        expect(await starting).toBe(false);
    });
});
