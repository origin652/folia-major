'use strict';

// Validated DSP descriptions compile to native libavfilter/SoXR, never executable filter text.

const DEFAULT_CONFIG = Object.freeze({
    executable: 'bundled', device: 'auto', exclusive: false, outputFormat: 'auto',
    dspEnabled: false, resampleEnabled: false, targetRate: 192000,
    headroomEnabled: true, headroomDb: -3, eqEnabled: false, bassDb: 0, trebleDb: 0,
    order: 'headroom,resample,eq',
});
const RATES = [88200, 96000, 176400, 192000, 352800, 384000, 705600, 768000];
const bounded = (value, low, high, name) => {
    if (!Number.isFinite(value) || value < low || value > high) throw new TypeError(`Invalid ${name}`);
    return value;
};

const normalizeConfig = (input = {}) => {
    const config = { ...DEFAULT_CONFIG, ...input };
    for (const key of ['exclusive', 'dspEnabled', 'resampleEnabled', 'headroomEnabled', 'eqEnabled']) {
        if (typeof config[key] !== 'boolean') throw new TypeError(`Invalid ${key}`);
    }
    if (typeof config.executable !== 'string' || !config.executable.trim() || /[\r\n\0]/.test(config.executable)) throw new TypeError('Invalid mpv executable');
    if (config.executable === 'mpv') config.executable = 'mpv.exe';
    if (/\.com$/i.test(config.executable)) throw new TypeError('Select mpv.exe, not its console wrapper mpv.com');
    if (typeof config.device !== 'string' || /[\r\n\0]/.test(config.device)) throw new TypeError('Invalid audio device');
    if (!['auto', 's32', 'float'].includes(config.outputFormat)) throw new TypeError('Invalid output format');
    if (!RATES.includes(Number(config.targetRate))) throw new TypeError('Invalid target rate');
    config.targetRate = Number(config.targetRate);
    bounded(config.headroomDb, -24, 0, 'headroom');
    bounded(config.bassDb, -12, 12, 'bass gain');
    bounded(config.trebleDb, -12, 12, 'treble gain');
    const order = String(config.order).split(',').map(name => name.trim());
    if (order.length !== 3 || new Set(order).size !== 3 || order.some(name => !['headroom', 'resample', 'eq'].includes(name))) {
        throw new TypeError('DSP order must contain headroom,resample,eq exactly once');
    }
    config.order = order.join(',');
    return config;
};

const buildDspFilters = (input) => {
    const config = normalizeConfig(input);
    if (!config.dspEnabled) return [];
    const filters = {
        headroom: config.headroomEnabled ? [`volume=${config.headroomDb}dB:precision=double`] : [],
        // 33-bit SoXR precision is a numerical design target, not an audibility claim.
        resample: config.resampleEnabled
            ? [`aresample=${config.targetRate}:resampler=soxr:precision=33:cheby=1:osf=dbl`] : [],
        eq: config.eqEnabled
            ? [`bass=g=${config.bassDb}:precision=f64`, `treble=g=${config.trebleDb}:precision=f64`] : [],
    };
    return config.order.split(',').flatMap(name => filters[name]);
};

const buildMpvArgs = (input, pipe) => {
    const config = normalizeConfig(input);
    const filters = buildDspFilters(config);
    return [
        '--no-config', '--no-video', '--no-terminal', '--idle=yes', '--pause=yes', '--load-scripts=no',
        '--keep-open=yes', '--ao=wasapi', '--audio-fallback-to-null=no',
        `--audio-exclusive=${config.exclusive ? 'yes' : 'no'}`,
        '--audio-client-name=Folia Native Audio', '--replaygain=no', '--volume=0', '--volume-max=100',
        `--input-ipc-server=${pipe}`, `--audio-device=${config.device}`,
        ...(config.outputFormat === 'auto' ? [] : [`--audio-format=${config.outputFormat}`]),
        ...(config.dspEnabled && config.resampleEnabled ? [`--audio-samplerate=${config.targetRate}`] : []),
        ...(filters.length ? [`--af=lavfi=[${filters.join(',')}]`] : []),
    ];
};

/** Require actual engine telemetry before describing an output as exclusive. */
const validateOutput = (input, params, exclusiveConfirmed, sourceRate) => {
    const config = normalizeConfig(input);
    if (!params || !Number.isFinite(params.samplerate) || typeof params.format !== 'string') throw new Error('Audio output was not initialized');
    if (config.exclusive && exclusiveConfirmed !== true) throw new Error('WASAPI Exclusive was not confirmed; shared fallback is forbidden');
    if (config.outputFormat !== 'auto' && params.format !== config.outputFormat) throw new Error('Device did not accept the requested sample format');
    if (config.dspEnabled && config.resampleEnabled) {
        if (sourceRate > config.targetRate) throw new Error('Upsampling target is below the source rate; select a higher rate or bypass resampling');
        if (params.samplerate !== config.targetRate) throw new Error('Device did not accept the requested sample rate');
    } else if (config.exclusive && sourceRate && params.samplerate !== sourceRate) {
        throw new Error('Device did not accept the source sample rate; enable explicit resampling or select another device');
    }
};

module.exports = { DEFAULT_CONFIG, RATES, normalizeConfig, buildDspFilters, buildMpvArgs, validateOutput };
