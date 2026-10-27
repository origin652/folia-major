import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import activate from '../../../extensions/hqplayer/client.mjs';
import { createBackendController } from '../../../src/services/playbackBackend/controller';

// Continuous queue advancement crosses the unchanged host, mod client/clock and real mod engine.
const require = createRequire(import.meta.url);
const { createHqpEngine } = require('../../../extensions/hqplayer/engine.cjs');
const { commandXml, parseResponse } = require('../../../extensions/hqplayer/protocol.cjs');

describe('HQPlayer host/client/engine integration', () => {
    it('keeps control across five asynchronous stops, pauses and automatic EOF queue advances', async () => {
        vi.useFakeTimers();
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const state = { state: 0, position: 0, length: 10, volume: -20, tracks_total: 0, track_id: '', repeat: 0, random: 0 };
        let stopping = 0, pausing = 0, serial = 0;
        const connection = { closed: false, close: vi.fn(), request: vi.fn(async (name: string, attrs: Record<string, number> = {}) => {
            if (name === 'GetInfo') return parseResponse('<GetInfo product="Signalyst HQPlayer Desktop"/>', name);
            if (name === 'VolumeRange') return parseResponse('<VolumeRange min="-120" max="0" enabled="1"/>', name);
            if (name === 'Stop') { stopping = 2; Object.assign(state, { state: 3, tracks_total: 0, position: 0, length: 0 }); }
            if (name === 'Pause') pausing = 2;
            if (name === 'PlayNextURI') Object.assign(state, { state: 2, tracks_total: 1, position: 0, length: 10, track_id: `track-${++serial}` });
            if (name === 'Play') state.state = 2;
            if (name === 'Seek') state.position = attrs.position;
            if (name === 'Volume') state.volume = attrs.value;
            if (name === 'Status') {
                if (stopping && --stopping === 0) state.state = 0;
                if (pausing && --pausing === 0) state.state = 1;
                return parseResponse(commandXml(name, state), name);
            }
            return parseResponse(commandXml(name, { result: 'OK' }), name);
        }) };
        const listeners = new Set<(event: any) => void>();
        const engine = createHqpEngine((event: any) => listeners.forEach(listener => listener(event)), '/isolated', {
            connect: () => connection, ensureRunning: async () => {}, pollMs: 50,
            prepare: async () => ({ filePath: 'C:\\isolated\\test.wav', release: async () => {} }),
        });
        let backend: any;
        await activate({
            env: { context: 'main', locale: 'en' }, experimental: { 'playback.backends': { register: (def: any) => { backend = def; return { unregister() {} }; } } },
            rpc: { call: (name: string, ...args: any[]) => name === 'hqplayer.ensureRunning' ? Promise.resolve() : engine[name.slice(9)](...args),
                on: (_name: string, listener: (event: any) => void) => { listeners.add(listener); return () => listeners.delete(listener); } },
            registries: { commands: { register: () => ({ unregister() {} }) }, settingsSections: { register: () => ({ settings: {
                get: () => ({}), onChange: () => () => {},
            } }) } },
            every() {}, onDispose() {}, playback: { pause() {} }, ui: { toast() {} }, log: { warn() {}, error() {} },
        });
        const controller = createBackendController(async (url, sourceId) => ({ source: { sourceId, url }, release: async () => {} }));
        const events: any[] = [];
        let advancing: Promise<unknown> = Promise.resolve();
        controller.subscribe(event => {
            events.push(event);
            if (event.type === 'ended') advancing = controller.open(`https://test/track-${events.length}`).then(() => controller.play());
        });
        const settle = async (promise: Promise<unknown>) => {
            await vi.advanceTimersByTimeAsync(1600);
            return promise;
        };
        try {
            await controller.setBackend(backend);
            await settle(controller.open('https://test/first'));
            await settle(controller.play());
            for (let cycle = 0; cycle < 5; cycle++) {
                await settle(controller.pause());
                expect(state.state).toBe(1);
                await settle(controller.play());
                await controller.seek(cycle === 2 ? 2 : 9);
                stopping = 2;
                Object.assign(state, { state: 3, tracks_total: 0, position: 0, length: 0 });
                await vi.advanceTimersByTimeAsync(2500);
                await advancing;
                expect(controller.getStatus().state).toBe('playing');
                expect(state.state).toBe(2);
            }
            expect(events.filter(event => event.type === 'ended')).toHaveLength(5);
            expect(events.filter(event => event.type === 'error')).toEqual([]);
            expect(connection.request.mock.calls.filter(([name]) => name === 'GetInfo')).toHaveLength(1);
            expect(connection.request.mock.calls.filter(([name]) => name === 'PlayNextURI')).toHaveLength(6);
            expect(warning).toHaveBeenCalledExactlyOnceWith('[HQPlayer] Early stop treated as track end by temporary policy',
                expect.objectContaining({ lastPosition: 2, lastDuration: 10 }));
        } finally {
            await settle(controller.setBackend(null));
            await engine.dispose();
            warning.mockRestore();
            vi.useRealTimers();
        }
    });
});
