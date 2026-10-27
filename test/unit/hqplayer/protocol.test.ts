import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// Official protocol enums, hostile XML, and volume validation must not become fake output success.
const require = createRequire(import.meta.url);
const { parseResponse, commandXml, decodeStatus, normalizeConfig, volumeTarget, decodeVolumeRange } = require('../../../extensions/hqplayer/protocol.cjs');
const status = (state = 2, extra = '') => parseResponse(`<Status state="${state}" position="1.25" length="12.5" volume="-9" tracks_total="1" ${extra}/>`, 'Status');

describe('HQPlayer protocol', () => {
    it('uses SDK state enums and fractional seconds, and does not claim exclusive output', () => {
        expect(decodeStatus(status()).state).toBe('playing');
        expect(decodeStatus(status(1)).state).toBe('paused');
        expect(decodeStatus(status(0)).state).toBe('stopped');
        expect(decodeStatus(status()).position).toBe(1.25);
        expect(decodeStatus(status()).duration).toBe(12.5);
        expect(decodeStatus(status())).not.toHaveProperty('exclusiveActive');
        expect(() => decodeStatus(status(9))).toThrow('Unknown');
    });
    it('rejects malformed, wrong, denied and entity-bearing responses', () => {
        for (const xml of ['<Status', '<Other/>', '<Status result="Error">denied</Status>', '<!DOCTYPE Status [<!ENTITY x "a">]><Status/>']) {
            expect(() => parseResponse(xml, 'Status')).toThrow();
        }
        expect(() => decodeStatus(parseResponse('<Status state="2"/>', 'Status'))).toThrow('position');
        expect(() => decodeStatus(status(2, 'active_rate="96000"').cloneNode(false))).not.toThrow();
    });
    it('escapes URIs structurally rather than concatenating XML attributes', () => {
        const uri = 'file:///C:/music/a&b<track>".wav';
        const xml = commandXml('PlaylistAdd', { uri, start: 0 });
        expect(xml.endsWith('\n')).toBe(true);
        expect(parseResponse(xml, 'PlaylistAdd').getAttribute('uri')).toBe(uri);
        expect(() => commandXml('Play/><Stop')).toThrow();
    });
    it('requires variable volume and never raises a low request to the minimum', () => {
        const config = normalizeConfig();
        const range = decodeVolumeRange(parseResponse('<VolumeRange enabled="1" min="-100" max="0"/>', 'VolumeRange'));
        expect(volumeTarget(1, config, range)).toBe(-6);
        expect(volumeTarget(0.5, config, range)).toBeCloseTo(-12.0206);
        expect(volumeTarget(0, config, range)).toBe(-100);
        expect(() => volumeTarget(1, config, { ...range, enabled: false })).toThrow('fixed');
        expect(() => volumeTarget(0.01, config, { ...range, min: -12 })).toThrow('minimum');
        expect(() => normalizeConfig({ ceilingDb: 0 })).toThrow('ceiling');
        expect(() => normalizeConfig({ port: 1.2 })).toThrow('port');
        expect(normalizeConfig({ host: 'remote.example' }).host).toBe('127.0.0.1');
        expect(normalizeConfig().earlyStopAsEnded).toBe(true);
        expect(normalizeConfig({ earlyStopAsEnded: false }).earlyStopAsEnded).toBe(false);
    });
});
