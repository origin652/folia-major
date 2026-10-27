import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { registerDspSettings } from '../../../extensions/hqplayer/dspSettings.mjs';
import { sanitizeFoliumParams } from '../../../src/mods/params/params';
import { addDspFixture } from './dspFixture';

// Exercise dynamic registrations through the public Folium schema, not a second settings UI.
const require = createRequire(import.meta.url);
const { readDsp } = require('../../../extensions/hqplayer/dsp.cjs');
const setup = async () => {
    const protocol = { request: vi.fn() };
    addDspFixture(protocol);
    const snapshot = await readDsp(protocol);
    const commands = new Map<string, any>();
    const sections = new Map<string, any>();
    let invalidate = () => {};
    const connection = { settings: { get: () => ({ port: 4321 }), onChange: (fn: () => void) => { invalidate = fn; return vi.fn(); } } };
    const api = {
        env: { locale: 'zh-CN' }, ui: { toast: vi.fn() }, onDispose: vi.fn(),
        registries: {
            commands: { register: (def: any) => { commands.set(def.id, def); return { unregister: () => commands.delete(def.id) }; } },
            settingsSections: { register: (def: any) => {
                const fields = sanitizeFoliumParams(def.settings);
                expect(fields).toHaveLength(def.settings.length);
                const values = Object.fromEntries(fields.map(field => [field.key, 'stale-persisted-index']));
                const section = { ...def, settings: { get: () => ({ ...values }), set: (patch: any) => Object.assign(values, patch) } };
                sections.set(def.id, section);
                return { settings: section.settings, unregister: () => sections.delete(def.id) };
            } },
        },
    };
    const call = vi.fn(async () => snapshot);
    registerDspSettings(api, connection, call);
    return { api, snapshot, commands, sections, call, invalidate: () => invalidate() };
};
describe('HQPlayer DSP settings', () => {
    it('does nothing on activation, then exposes live draft controls and commands on explicit refresh', async () => {
        const s = await setup();
        expect(s.call).not.toHaveBeenCalled();
        expect(s.commands.size).toBe(1);
        await s.commands.get('refresh-dsp').run();
        expect(s.call).toHaveBeenCalledExactlyOnceWith('readDsp', { port: 4321 });
        const section = s.sections.get('dsp');
        expect(section.settings.get()).toEqual({ filter: '40', filter1x: '37', shaper: '7', rate: '8' });
        expect(section.label['zh-CN']).toContain('PCM');
        expect(s.commands.has('apply-dsp')).toBe(true);
        expect(s.commands.get('set-dsp-mode').params[0].options.map((item: any) => item.value)).toEqual(['1', '2']);
        section.settings.set({ filter: '2' });
        expect(s.call).toHaveBeenCalledTimes(1);
        await s.commands.get('apply-dsp').run();
        expect(s.call).toHaveBeenLastCalledWith('applyDsp', { port: 4321 }, s.snapshot.revision,
            { filter: 2, filter1x: 37, shaper: 7, rate: 8 });
        expect(s.sections.get('dsp').settings.get().filter).toBe('40');
    });
    it('applies modes separately and invalidates old forms after a connection setting change', async () => {
        const s = await setup();
        await s.commands.get('refresh-dsp').run();
        const mode = s.commands.get('set-dsp-mode');
        await mode.run({ values: { mode: '2' } });
        expect(s.call).toHaveBeenLastCalledWith('applyDsp', { port: 4321 }, s.snapshot.revision, { mode: 2 });
        s.invalidate();
        expect(s.sections.size).toBe(0);
        expect(s.commands.has('apply-dsp')).toBe(false);
        const count = s.call.mock.calls.length;
        await expect(mode.run({ values: { mode: '2' } })).rejects.toThrow('重新读取');
        expect(s.call).toHaveBeenCalledTimes(count);
    });
    it('invalidates drafts on failure and requires a fresh read, with no retry', async () => {
        const s = await setup();
        await s.commands.get('refresh-dsp').run();
        s.call.mockRejectedValueOnce(new Error('partial failure'));
        await expect(s.commands.get('apply-dsp').run()).rejects.toThrow('partial failure');
        expect(s.call).toHaveBeenCalledTimes(2);
        expect(s.sections.size).toBe(0);
        expect(s.commands.size).toBe(1);
    });
    it('discards an in-flight read after connection changes and refuses concurrent DSP operations', async () => {
        const s = await setup();
        let release!: (value: any) => void;
        s.call.mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const pending = s.commands.get('refresh-dsp').run();
        await expect(s.commands.get('refresh-dsp').run()).rejects.toThrow('正忙');
        s.invalidate();
        release(s.snapshot);
        await expect(pending).rejects.toThrow('connection changed');
        expect(s.sections.size).toBe(0);
    });
});
