import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import activate from '../../../extensions/hqplayer/client.mjs';
import { createBackendController } from '../../../src/services/playbackBackend/controller';

// Exercise network recovery through the real host, mod client/display clock and native engine, not a no-op seek.
const require = createRequire(import.meta.url);
const { createHqpEngine } = require('../../../extensions/hqplayer/engine.cjs');
const { commandXml, parseResponse } = require('../../../extensions/hqplayer/protocol.cjs');

it('resumes the native HTTP transport at the saved position after an ignored seek acknowledgement', async () => {
    vi.useFakeTimers();
    const state = { state: 0, position: 0, length: 180, volume: -20, tracks_total: 0, track_id: '', repeat: 0, random: 0 };
    let serial = 0, ignoredSeeks = 0, resuming = false, failure: { code: string; retryable: boolean } | null = null;
    const connection = { closed: false, close: vi.fn(), request: vi.fn(async (name: string, attrs: Record<string, number> = {}) => {
        if (name === 'GetInfo') return parseResponse('<GetInfo product="Signalyst HQPlayer Desktop"/>', name);
        if (name === 'VolumeRange') return parseResponse('<VolumeRange min="-120" max="0" enabled="1"/>', name);
        if (name === 'Stop') Object.assign(state, { state: 0, tracks_total: 0, position: 0 });
        if (name === 'PlayNextURI') Object.assign(state, { state: 2, tracks_total: 1, position: 0, track_id: `track-${++serial}` });
        if (name === 'Pause') state.state = 1;
        if (name === 'Play') state.state = 2;
        if (name === 'Volume') state.volume = attrs.value;
        if (name === 'Seek') {
            if (!resuming || state.state === 1 && ignoredSeeks-- <= 0) state.position = attrs.position;
        }
        if (name === 'Status') return parseResponse(commandXml(name, state), name);
        return parseResponse(commandXml(name, { result: 'OK' }), name);
    }) };
    const listeners = new Set<(event: any) => void>();
    const engine = createHqpEngine((event: any) => listeners.forEach(listener => listener(event)), '/isolated', {
        connect: () => connection, ensureRunning: async () => {}, pollMs: 50,
        prepare: async (source: any) => ({ uri: source.url, release: async () => {} }),
    });
    let backend: any;
    await activate({
        env: { context: 'main', locale: 'en' }, experimental: { 'playback.backends': { supportsStreams: true,
            register: (definition: any) => { backend = definition; return { unregister() {} }; } } },
        rpc: { call: (name: string, ...args: any[]) => name === 'hqplayer.ensureRunning' ? Promise.resolve() : engine[name.slice(9)](...args),
            on: (_name: string, listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
        registries: { commands: { register: () => ({ unregister() {} }) }, settingsSections: { register: () => ({ settings: {
            get: () => ({}), onChange: () => () => {},
        } }) } }, every() {}, onDispose() {}, playback: { pause() {} }, ui: { toast() {} }, log: { warn() {}, error() {} },
    });
    const controller = createBackendController(async (url, sourceId) => ({ source: { sourceId, url }, release: async () => {},
        getError: async () => failure?.code ?? null, getTransfer: async () => ({ receivedBytes: 100, bytesPerSecond: 0, failure }),
        probe: async () => { failure = null; return { ready: true, retryable: true }; }, cancelProbe: async () => {},
    }));
    const events: any[] = []; controller.subscribe(event => events.push(event));
    const settle = async (promise: Promise<unknown>) => { await vi.advanceTimersByTimeAsync(1500); return promise; };
    try {
        await controller.setBackend(backend);
        await controller.open('http://127.0.0.1:12345/synthetic/audio.flac');
        await settle(controller.play()); await controller.seek(42);
        expect(state.position).toBe(42);
        failure = { code: 'SOURCE_UNREACHABLE', retryable: true };
        resuming = true; ignoredSeeks = 1;
        Object.assign(state, { state: 0, position: 0, tracks_total: 0 });
        await vi.advanceTimersByTimeAsync(100);
        expect(controller.getStatus()).toMatchObject({ state: 'loading', position: 42 });
        await vi.advanceTimersByTimeAsync(1200);
        expect(controller.getStatus().state).toBe('loading');
        expect(state.state).toBe(1);
        await vi.advanceTimersByTimeAsync(2000);
        expect(state).toMatchObject({ state: 2, position: 42 });
        expect(controller.getStatus()).toMatchObject({ state: 'playing', position: 42 });
        expect(events.filter(event => event.type !== 'status')).toEqual([]);
        expect(connection.request.mock.calls.filter(([name]) => name === 'PlayNextURI')).toHaveLength(2);
        expect(connection.request.mock.calls.filter(([name]) => name === 'Seek')).toHaveLength(3);
    } finally {
        await settle(controller.setBackend(null)); await engine.dispose(); vi.useRealTimers();
    }
});
