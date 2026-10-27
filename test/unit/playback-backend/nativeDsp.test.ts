import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Validate native arguments and strict negotiated output, not just the settings' appearance.
const require = createRequire(import.meta.url);
const { normalizeConfig, buildDspFilters, buildMpvArgs, validateOutput } = require('../../../extensions/native-audio/dsp.cjs');

describe('native DSP and strict output', () => {
    it('defaults to shared, bypassed DSP; every feature has an independent switch', () => {
        expect(normalizeConfig()).toMatchObject({ exclusive: false, dspEnabled: false, resampleEnabled: false, eqEnabled: false });
        expect(buildDspFilters({ resampleEnabled: true, eqEnabled: true })).toEqual([]);
        expect(buildDspFilters({ dspEnabled: true, headroomEnabled: false })).toEqual([]);
        expect(buildDspFilters({ dspEnabled: true, resampleEnabled: true, headroomEnabled: false })[0]).toContain('resampler=soxr:precision=33');
        expect(buildDspFilters({ dspEnabled: true, resampleEnabled: false })).toEqual(['volume=-3dB:precision=double']);
    });
    it('honors order and each module bypass', () => {
        const filters = buildDspFilters({ dspEnabled: true, eqEnabled: true, resampleEnabled: true, order: 'eq,resample,headroom' });
        expect(filters.map((s: string) => s.split('=')[0])).toEqual(['bass', 'treble', 'aresample', 'volume']);
    });
    it('rejects unsafe and inconsistent settings', () => {
        for (const config of [{ targetRate: 1 }, { headroomDb: 4 }, { bassDb: NaN }, { order: 'eq,eq,resample' },
            { order: 'eq,resample,headroom;anull' }, { device: 'auto\n--ao=null' }, { exclusive: 'yes' }, { outputFormat: 's24' }, { executable: 'mpv.com' }]) {
            expect(() => normalizeConfig(config)).toThrow();
        }
    });
    it('pins WASAPI, blocks null fallback, disables auto-loaded scripts and starts muted', () => {
        const args = buildMpvArgs({ exclusive: true }, 'test-pipe');
        expect(args).toEqual(expect.arrayContaining(['--ao=wasapi', '--audio-exclusive=yes', '--audio-fallback-to-null=no', '--load-scripts=no', '--no-config', '--volume=0', '--pause=yes']));
        expect(args.some((s: string) => s.startsWith('--af='))).toBe(false);
    });
    it('passes the explicitly selected endpoint without replacing it with the default', () => {
        const args = buildMpvArgs({ device: 'wasapi/dac', exclusive: true }, 'test-pipe');
        expect(args).toContain('--audio-device=wasapi/dac');
        expect(args).not.toContain('--audio-device=auto');
        expect(args).toContain('--audio-exclusive=yes');
    });
    it('requires confirmed exclusive, exact output rate/format and no unintended downsampling', () => {
        expect(() => validateOutput({ exclusive: true }, { samplerate: 48000, format: 's32' }, false, 48000)).toThrow('not confirmed');
        expect(() => validateOutput({ exclusive: true }, { samplerate: 96000, format: 's32' }, true, 48000)).toThrow('source sample rate');
        expect(() => validateOutput({ outputFormat: 's32' }, { samplerate: 48000, format: 'float' }, false, 48000)).toThrow('sample format');
        expect(() => validateOutput({ dspEnabled: true, resampleEnabled: true, targetRate: 96000 }, { samplerate: 48000, format: 's32' }, true, 48000)).toThrow('sample rate');
        expect(() => validateOutput({ dspEnabled: true, resampleEnabled: true, targetRate: 96000 }, { samplerate: 96000, format: 's32' }, true, 192000)).toThrow('below');
        expect(() => validateOutput({ exclusive: true, outputFormat: 's32' }, { samplerate: 48000, format: 's32' }, true, 48000)).not.toThrow();
    });
});
