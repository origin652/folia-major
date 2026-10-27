'use strict';

const { HqConnection } = require('./connection.cjs');
const { decodeStatus, decodeVolumeRange, normalizeConfig } = require('./protocol.cjs');

// Read-only diagnostics intentionally omit registered names, fingerprints, media URIs and account data.

const inspectHqplayer = async values => {
    const connection = new HqConnection(normalizeConfig(values));
    try {
        const info = await connection.request('GetInfo');
        const license = await connection.request('GetLicense');
        const volume = decodeVolumeRange(await connection.request('VolumeRange'));
        const status = decodeStatus(await connection.request('Status', { subscribe: 0 }));
        return {
            product: info.getAttribute('product'), version: info.getAttribute('version'), engine: info.getAttribute('engine'),
            licensed: license.getAttribute('valid') === '1', variableVolume: volume.enabled,
            state: status.state, position: status.position, duration: status.duration,
            sampleRate: status.sampleRate, bits: status.bits, mode: status.mode, filter: status.filter, shaper: status.shaper,
        };
    } finally { connection.close(); }
};

module.exports = { inspectHqplayer };
