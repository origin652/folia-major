'use strict';

const { responseRange, isStrongEtag } = require('./model.cjs');
const { redactRemoteError } = require('../hifi/sourceBridge.cjs');

// Complete only holes in this session's strong-ETag byte map; never restart a whole song or refresh a provider URL.
const createCompletion = ({ capture, url, fetchFn, log, onSettled, timeoutMs = 120000 }) => {
    let retained = false, cancelled = false, settled = false, running = null, again = false;
    const controller = new AbortController();
    let timer;
    const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        onSettled();
    };
    const fill = async () => {
        for (let requests = 0; ; requests++) {
            const state = await capture.snapshot();
            if (cancelled) return;
            if (state.transfers) return;
            if (state.failed || state.finalized || !state.total || !isStrongEtag(state.validator) || typeof fetchFn !== 'function') {
                finish(); return;
            }
            let start = 0, end = state.total;
            for (const [first, last] of state.ranges) {
                if (first > start) { end = first; break; }
                start = Math.max(start, last);
            }
            if (start >= end) { finish(); return; }
            if (requests >= 64) throw new Error('Archive continuation exceeded its request limit');
            timer ??= setTimeout(() => controller.abort(), timeoutMs);
            const response = await fetchFn(url, { method: 'GET', credentials: 'omit', redirect: 'follow', signal: controller.signal,
                headers: { Range: `bytes=${start}-${end - 1}`, 'If-Range': state.validator } });
            const range = responseRange(response);
            // A CDN ignoring Range/If-Range, returning a new version or an error must not replace the saved prefix.
            if (cancelled || response.status !== 206 || !range || range.start !== start || range.end !== end
                || range.total !== state.total || range.etag !== state.validator || !response.body) {
                await response.body?.cancel();
                throw new Error('Archive continuation rejected: content version or byte range did not match');
            }
            const sink = capture.response(response);
            if (!sink) { await response.body.cancel(); finish(); return; }
            const reader = response.body.getReader();
            let complete = false;
            try {
                while (!cancelled) {
                    const { done, value } = await reader.read();
                    if (done) { complete = true; break; }
                    await sink.write(value);
                    if ((await capture.snapshot()).failed) throw new Error('Archive continuation disk write failed');
                }
            } finally {
                if (!complete) await reader.cancel().catch(() => {});
                reader.releaseLock();
                sink.end(complete);
            }
        }
    };
    const kick = () => {
        if (!retained || cancelled || settled) return;
        if (running) { again = true; return; }
        running = fill().catch(error => {
            if (!cancelled) log('Archive continuation stopped; incomplete audio was not published', redactRemoteError(error, url));
            finish();
        }).finally(() => {
            running = null;
            if (again) { again = false; kick(); }
        });
    };
    return {
        retain: () => { retained = true; kick(); },
        kick,
        isSettled: () => settled,
        cancel: () => { cancelled = true; clearTimeout(timer); controller.abort(); },
        drain: async () => { await running; },
    };
};

module.exports = { createCompletion };
