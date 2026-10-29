import { afterEach, describe, expect, it, vi } from 'vitest';
import { controlFixture } from './controlFixture';
import activate from '../../../extensions/hqplayer/client.mjs';
import { createBackendController } from '../../../src/services/playbackBackend/controller';

// The real engine/connection must reconnect without replacing or restarting the audio input.
const fixtures: Awaited<ReturnType<typeof controlFixture>>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map(s => s.close())); vi.restoreAllMocks(); });
const setup = async (options = {}) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const s = await controlFixture(options);
    fixtures.push(s);
    s.commands.length = 0;
    s.report.mockClear();
    return s;
};
const statuses = (s: Awaited<ReturnType<typeof setup>>) => s.report.mock.calls.map(([e]) => e.status).filter(Boolean);
const expectReadOnly = (s: Awaited<ReturnType<typeof setup>>) => {
    expect(s.commands.every(c => ['Status', 'GetInfo', 'PlaylistGet'].includes(c.name))).toBe(true);
    expect(s.prepare).toHaveBeenCalledOnce();
    expect(s.ensureRunning).toHaveBeenCalledOnce();
};

describe('HQPlayer control recovery', () => {
    it('retries a failed new control connection and can recover again later without restarting HQPlayer', async () => {
        const s = await setup({ controlRecoveryMs: 1500 });
        s.state.position = 42;
        s.failRecoveries(1);
        s.disconnect();
        await vi.waitFor(() => expect(statuses(s).at(-1)).toMatchObject({ state: 'playing', position: 42 }), { timeout: 2500 });
        s.state.position = 43;
        s.drop('Status');
        await vi.waitFor(() => expect(s.commands.filter(c => c.name === 'PlaylistGet')).toHaveLength(2));
        expect(s.report.mock.calls.some(([e]) => e.type === 'error')).toBe(false);
        expectReadOnly(s);
    });

    it('resumes normal EOF detection after a verified transitional loading state', async () => {
        const s = await setup();
        s.state.state = 3;
        s.disconnect();
        await vi.waitFor(() => expect(s.commands.some(c => c.name === 'PlaylistGet')).toBe(true));
        s.state.state = 2;
        s.state.position = 119;
        await vi.waitFor(() => expect(statuses(s).at(-1)).toMatchObject({ state: 'playing', position: 119 }));
        s.state.state = 0;
        s.state.tracks_total = 0;
        await vi.waitFor(() => expect(s.report.mock.calls.filter(([e]) => e.type === 'ended')).toHaveLength(1));
        expect(s.report.mock.calls.some(([e]) => e.type === 'error')).toBe(false);
    });
    it('resynchronizes the unchanged host through the mod client and clock without terminal paused state', async () => {
        const s = await setup();
        let backend: any;
        await activate({
            env: { context: 'main', locale: 'en' }, experimental: { 'playback.backends': { register: (def: any) => { backend = def; return { unregister() {} }; } } },
            rpc: { call: (name: string, ...args: any[]) => name === 'hqplayer.ensureRunning' ? Promise.resolve() : s.engine[name.slice(9)](...args),
                on: (_name: string, listener: (event: any) => void) => { s.listeners.add(listener); return () => s.listeners.delete(listener); } },
            registries: { commands: { register: () => ({ unregister() {} }) }, settingsSections: { register: () => ({ settings: {
                get: () => ({ port: s.port }), onChange: () => () => {},
            } }) } },
            every() {}, onDispose() {}, playback: { pause() {} }, ui: { toast() {} }, log: { warn() {}, error() {} },
        });
        const controller = createBackendController(async (url, sourceId) => ({ source: { sourceId, url }, release: async () => {} }));
        const events: any[] = [];
        controller.subscribe(event => events.push(event));
        try {
            await controller.setBackend(backend);
            await controller.open('http://127.0.0.1/isolated/source');
            await controller.play();
            const sourceId = controller.getStatus().sourceId;
            s.commands.length = 0;
            events.length = 0;
            s.state.position = 42;
            s.drop('Status');
            await vi.waitFor(() => expect(events.some(e => e.status?.state === 'loading')).toBe(true));
            await vi.waitFor(() => expect(controller.getStatus()).toMatchObject({ sourceId, state: 'playing', position: 42 }));
            expect(events.some(e => e.type === 'error' || e.type === 'ended')).toBe(false);
            expect(s.commands.every(c => ['Status', 'GetInfo', 'PlaylistGet'].includes(c.name))).toBe(true);
        } finally { await controller.setBackend(null); }
    });
    it.each([1, 2])('reconciles native state %s after a Status timeout on a new socket, without reloading or seeking', async state => {
        const s = await setup();
        Object.assign(s.state, { state, position: 42 });
        s.drop('Status');
        await vi.waitFor(() => expect(statuses(s).some(status => status.state === 'loading')).toBe(true));
        await vi.waitFor(() => expect(statuses(s).at(-1)).toMatchObject({ state: state === 2 ? 'playing' : 'paused', position: 42 }));
        expect(s.commands.some(c => c.socket === 2 && c.name === 'PlaylistGet')).toBe(true);
        expect(s.report.mock.calls.some(([e]) => e.type === 'error' || e.type === 'ended')).toBe(false);
        expectReadOnly(s);
        s.state.position = 43;
        await vi.waitFor(() => expect(statuses(s).at(-1)?.position).toBe(43));
    });

    it.each(['uri', 'id', 'multiple', 'empty'])('refuses an unverified or foreign source (%s), without stopping it', async change => {
        const s = await setup();
        if (change === 'uri') s.foreignUri();
        if (change === 'id') s.state.track_id = 'foreign';
        if (change === 'multiple') s.state.tracks_total = 2;
        if (change === 'empty') Object.assign(s.state, { tracks_total: 0, state: 0 });
        s.disconnect();
        await vi.waitFor(() => expect(s.report.mock.calls.some(([e]) => e.type === 'error')).toBe(true));
        expect(s.report.mock.calls.some(([e]) => e.type === 'ended')).toBe(false);
        expectReadOnly(s);
    });

    it('does not replay a Pause toggle whose acknowledgement was lost', async () => {
        const s = await setup();
        s.drop('Pause');
        await expect(s.engine.pause()).rejects.toThrow('Pause timed out');
        expect(s.commands.filter(c => c.name === 'Pause')).toHaveLength(1);
        expect(s.commands.some(c => ['Play', 'PlayNextURI', 'Seek'].includes(c.name))).toBe(false);
        expect(s.state.state).toBe(1);
        expect(statuses(s).at(-1)).toMatchObject({ state: 'paused' });
        expect(s.report.mock.calls.some(([e]) => e.type === 'error')).toBe(false);
    });

    it('cancels recovery on disposal and never publishes late status or starts audio', async () => {
        const s = await setup();
        s.rejectConnections();
        s.disconnect();
        await vi.waitFor(() => expect(statuses(s).some(status => status.state === 'loading')).toBe(true));
        const before = s.report.mock.calls.length;
        await expect(s.engine.dispose()).rejects.toThrow('connection lost');
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(s.report.mock.calls).toHaveLength(before);
        expectReadOnly(s);
    });

    it.each(['open', 'configure'])('cancels the old recovery when %s replaces the session, without late feedback from the retired source', async method => {
        const s = await setup({ controlRecoveryMs: 1500 });
        s.failRecoveries(1);
        s.disconnect();
        await vi.waitFor(() => expect(s.commands.some(c => c.name === 'GetInfo')).toBe(true));
        const before = s.report.mock.calls.length;
        if (method === 'open') await s.engine.open({ sourceId: 'two', url: 'http://127.0.0.1/isolated/two' });
        else await s.engine.configure({ port: s.port });
        await new Promise(resolve => setTimeout(resolve, 100));
        const later = s.report.mock.calls.slice(before).map(([e]) => e);
        expect(later.some(e => e.sourceId === 'one' || e.status?.sourceId === 'one')).toBe(false);
        expect(s.commands.some(c => ['Play', 'PlayNextURI', 'Seek'].includes(c.name))).toBe(false);
        expect(s.state.state).toBe(0);
    });

    it('bounds unsuccessful recovery and reports unknown state instead of inventing paused feedback', async () => {
        const s = await setup();
        s.rejectConnections();
        s.disconnect();
        await vi.waitFor(() => expect(s.report.mock.calls.some(([e]) => e.type === 'error' && /recovery timed out/.test(e.message))).toBe(true), { timeout: 2000 });
        expect(statuses(s).at(-1).state).toBe('loading');
        expectReadOnly(s);
    });
});
