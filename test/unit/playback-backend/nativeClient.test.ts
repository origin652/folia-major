import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFoliumParamAccess, importFoliumParams } from '../../../src/mods/params/paramStore';
import { sanitizeFoliumParams } from '../../../src/mods/params/params';

// Exercise the mod commands with the real Folium schema/store contract, without launching audio.
const require = createRequire(import.meta.url);
const { default: activate } = require('../../../extensions/native-audio/client.mjs');
const { parseDevices } = require('../../../extensions/native-audio/devices.cjs');

const setup = async (saved: Record<string, unknown> = {}) => {
    importFoliumParams({ 'settings:native-audio:output': saved });
    const sections = new Map<string, any>();
    const commands = new Map<string, any>();
    const disposers: Array<() => void> = [];
    let backend: any;
    let receive: any;
    let rejected = false;
    const rpc = vi.fn(async (method: string, value?: any) => {
        if (method === 'native.listDevices') return [{ id: 'wasapi/dac', name: 'USB DAC' }];
        if (method === 'native.configure' && rejected) throw new Error('Device refused exclusive');
        return value;
    });
    const toast = vi.fn();
    const pause = vi.fn();
    await activate({
        env: { context: 'main' },
        registries: {
            settingsSections: { register: (def: any) => {
                const settings = createFoliumParamAccess('settings:native-audio:output', sanitizeFoliumParams(def.settings));
                const entry = { def, settings };
                sections.set(def.id, entry);
                return { settings, unregister: () => { if (sections.get(def.id) === entry) sections.delete(def.id); } };
            } },
            commands: { register: (def: any) => commands.set(def.id, def) },
        },
        experimental: { 'playback.backends': { register: (def: any) => { backend = def; return { unregister() {} }; } } },
        rpc: { call: rpc, on: (_name: string, fn: any) => { receive = fn; return () => {}; } },
        playback: { pause },
        ui: { toast }, log: { warn: vi.fn(), error: vi.fn() }, every: vi.fn(),
        onDispose: (fn: () => void) => disposers.push(fn),
    });
    return { sections, commands, disposers, rpc, toast, pause,
        create: (report: any) => backend.create(report),
        receive: (event: any) => receive(event),
        reject: () => { rejected = true; },
        settings: () => sections.get('output').settings,
    };
};

beforeEach(() => { importFoliumParams({}); });

describe('native device settings and command feedback', () => {
    it('offers only real WASAPI endpoints and never loses a saved missing device', async () => {
        expect(parseDevices([{ name: 'auto' }, { name: 'alsa/default' }, { name: 'wasapi/dac', description: 'USB DAC' },
            { name: 'wasapi/dac', description: 'USB DAC' }, { name: 'wasapi/bad\n' }, null])).toEqual([{ id: 'wasapi/dac', name: 'USB DAC' }]);
        expect(() => parseDevices(null)).toThrow('invalid');
        const mod = await setup({ device: 'wasapi/unplugged', exclusive: true });
        await mod.commands.get('refresh-devices').run();
        const field = mod.sections.get('output').def.settings.find((field: any) => field.key === 'device');
        expect(field.type).toBe('select');
        expect(field.options.map((option: any) => option.value)).toEqual(['auto', 'wasapi/dac', 'wasapi/unplugged']);
        expect(mod.settings().get()).toMatchObject({ device: 'wasapi/unplugged', exclusive: true });
        mod.settings().set({ device: 'wasapi/dac' });
        await mod.commands.get('refresh-devices').run();
        expect(mod.settings().get().device).toBe('wasapi/dac');
    });

    it('returns visible on/off results, and explains the inactive backend and bypassed upsampler', async () => {
        const mod = await setup();
        for (const id of ['exclusive', 'dsp', 'upsampling']) {
            expect((await mod.commands.get(id).run()).message).toContain('ON');
        }
        expect(mod.settings().get()).toMatchObject({ exclusive: true, dspEnabled: true, resampleEnabled: true });
        expect((await mod.commands.get('dsp').run()).message).toContain('DSP is off; SoXR is bypassed');
        expect(mod.toast.mock.calls[0][0]).toContain('select Native Audio');
        expect(mod.rpc.mock.calls.some(([method]) => method === 'native.configure')).toBe(false);
    });

    it('awaits actual reconfiguration, preserves position, and keeps playback paused', async () => {
        const mod = await setup();
        const report = vi.fn();
        const session = mod.create(report);
        await session.open({ sourceId: 'song', url: 'https://example.test/test.flac' });
        mod.receive({ type: 'status', status: { sourceId: 'song', position: 12 } });
        expect((await mod.commands.get('exclusive').run()).message).toContain('ON');
        expect(mod.pause).toHaveBeenCalledOnce();
        expect(mod.rpc).toHaveBeenCalledWith('native.configure', expect.objectContaining({ exclusive: true }));
        expect(mod.rpc).toHaveBeenCalledWith('native.seek', 12);
        expect(mod.rpc.mock.calls.some(([method]) => method === 'native.play')).toBe(false);
        const count = mod.rpc.mock.calls.filter(([method]) => method === 'native.configure').length;
        await mod.commands.get('refresh-devices').run();
        expect(mod.rpc.mock.calls.filter(([method]) => method === 'native.configure')).toHaveLength(count);
        await session.dispose();
    });

    it('surfaces initialization failure to the command, toast, and host, instead of claiming success', async () => {
        const mod = await setup();
        const report = vi.fn();
        const session = mod.create(report);
        await session.open({ sourceId: 'song', filePath: 'track.wav' });
        mod.reject();
        await expect(mod.commands.get('exclusive').run()).rejects.toThrow('Device refused exclusive');
        expect(report).toHaveBeenCalledWith({ type: 'error', sourceId: 'song', message: 'Device refused exclusive' });
        expect(mod.rpc).toHaveBeenCalledWith('native.dispose');
        expect(mod.toast).toHaveBeenCalledWith(expect.stringContaining('Settings could not be applied'), { type: 'error' });
        await session.dispose();
    });

    it('shows discovery failure while preserving the selected device, and can retry', async () => {
        const mod = await setup({ device: 'wasapi/dac' });
        await mod.commands.get('refresh-devices').run();
        mod.rpc.mockRejectedValueOnce(new Error('Engine not found'));
        await expect(mod.commands.get('refresh-devices').run()).rejects.toThrow('Engine not found');
        expect(mod.sections.get('output').def.description.en).toContain('Engine not found');
        expect(mod.settings().get().device).toBe('wasapi/dac');
        await mod.commands.get('refresh-devices').run();
        expect(mod.sections.get('output').def.description.en).not.toContain('Engine not found');
    });

    it('does not resurrect registrations when discovery finishes after the mod is disabled', async () => {
        const mod = await setup();
        let complete!: (value: unknown) => void;
        mod.rpc.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        const refresh = mod.commands.get('refresh-devices').run();
        mod.disposers.forEach(dispose => dispose());
        complete([]);
        await refresh;
        expect(mod.sections.size).toBe(0);
    });
});
