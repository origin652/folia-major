import { afterEach, describe, expect, it, vi } from 'vitest';
import activate from '../../../extensions/hqplayer/client.mjs';
import { fields } from '../../../extensions/hqplayer/settings.mjs';
import { sanitizeFoliumParams } from '../../../src/mods/params/params';

// Public API integration without DOM, HQPlayer, private host stores or user profiles.
const setup = () => {
    const commands = new Map<string, any>();
    const values: Record<string, unknown> = { port: 4321, ceilingDb: -6, takeOver: false };
    let changed = () => {};
    const backend = vi.fn();
    const events = new Map<string, (value: unknown) => void>();
    const api = {
        env: { context: 'main', locale: 'en' },
        experimental: { 'playback.backends': { register: backend.mockReturnValue({ unregister: vi.fn() }) } },
        registries: {
            settingsSections: { register: vi.fn(() => ({ settings: {
                get: () => ({ ...values }), set: (next: Record<string, unknown>) => { Object.assign(values, next); changed(); },
                onChange: (listener: () => void) => { changed = listener; },
            } })) },
            commands: { register: (command: any) => commands.set(command.id, command) },
        },
        rpc: {
            call: vi.fn(async (method: string) => method === 'hqplayer.inspect' ? { product: 'HQPlayer', version: '6', engine: '6.2.4', state: 'stopped', licensed: false, variableVolume: false } : undefined),
            on: (name: string, listener: (value: unknown) => void) => { events.set(name, listener); return () => events.delete(name); },
        },
        log: { warn: vi.fn(), error: vi.fn() }, ui: { toast: vi.fn() },
        playback: { pause: vi.fn() }, every: vi.fn(), onDispose: vi.fn(),
    };
    return { api, commands, values, events, backend };
};
afterEach(() => { vi.restoreAllMocks(); });

describe('HQPlayer Folium client', () => {
    it('filters duplicate progress through the registered session without touching the playback service', async () => {
        let now = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const { api, backend, events } = setup();
        await activate(api);
        const report = vi.fn();
        const session = backend.mock.calls[0][0].create(report);
        await session.open({ sourceId: 'one', filePath: '/test.audio' });
        const send = (sourceId: string, position: number) => events.get('hqplayer.event')?.({ type: 'status', status: { sourceId, state: 'playing', position, duration: 30 } });
        send('one', 10);
        now = 500;
        send('one', 10);
        send('retired', 80);
        expect(report).toHaveBeenCalledOnce();
        now = 1000;
        send('one', 11);
        expect(report).toHaveBeenLastCalledWith({ type: 'status', status: { sourceId: 'one', state: 'playing', position: 11, duration: 30 } });
        expect(api.playback.pause).not.toHaveBeenCalled();
        expect(api.every).toHaveBeenCalledTimes(1);
        expect(api.every).toHaveBeenCalledWith(2000, expect.any(Function));
        await session.dispose();
    });
    it('holds an explicit seek target while RPC is pending and then forwards its confirmed position', async () => {
        const { api, backend, events } = setup();
        await activate(api);
        const report = vi.fn();
        const session = backend.mock.calls[0][0].create(report);
        await session.open({ sourceId: 'one', filePath: '/test.audio' });
        const send = (position: number) => events.get('hqplayer.event')?.({ type: 'status', status: { sourceId: 'one', state: 'playing', position, duration: 60 } });
        send(30);
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        api.rpc.call.mockImplementation(async method => {
            if (method === 'hqplayer.seek') { await gate; send(5); }
            return undefined;
        });
        const pending = session.seek(5.9);
        await vi.waitFor(() => expect(api.rpc.call).toHaveBeenCalledWith('hqplayer.seek', 5.9));
        expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ status: expect.objectContaining({ state: 'loading', position: 5 }) }));
        send(30.5);
        expect(report).toHaveBeenCalledTimes(2);
        release();
        await pending;
        expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ status: expect.objectContaining({ state: 'playing', position: 5 }) }));
        await session.dispose();
    });
    it('exposes automatic launch and executable controls through the real host schema', () => {
        const schema = sanitizeFoliumParams(fields);
        expect(schema).toHaveLength(fields.length);
        expect(schema.find(field => field.key === 'autoStart')).toMatchObject({ type: 'boolean', defaultValue: true });
        expect(schema.find(field => field.key === 'executable')).toMatchObject({ type: 'text', defaultValue: '' });
        expect(schema.find(field => field.key === 'earlyStopAsEnded')).toMatchObject({ type: 'boolean', defaultValue: true });
    });
    it('ensures the player is running on backend selection without starting audio', async () => {
        const { api, backend } = setup();
        await activate(api);
        const session = backend.mock.calls[0][0].create(vi.fn());
        await Promise.resolve();
        expect(api.rpc.call).toHaveBeenCalledExactlyOnceWith('hqplayer.ensureRunning', expect.any(Object));
        await session.dispose();
    });
    it('does not connect or seize output when enabled, and ignores the export context', async () => {
        const { api, backend } = setup();
        await activate(api);
        expect(api.rpc.call).not.toHaveBeenCalled();
        expect(backend.mock.calls[0][0].capabilities).toEqual({ seek: true, volume: true, http: false });
        const other = setup();
        other.api.env.context = 'export';
        await activate(other.api);
        expect(other.backend).not.toHaveBeenCalled();
    });
    it('shows read-only connection/license results and actionable fixed-volume feedback', async () => {
        const { api, commands } = setup();
        await activate(api);
        const result = await commands.get('check-connection').run();
        expect(result.message).toContain('No valid license detected');
        expect(result.message).toContain('Enable variable volume');
        expect(api.playback.pause).not.toHaveBeenCalled();
        expect(api.rpc.call).toHaveBeenCalledTimes(1);
    });
    it('offers the temporary stop policy in the public configuration command as well as mod settings', async () => {
        const { api, commands, values } = setup();
        await activate(api);
        expect(commands.get('configure').params.find((field: any) => field.key === 'earlyStopAsEnded')).toMatchObject({ type: 'boolean', defaultValue: true });
        await commands.get('configure').run({ values: { earlyStopAsEnded: false } });
        expect(values.earlyStopAsEnded).toBe(false);
        expect(api.rpc.call).not.toHaveBeenCalled();
    });
    it('serializes settings, open and dispose and detaches old event forwarding', async () => {
        const { api, backend, events } = setup();
        await activate(api);
        const report = vi.fn();
        const session = backend.mock.calls[0][0].create(report);
        await session.open({ sourceId: 'one', filePath: '/test.audio' });
        expect(api.rpc.call.mock.calls.slice(0,3).map(([method]) => method)).toEqual(['hqplayer.ensureRunning', 'hqplayer.configure', 'hqplayer.open']);
        events.get('hqplayer.event')?.({ type: 'status', status: { sourceId: 'one', state: 'paused', position: 3, duration: 10 } });
        expect(report).toHaveBeenCalledOnce();
        await session.dispose();
        expect(events.size).toBe(0);
        expect(api.rpc.call).toHaveBeenLastCalledWith('hqplayer.dispose');
        await expect(session.play()).rejects.toThrow('retired');
    });
    it('re-arms the display clock only on explicit Play after an engine error', async () => {
        const { api, backend, events } = setup();
        await activate(api);
        const report = vi.fn();
        const session = backend.mock.calls[0][0].create(report);
        await session.open({ sourceId: 'one', filePath: '/test.audio' });
        const send = (event: unknown) => events.get('hqplayer.event')?.(event);
        const status = { type: 'status', status: { sourceId: 'one', state: 'playing', position: 2, duration: 10 } };
        send(status);
        send({ type: 'error', sourceId: 'retired', message: 'stale' });
        send({ type: 'error', sourceId: 'one', message: 'HQPlayer stopped before the track ended' });
        const failedCount = report.mock.calls.length;
        send(status);
        expect(report).toHaveBeenCalledTimes(failedCount);
        expect(api.rpc.call.mock.calls.filter(([method]) => method === 'hqplayer.play')).toHaveLength(0);
        api.rpc.call.mockImplementation(async method => { if (method === 'hqplayer.play') send(status); });
        await session.play();
        expect(report).toHaveBeenLastCalledWith(status);
        expect(report).toHaveBeenCalledTimes(failedCount + 1);
        await session.dispose();
    });
});
