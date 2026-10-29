'use strict';

const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { decodeStatus } = require('./protocol.cjs');

// Reconnect control only: never replay a command or replace the independent audio input.
const cancelled = () => Object.assign(new Error('HQPlayer control recovery cancelled'), { code: 'HQP_CANCELLED' });
const ownershipError = () => Object.assign(new Error('HQPlayer source changed or could not be verified; refusing control recovery'), { code: 'HQP_OWNERSHIP' });
const sourceKey = uri => {
    if (/^file:/i.test(uri)) uri = fileURLToPath(uri);
    return path.win32.isAbsolute(uri) ? path.win32.normalize(uri).toLowerCase() : uri;
};
const wait = (ms, signal) => new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(cancelled()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
});

const recoverControl = async ({ connect, config, uri, trackId, signal, timeoutMs = 30000 }) => {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
        if (signal.aborted) throw cancelled();
        if (attempt) await wait(Math.min(1000 * 2 ** Math.min(attempt - 1, 3), deadline - Date.now()), signal);
        if (signal.aborted) throw cancelled();
        const candidate = connect(config);
        const abort = () => candidate.close();
        signal.addEventListener('abort', abort, { once: true });
        let adopted = false;
        try {
            const request = (name, attrs) => {
                const remaining = deadline - Date.now();
                if (remaining <= 0) throw new Error('HQPlayer control recovery timed out');
                return candidate.request(name, attrs, Math.min(5000, remaining));
            };
            const info = await request('GetInfo');
            if (!/HQPlayer/.test(info.getAttribute('product') || '')) throw ownershipError();
            const before = decodeStatus(await request('Status', { subscribe: 0 }));
            // STOPREQ can temporarily hide the transport. Wait, without loading or starting it.
            if (before.state === 'loading' && before.tracks === 0) throw new Error('HQPlayer transport is still changing');
            const playlist = await request('PlaylistGet', { picture: 0 });
            const items = Array.from(playlist.getElementsByTagName('PlaylistItem'));
            const status = decodeStatus(await request('Status', { subscribe: 0 }));
            if (before.tracks !== 1 || status.tracks !== 1 || items.length !== 1
                || sourceKey(items[0].getAttribute('uri') || '') !== sourceKey(uri)
                || before.trackId !== status.trackId || (trackId && status.trackId !== trackId)) throw ownershipError();
            if (signal.aborted) throw cancelled();
            adopted = true;
            return { connection: candidate, status };
        } catch (error) {
            if (signal.aborted) throw cancelled();
            if (error.code === 'HQP_OWNERSHIP') throw error;
            lastError = error;
        } finally {
            signal.removeEventListener('abort', abort);
            if (!adopted) candidate.close();
        }
    }
    throw new Error('HQPlayer control recovery timed out; playback state is unknown', { cause: lastError });
};

module.exports = { recoverControl };
