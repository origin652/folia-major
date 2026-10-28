'use strict';

const { networkFailure, retryableStatus } = require('../hifi/networkFailure.cjs');

// Owner-scoped transfer counters and cancellable one-byte readiness checks; never return media URLs.
const createStreamHealth = ({ fetchFn, now = Date.now, probeTimeoutMs = 8000 }) => {
    const entries = new Map();
    const add = (id, url) => entries.set(id, { url, bytes: 0, chunks: [], failure: null, probe: null });
    const cancel = id => entries.get(id)?.probe?.abort();
    const remove = id => { cancel(id); entries.delete(id); };
    const fail = (id, failure) => { const entry = entries.get(id); if (entry) entry.failure = failure; };
    const clear = id => { const entry = entries.get(id); if (entry) entry.failure = null; };
    const observe = id => ({
        write: chunk => {
            const entry = entries.get(id);
            if (!entry) return;
            const at = now();
            entry.bytes += chunk.byteLength;
            const bucket = Math.floor(at / 250) * 250;
            const last = entry.chunks.at(-1);
            if (last?.at === bucket) last.bytes += chunk.byteLength;
            else entry.chunks.push({ at: bucket, bytes: chunk.byteLength });
            entry.chunks = entry.chunks.filter(item => item.at > at - 2000);
        },
        end: () => {},
    });
    const read = id => {
        const entry = entries.get(id);
        if (!entry) return null;
        entry.chunks = entry.chunks.filter(item => item.at > now() - 2000);
        return { receivedBytes: entry.bytes, bytesPerSecond: entry.chunks.reduce((sum, item) => sum + item.bytes, 0) / 2,
            failure: entry.failure ? { ...entry.failure } : null };
    };
    const probe = async id => {
        const entry = entries.get(id);
        if (!entry) return { ready: false, retryable: false };
        if (entry.probe) return { ready: false, retryable: true };
        const controller = new AbortController();
        entry.probe = controller;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, probeTimeoutMs);
        let reader;
        try {
            const response = await fetchFn(entry.url, { method: 'GET', headers: { Range: 'bytes=0-0' },
                credentials: 'omit', redirect: 'follow', signal: controller.signal });
            if (response.status >= 400 || /json|xml|html/i.test(response.headers.get('content-type') || '') || !response.body) {
                await response.body?.cancel();
                return { ready: false, retryable: retryableStatus(response.status) };
            }
            reader = response.body.getReader();
            const chunk = await reader.read();
            const ready = !controller.signal.aborted && !chunk.done && chunk.value.byteLength > 0;
            return { ready, retryable: ready };
        } catch (error) {
            return { ready: false, retryable: timedOut || !controller.signal.aborted && networkFailure(error) };
        } finally {
            clearTimeout(timer);
            controller.abort();
            try { await reader?.cancel(); } catch { /* The upstream may already be disconnected. */ }
            if (entry.probe === controller) entry.probe = null;
        }
    };
    return { add, remove, fail, clear, observe, read, probe, cancel };
};
module.exports = { createStreamHealth };
