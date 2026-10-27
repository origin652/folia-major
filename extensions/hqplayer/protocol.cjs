'use strict';

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

// HQPlayer Control SDK 6.0.1 uses XML documents terminated by a newline, with seconds and dB.

const parseResponse = (xml, expected) => {
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('HQPlayer XML declarations are not allowed');
    const document = new DOMParser({ onError: (_level, message) => { throw new Error(message); } })
        .parseFromString(xml, 'application/xml');
    const root = document.documentElement;
    if (!root || root.tagName !== expected) throw new Error(`Unexpected HQPlayer response; expected ${expected}`);
    if (root.hasAttribute('result') && root.getAttribute('result') !== 'OK') {
        // Do not include echoed request attributes: URLs may contain credentials.
        throw new Error(`HQPlayer rejected ${expected}; check its own error display`);
    }
    return root;
};

const commandXml = (name, attributes = {}) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new TypeError('Invalid HQPlayer command');
    const document = new DOMParser().parseFromString(`<${name}/>`, 'application/xml');
    for (const [key, value] of Object.entries(attributes)) document.documentElement.setAttribute(key, String(value));
    return '<?xml version="1.0" encoding="UTF-8"?>' + new XMLSerializer().serializeToString(document) + '\n';
};

const numeric = (root, name) => {
    if (!root.hasAttribute(name) || !Number.isFinite(Number(root.getAttribute(name)))) {
        throw new Error(`HQPlayer returned invalid ${name}`);
    }
    return Number(root.getAttribute(name));
};

const decodeStatus = root => {
    // Official SDK enum: STOPPED=0, PAUSED=1, PLAYING=2, STOPREQ=3 (not the reverse).
    const state = numeric(root, 'state');
    if (![0, 1, 2, 3].includes(state)) throw new Error('Unknown HQPlayer transport state');
    const position = numeric(root, 'position');
    const duration = numeric(root, 'length');
    if (position < 0 || duration < 0) throw new Error('HQPlayer returned a negative clock');
    return {
        state: ['stopped', 'paused', 'playing', 'loading'][state], position, duration,
        volumeDb: numeric(root, 'volume'), tracks: numeric(root, 'tracks_total'),
        trackId: root.getAttribute('track_id') || '',
        sampleRate: Number(root.getAttribute('active_rate')) || 0,
        bits: Number(root.getAttribute('active_bits')) || 0,
        mode: root.getAttribute('active_mode') || '', filter: root.getAttribute('active_filter') || '',
        shaper: root.getAttribute('active_shaper') || '',
        repeat: Number(root.getAttribute('repeat')) || 0, random: Number(root.getAttribute('random')) || 0,
    };
};

const normalizeConfig = (values = {}) => {
    const port = Number(values.port ?? 4321);
    const ceilingDb = Number(values.ceilingDb ?? -6);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid HQPlayer TCP port');
    if (!Number.isFinite(ceilingDb) || ceilingDb < -60 || ceilingDb > -3) throw new Error('HQPlayer ceiling must be between -60 and -3 dB');
    if (values.executable !== undefined && typeof values.executable !== 'string') throw new Error('Invalid HQPlayer executable path');
    return { host: '127.0.0.1', port, ceilingDb, takeOver: values.takeOver === true,
        autoStart: values.autoStart !== false, executable: (values.executable ?? '').trim(),
        earlyStopAsEnded: values.earlyStopAsEnded !== false };
};

const volumeTarget = (linear, config, range) => {
    if (!Number.isFinite(linear) || linear < 0 || linear > 1) throw new Error('Invalid Folia volume');
    if (!range.enabled) throw new Error('HQPlayer fixed/bypassed volume is enabled. Enable variable volume in HQPlayer before using Folia output.');
    const target = linear === 0 ? range.min : config.ceilingDb + 20 * Math.log10(linear);
    // Clamping UP to a hardware minimum would make a quiet volume unexpectedly loud.
    if (linear > 0 && target < range.min - 0.05) throw new Error('HQPlayer minimum volume is too high; lower its configured minimum or raise Folia volume.');
    if (target > range.max + 0.05) throw new Error('HQPlayer maximum volume is below the requested level');
    return Math.min(range.max, Math.max(range.min, target));
};

const decodeVolumeRange = root => {
    const min = numeric(root, 'min');
    const max = numeric(root, 'max');
    if (min > max || min < -300 || max > 0) throw new Error('Unsupported HQPlayer volume range');
    return { min, max, enabled: root.getAttribute('enabled') === '1' };
};

module.exports = { parseResponse, commandXml, numeric, decodeStatus, normalizeConfig, volumeTarget, decodeVolumeRange };
