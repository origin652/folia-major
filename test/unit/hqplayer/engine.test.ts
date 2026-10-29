import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDspFixture } from './dspFixture';

// Device-independent engine invariants: no takeover, unexpected volume, fallback or orphaned owned list.
const require = createRequire(import.meta.url);
const { createHqpEngine } = require('../../../extensions/hqplayer/engine.cjs');
const { parseResponse } = require('../../../extensions/hqplayer/protocol.cjs');
const engines: Array<{ dispose: () => Promise<void> }> = [];
afterEach(async () => {
    await Promise.all(engines.splice(0).map(engine => engine.dispose()));
    vi.useRealTimers();
});
const setup = (overrides = {}, options = {}) => {
    const state = { state: 0, position: 0, length: 10, volume: -20, tracks_total: 0, enabled: 1, repeat: 0, random: 0, ...overrides };
    const connection = {
        closed: false,
        close: vi.fn(),
        request: vi.fn(async (name: string, attrs: Record<string, string | number> = {}) => {
            if (name === 'GetInfo') return parseResponse('<GetInfo product="Signalyst HQPlayer Desktop"/>', name);
            if (name === 'VolumeRange') return parseResponse(`<VolumeRange min="-120" max="0" enabled="${state.enabled}"/>`, name);
            if (name === 'Status') return parseResponse(`<Status ${Object.entries(state).map(([k,v]) => `${k}="${v}"`).join(' ')}/>`, name);
            if (name === 'Stop') { state.state = 0; state.position = 0; state.tracks_total = 0; }
            if (name === 'Play' && state.tracks_total > 0) state.state = 2;
            if (name === 'Pause') state.state = 1;
            if (name === 'PlayNextURI') { state.tracks_total = 1; state.state = 2; state.position = 0; }
            if (name === 'Volume') state.volume = Number(attrs.value);
            if (name === 'Seek') state.position = Number(attrs.position);
            if (name === 'SetRepeat') state.repeat = Number(attrs.value);
            if (name === 'SetRandom') state.random = Number(attrs.value);
            return parseResponse(`<${name} result="OK"/>`, name);
        }),
    };
    const release = vi.fn(async () => {});
    const prepare = vi.fn(async () => ({ uri: 'C:\\isolated\\audio.wav', release }));
    const report = vi.fn();
    const engine = createHqpEngine(report, '/isolated', { connect: () => connection, prepare,
        ensureRunning: vi.fn(async () => {}), pollMs: 60000, ...options });
    engines.push(engine);
    return { engine, connection, state, release, prepare, report };
};
const source = { sourceId: 'one', filePath: '/host/source.audio' };

describe('HQPlayer engine', () => {
    it('refuses an unsafe HTTP resume before starting a new URI', async () => {
        const assertSeekable = vi.fn(async () => { throw new Error('Unverified HTTP seek'); });
        const s = setup({}, { prepare: async () => ({ uri: 'http://127.0.0.1/isolated', release: async () => {}, assertSeekable }) });
        await s.engine.open(source); await s.engine.seek(4);
        s.connection.request.mockClear();
        await expect(s.engine.play()).rejects.toThrow('Unverified HTTP seek');
        expect(s.connection.request.mock.calls.some(([name]) => ['PlayNextURI', 'Play', 'Seek'].includes(name))).toBe(false);
        expect(s.state.state).toBe(0);
    });
    it('pauses its own running output if a direct HTTP seek becomes unsafe', async () => {
        const s = setup({}, { prepare: async () => ({ uri: 'http://127.0.0.1/isolated', release: async () => {},
            assertSeekable: async () => { throw new Error('Unverified HTTP seek'); } }) });
        await s.engine.open(source); await s.engine.play();
        await expect(s.engine.seek(4)).rejects.toThrow('Unverified HTTP seek');
        expect(s.state.state).toBe(1);
        expect(s.connection.request.mock.calls.some(([name]) => name === 'Seek')).toBe(false);
    });
    it('reads DSP without starting or stopping output and reuses the validated active connection', async () => {
        const s = setup();
        addDspFixture(s.connection);
        await s.engine.open(source);
        s.connection.request.mockClear();
        const snapshot = await s.engine.readDsp({});
        expect(snapshot.selection.mode).toBe(1);
        expect(s.connection.close).not.toHaveBeenCalled();
        expect(s.connection.request.mock.calls.some(([name]) => ['GetInfo', 'Stop', 'Play', 'PlayNextURI'].includes(name))).toBe(false);
    });
    it('does not stop active playback for an unchanged DSP draft or auto-start a read-only query', async () => {
        const ensureRunning = vi.fn(async () => {});
        const s = setup({}, { ensureRunning });
        addDspFixture(s.connection);
        await s.engine.readDsp({});
        expect(ensureRunning).not.toHaveBeenCalled();
        expect(s.connection.close).toHaveBeenCalledOnce();
        await s.engine.open(source);
        await s.engine.play();
        const snapshot = await s.engine.readDsp({});
        s.connection.request.mockClear();
        await s.engine.applyDsp({}, snapshot.revision, { filter: 40, filter1x: 37, shaper: 7, rate: 8 });
        expect(s.state.state).toBe(2);
        expect(s.connection.request.mock.calls.some(([name]) => name === 'Stop' || name.startsWith('Set'))).toBe(false);
    });
    it('stops owned playback for an explicit DSP apply and resumes at the saved position only on Play', async () => {
        const s = setup();
        addDspFixture(s.connection);
        await s.engine.open(source);
        await s.engine.play();
        await s.engine.seek(4);
        const snapshot = await s.engine.readDsp({});
        s.connection.request.mockClear();
        await s.engine.applyDsp({}, snapshot.revision, { filter: 2 });
        expect(s.state.state).toBe(0);
        expect(s.connection.request).toHaveBeenCalledWith('Stop', undefined);
        expect(s.connection.request).toHaveBeenCalledWith('SetFilter', { value: 2, value1x: 37 });
        expect(s.connection.request.mock.calls.some(([name]) => ['Play', 'PlayNextURI'].includes(name))).toBe(false);
        expect(s.report).toHaveBeenLastCalledWith({ type: 'status', status: { sourceId: 'one', state: 'paused', position: 4, duration: 10 } });
        await s.engine.play();
        expect(s.state.position).toBe(4);
        expect(s.connection.request).toHaveBeenCalledWith('Seek', { position: 4 });
    });
    it('refuses stale DSP or an external transport without stopping it or failing the owned session', async () => {
        const s = setup();
        const dsp = addDspFixture(s.connection);
        await s.engine.open(source);
        await s.engine.play();
        const snapshot = await s.engine.readDsp({});
        s.connection.request.mockClear();
        dsp.state.rate = 0;
        await expect(s.engine.applyDsp({}, snapshot.revision, { filter: 2 })).rejects.toThrow('refresh');
        expect(s.state.state).toBe(2);
        expect(s.connection.request.mock.calls.some(([name]) => name === 'Stop' || name.startsWith('Set'))).toBe(false);
        expect(s.report.mock.calls.some(([event]) => event.type === 'error')).toBe(false);
        await s.engine.dispose();
        const external = setup({ state: 2, tracks_total: 1 });
        addDspFixture(external.connection);
        const live = await external.engine.readDsp({});
        await expect(external.engine.applyDsp({}, live.revision, { rate: 0 })).rejects.toThrow('external');
        expect(external.connection.request.mock.calls.some(([name]) => name === 'Stop' || name.startsWith('Set'))).toBe(false);
    });
    it('ensures Desktop is ready before any transport command and leaves output untouched on launch failure', async () => {
        const ensureRunning = vi.fn(async () => {});
        const s = setup({}, { ensureRunning });
        await s.engine.configure({ autoStart: false, executable: 'F:\\HQPlayer6Desktop.exe' });
        ensureRunning.mockRejectedValueOnce(new Error('startup failed'));
        await expect(s.engine.open(source)).rejects.toThrow('startup failed');
        expect(s.connection.request).not.toHaveBeenCalled();
        expect(ensureRunning).toHaveBeenCalledWith(expect.objectContaining({ autoStart: false, executable: 'F:\\HQPlayer6Desktop.exe' }));
        await s.engine.open(source);
        expect(ensureRunning).toHaveBeenCalledTimes(2);
        expect(s.connection.request).toHaveBeenCalledWith('GetInfo', undefined);
    });
    it('prepares without starting audio, then uses native-path PlayNextURI and Play only for resume', async () => {
        const { engine, connection } = setup();
        await engine.open(source);
        expect(connection.request.mock.calls.some(([name]) => name === 'PlayNextURI')).toBe(false);
        await engine.play();
        expect(connection.request).toHaveBeenCalledWith('PlayNextURI', { value: 'C:\\isolated\\audio.wav', freewheel: 0 });
        await engine.pause();
        await engine.play();
        expect(connection.request).toHaveBeenCalledWith('Play', { last: 0 });
        expect(connection.request.mock.calls.filter(([name]) => name === 'PlayNextURI')).toHaveLength(1);
        await engine.dispose();
        expect(connection.request.mock.calls.some(([name]) => ['PlaylistAdd', 'SetTransport', 'PlaylistClear'].includes(name))).toBe(false);
    });
    it('defers a prepared seek until PlayNextURI has loaded the file', async () => {
        const { engine, connection, state } = setup();
        await engine.open(source);
        await engine.seek(4.9);
        expect(connection.request.mock.calls.some(([name]) => name === 'Seek')).toBe(false);
        await engine.play();
        expect(state.position).toBe(4);
        const names = connection.request.mock.calls.map(([name]) => name);
        expect(names.indexOf('Seek')).toBeGreaterThan(names.indexOf('PlayNextURI'));
    });
    it('confirms a deferred resume against the native clock, retrying an acknowledged but ignored seek while paused', async () => {
        vi.useFakeTimers();
        const { engine, connection, state } = setup({ length: 180 });
        const request = connection.request.getMockImplementation()!;
        let seeks = 0;
        connection.request.mockImplementation(async (name, attrs) => {
            if (name === 'Seek' && (++seeks === 1 || state.state !== 1)) return parseResponse('<Seek result="OK"/>', name);
            return request(name, attrs);
        });
        await engine.open(source); await engine.seek(42);
        const playing = engine.play();
        await vi.advanceTimersByTimeAsync(2500); await playing;
        expect(state.position).toBe(42);
        expect(state.state).toBe(2);
        expect(seeks).toBe(2);
        const names = connection.request.mock.calls.map(([name]) => name);
        expect(names.indexOf('Pause')).toBeLessThan(names.indexOf('Seek'));
    });
    it('waits for URI duration before seeking and leaves an unseekable stream paused rather than restarting at zero', async () => {
        vi.useFakeTimers();
        const s = setup({ length: 180 });
        const request = s.connection.request.getMockImplementation()!;
        let metadataPending = 0, acceptSeek = false;
        s.connection.request.mockImplementation(async (name, attrs) => {
            if (name === 'PlayNextURI') { await request(name, attrs); s.state.length = 0; metadataPending = 5; }
            if (name === 'Status' && metadataPending > 0 && --metadataPending === 0) s.state.length = 180;
            if (name === 'Seek') {
                expect(s.state.length).toBe(180);
                if (!acceptSeek) return parseResponse('<Seek result="OK"/>', name);
            }
            return request(name, attrs);
        });
        await s.engine.open(source); await s.engine.seek(42);
        const failed = expect(s.engine.play()).rejects.toThrow('did not confirm the resume position');
        await vi.advanceTimersByTimeAsync(9000); await failed;
        expect(s.state.state).toBe(1); expect(s.state.position).toBe(0);
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'Play')).toHaveLength(0);
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'Seek')).toHaveLength(3);
        acceptSeek = true;
        await s.engine.play();
        expect(s.state.position).toBe(42); expect(s.state.state).toBe(2);
    });
    it('waits for the URI track count to settle instead of mistaking loading for a foreign controller', async () => {
        vi.useFakeTimers();
        const { engine, connection, state, report } = setup();
        const request = connection.request.getMockImplementation()!;
        let settling = 0;
        connection.request.mockImplementation(async (name, attrs) => {
            if (name === 'PlayNextURI') {
                const result = await request(name, attrs);
                state.state = 3;
                state.tracks_total = 0;
                settling = 2;
                return result;
            }
            if (name === 'Status' && settling > 0 && --settling === 0) {
                state.state = 2;
                state.tracks_total = 1;
            }
            return request(name, attrs);
        });
        await engine.open(source);
        const playing = engine.play();
        await vi.advanceTimersByTimeAsync(500);
        await playing;
        expect(report.mock.calls.some(([event]) => event.type === 'error')).toBe(false);
        expect(state.state).toBe(2);
    });
    it('does not replace playback started by another controller after preparation', async () => {
        const { engine, connection, state } = setup();
        await engine.open(source);
        state.state = 2;
        state.tracks_total = 1;
        await expect(engine.play()).rejects.toThrow('outside Folia');
        expect(connection.request.mock.calls.some(([name]) => name === 'PlayNextURI')).toBe(false);
    });
    it('waits through STOPREQ with an empty URI transport when changing tracks', async () => {
        vi.useFakeTimers();
        const s = setup();
        await s.engine.open(source);
        await s.engine.play();
        const request = s.connection.request.getMockImplementation()!;
        let settling = 0;
        s.connection.request.mockImplementation(async (name, attrs) => {
            if (name === 'Stop') {
                s.state.state = 3;
                s.state.tracks_total = 0;
                settling = 2;
                return parseResponse('<Stop result="OK"/>', name);
            }
            if (name === 'Status' && settling > 0 && --settling === 0) s.state.state = 0;
            return request(name, attrs);
        });
        try {
            const changing = s.engine.open({ ...source, sourceId: 'two' }).then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(500);
            expect(await changing).toBeNull();
            await s.engine.play();
            expect(s.report.mock.calls.some(([event]) => event.type === 'error')).toBe(false);
        } finally { s.connection.request.mockImplementation(request); }
    });
    it('preserves the last playing clock through an empty STOPREQ before EOF', async () => {
        vi.useFakeTimers();
        const s = setup({}, { pollMs: 50 });
        await s.engine.open(source);
        await s.engine.play();
        s.state.position = 9.5;
        await vi.advanceTimersByTimeAsync(50);
        Object.assign(s.state, { state: 3, position: 0, length: 0, tracks_total: 0 });
        await vi.advanceTimersByTimeAsync(50);
        s.state.state = 0;
        await vi.advanceTimersByTimeAsync(50);
        expect(s.report.mock.calls.some(([event]) => event.type === 'error')).toBe(false);
        expect(s.report.mock.calls.filter(([event]) => event.type === 'ended')).toHaveLength(1);
    });
    it('confirms an asynchronous pause without sending the pause toggle twice', async () => {
        vi.useFakeTimers();
        const s = setup();
        await s.engine.open(source);
        await s.engine.play();
        const request = s.connection.request.getMockImplementation()!;
        let settling = 0;
        s.connection.request.mockImplementation(async (name, attrs) => {
            if (name === 'Pause') { settling = 2; return parseResponse('<Pause result="OK"/>', name); }
            if (name === 'Status' && settling > 0 && --settling === 0) s.state.state = 1;
            return request(name, attrs);
        });
        try {
            const pausing = s.engine.pause().then(() => null, (error: unknown) => error);
            await vi.advanceTimersByTimeAsync(500);
            expect(await pausing).toBeNull();
            expect(s.state.state).toBe(1);
            expect(s.connection.request.mock.calls.filter(([name]) => name === 'Pause')).toHaveLength(1);
        } finally { s.connection.request.mockImplementation(request); }
    });
    it('reuses the verified connection across tracks instead of probing a second connection each time', async () => {
        const ensureRunning = vi.fn(async () => {});
        const s = setup({}, { ensureRunning });
        await s.engine.open(source);
        await s.engine.play();
        await s.engine.open({ ...source, sourceId: 'two' });
        await s.engine.play();
        expect(ensureRunning).toHaveBeenCalledOnce();
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'GetInfo')).toHaveLength(1);
    });
    it('bounds a stuck STOPREQ instead of silently waiting forever', async () => {
        vi.useFakeTimers();
        const s = setup({}, { pollMs: 50 });
        await s.engine.open(source);
        await s.engine.play();
        Object.assign(s.state, { state: 3, position: 0, length: 0, tracks_total: 0 });
        await vi.advanceTimersByTimeAsync(10200);
        expect(s.report.mock.calls.filter(([event]) => event.type === 'error')).toHaveLength(1);
        expect(s.report).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('still stopping') }));
        expect(s.report.mock.calls.some(([event]) => event.type === 'ended')).toBe(false);
    });
    it('still rejects a different non-empty track during STOPREQ without stopping it', async () => {
        vi.useFakeTimers();
        const s = setup({ track_id: 'ours' }, { pollMs: 50 });
        await s.engine.open(source);
        await s.engine.play();
        const stops = s.connection.request.mock.calls.filter(([name]) => name === 'Stop').length;
        Object.assign(s.state, { state: 3, tracks_total: 1, track_id: 'foreign' });
        await vi.advanceTimersByTimeAsync(50);
        expect(s.report).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining('outside Folia') }));
        await s.engine.dispose();
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'Stop')).toHaveLength(stops);
    });
    it('does not take over an existing playlist by default', async () => {
        const { engine, connection, prepare } = setup({ tracks_total: 3 });
        await expect(engine.open(source)).rejects.toThrow('already has');
        expect(prepare).not.toHaveBeenCalled();
        expect(connection.request.mock.calls.some(([name]) => name === 'Stop')).toBe(false);
    });
    it('refuses fixed volume before touching the playlist', async () => {
        const { engine, connection } = setup({ enabled: 0 });
        await expect(engine.open(source)).rejects.toThrow('fixed');
        expect(connection.request.mock.calls.some(([name]) => ['PlayNextURI', 'Stop', 'Volume'].includes(name))).toBe(false);
    });
    it('caps host volume at the pre-existing HQPlayer level and preserves it across tracks', async () => {
        const { engine, state, release } = setup();
        await engine.open(source);
        await engine.play();
        await engine.setVolume(0.5);
        expect(state.volume).toBeCloseTo(-26.0206);
        await engine.open({ ...source, sourceId: 'two' });
        expect(state.volume).toBeCloseTo(-26.0206);
        expect(release).not.toHaveBeenCalled();
        await engine.play();
        expect(release).toHaveBeenCalledOnce();
        expect(state.state).toBe(2);
        await engine.seek(3.9);
        expect(state.position).toBe(3);
        await engine.dispose();
        expect(state.tracks_total).toBe(0);
        expect(release).toHaveBeenCalledTimes(2);
    });
    it('keeps a stopped Windows-locked source for a later cleanup instead of failing disposal', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const { engine, release } = setup();
            await engine.open(source);
            await engine.play();
            release.mockRejectedValueOnce(Object.assign(new Error('decoder handle is open'), { code: 'EBUSY' }));
            await engine.dispose();
            expect(warning).toHaveBeenCalledOnce();
            await engine.configure({});
            expect(release).toHaveBeenCalledTimes(2);
        } finally { warning.mockRestore(); }
    });
    it('uses pause for actual silence and does not resume on unmute', async () => {
        const { engine, state, report } = setup();
        await engine.open(source);
        await engine.play();
        await engine.setVolume(0);
        expect(state.state).toBe(1);
        await expect(engine.play()).rejects.toThrow('muted');
        await engine.setVolume(0.5);
        expect(state.state).toBe(1);
        expect(report.mock.calls.some(([event]) => event.status?.output)).toBe(false);
    });
    it('requires explicit takeover and restores the original repeat/random flags', async () => {
        const { engine, state } = setup({ tracks_total: 4, state: 1, repeat: 2, random: 1 });
        await engine.configure({ takeOver: true });
        await engine.open(source);
        await engine.play();
        expect(state.repeat).toBe(0);
        expect(state.random).toBe(0);
        await engine.dispose();
        expect(state.repeat).toBe(2);
        expect(state.random).toBe(1);
    });
    it('leaves another controller\'s replacement playlist alone during disposal', async () => {
        const { engine, state, connection } = setup();
        await engine.open(source);
        await engine.play();
        const before = connection.request.mock.calls.filter(([name]) => name === 'Stop').length;
        state.tracks_total = 5;
        await engine.dispose();
        expect(state.tracks_total).toBe(5);
        expect(connection.request.mock.calls.filter(([name]) => name === 'Stop')).toHaveLength(before);
    });
    it('does not toggle an already paused player into playback', async () => {
        const { engine, state, connection } = setup();
        await engine.open(source);
        await engine.play();
        state.state = 1;
        await engine.pause();
        expect(connection.request.mock.calls.some(([name]) => name === 'Pause')).toBe(false);
        expect(state.state).toBe(1);
    });
    it('emits EOF near the known ending, but reports early stops as failures', async () => {
        vi.useFakeTimers();
        const ended = setup({}, { pollMs: 50 });
        await ended.engine.open(source);
        await ended.engine.play();
        ended.state.position = 9.5;
        await vi.advanceTimersByTimeAsync(50);
        ended.state.state = 0;
        ended.state.position = 0;
        ended.state.tracks_total = 0;
        await vi.advanceTimersByTimeAsync(50);
        expect(ended.report.mock.calls.some(([event]) => event.type === 'ended')).toBe(true);
        const failed = setup({}, { pollMs: 50 });
        await failed.engine.configure({ earlyStopAsEnded: false });
        await failed.engine.open(source);
        await failed.engine.play();
        failed.state.position = 2;
        await vi.advanceTimersByTimeAsync(50);
        failed.state.state = 0;
        failed.state.position = 0;
        failed.state.tracks_total = 0;
        await vi.advanceTimersByTimeAsync(50);
        expect(failed.report.mock.calls.some(([event]) => event.type === 'error')).toBe(true);
        expect(failed.report.mock.calls.some(([event]) => event.type === 'ended')).toBe(false);
    });
    it('reloads an unexpectedly emptied transport only on explicit Play, preserving the last confirmed position', async () => {
        vi.useFakeTimers();
        const s = setup({}, { pollMs: 50 });
        await s.engine.configure({ earlyStopAsEnded: false });
        await s.engine.open(source);
        await s.engine.play();
        await s.engine.seek(2);
        Object.assign(s.state, { state: 0, tracks_total: 0, position: 0, length: 0 });
        await vi.advanceTimersByTimeAsync(1500);
        expect(s.report.mock.calls.some(([event]) => event.type === 'error')).toBe(true);
        expect(s.report.mock.calls.some(([event]) => event.type === 'ended')).toBe(false);
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'PlayNextURI')).toHaveLength(1);
        s.state.length = 10;
        await s.engine.play();
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'PlayNextURI')).toHaveLength(2);
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'Play')).toHaveLength(1);
        expect(s.state.position).toBe(2);
        expect(s.state.state).toBe(2);
    });
    it('treats an owned early stop as EOF by default, logging its clocks and emitting ended exactly once', async () => {
        vi.useFakeTimers();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const s = setup({}, { pollMs: 50 });
        await s.engine.open(source);
        await s.engine.play();
        await s.engine.seek(2);
        Object.assign(s.state, { state: 0, tracks_total: 0, position: 0, length: 0 });
        await vi.advanceTimersByTimeAsync(1500);
        expect(s.report.mock.calls.filter(([event]) => event.type === 'ended')).toHaveLength(1);
        expect(s.report.mock.calls.some(([event]) => event.type === 'error')).toBe(false);
        expect(warning).toHaveBeenCalledExactlyOnceWith('[HQPlayer] Early stop treated as track end by temporary policy',
            { lastPosition: 2, lastDuration: 10, stoppedPosition: 0, stoppedDuration: 0, tracks: 0 });
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'PlayNextURI')).toHaveLength(1);
        warning.mockRestore();
    });
    it('can open the next track when a confirmed EOF retains the same known single-track transport', async () => {
        vi.useFakeTimers();
        const s = setup({ track_id: 'ours' }, { pollMs: 50 });
        await s.engine.open(source);
        await s.engine.play();
        await s.engine.seek(9);
        s.state.state = 0;
        await vi.advanceTimersByTimeAsync(50);
        expect(s.report).toHaveBeenLastCalledWith({ type: 'ended', sourceId: 'one' });
        await s.engine.open({ ...source, sourceId: 'two' });
        await s.engine.play();
        expect(s.state.state).toBe(2);
    });
    it('does not advance for explicit pause/mute, a foreign track or a failed status query', async () => {
        vi.useFakeTimers();
        const paused = setup({}, { pollMs: 50 });
        await paused.engine.open(source);
        await paused.engine.play();
        await paused.engine.pause();
        Object.assign(paused.state, { state: 0, tracks_total: 0 });
        await vi.advanceTimersByTimeAsync(100);
        expect(paused.report.mock.calls.some(([event]) => event.type === 'ended')).toBe(false);
        await paused.engine.dispose();
        const muted = setup({}, { pollMs: 50 });
        await muted.engine.open(source);
        await muted.engine.play();
        await muted.engine.setVolume(0);
        Object.assign(muted.state, { state: 0, tracks_total: 0 });
        await vi.advanceTimersByTimeAsync(100);
        expect(muted.report.mock.calls.some(([event]) => event.type === 'ended')).toBe(false);
        await muted.engine.dispose();
        const foreign = setup({ track_id: 'ours' }, { pollMs: 50 });
        await foreign.engine.open(source);
        await foreign.engine.play();
        Object.assign(foreign.state, { state: 0, tracks_total: 1, track_id: 'foreign' });
        await vi.advanceTimersByTimeAsync(100);
        expect(foreign.report.mock.calls.some(([event]) => event.type === 'ended')).toBe(false);
        expect(foreign.report.mock.calls.some(([event]) => event.type === 'error')).toBe(true);
        const failed = setup({}, { pollMs: 50 });
        await failed.engine.open(source);
        await failed.engine.play();
        const request = failed.connection.request.getMockImplementation()!;
        failed.connection.request.mockRejectedValueOnce(new Error('Status timed out'));
        await vi.advanceTimersByTimeAsync(100);
        expect(failed.report.mock.calls.some(([event]) => event.type === 'ended')).toBe(false);
        expect(failed.report.mock.calls.some(([event]) => event.type === 'error')).toBe(true);
        failed.connection.request.mockImplementation(request);
    });
});
