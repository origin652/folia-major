'use strict';

const { networkFailure, retryableStatus } = require('../networkFailure.cjs');
const { byteRange, sameVersion, strongEtag, identityEncoding, rejectedType, cancelBody, transportError, rejectedRange, timed, verifyRanges } = require('./ranges.cjs');

// Keep one decoder response byte-contiguous across bounded, validated upstream reconnections.
const waitForDrain = res => new Promise(resolve => {
    if (res.destroyed || res.writableEnded) { resolve(); return; }
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    res.on('drain', done); res.on('close', done);
});
const delay = (ms, signal) => new Promise(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted) done();
});

const serveRemote = async ({ entry, req, res, signal, fetchFn, observe, fail, complete, log, parseRange,
    retryDelayMs = 1000, retryWindowMs = 60000, readTimeoutMs = 15000, probeTimeoutMs = 2000, onRead = () => {} }) => {
    const attempt = () => {
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        return { controller, close: () => { signal.removeEventListener('abort', abort); controller.abort(); } };
    };
    const headers = {};
    if (typeof req.headers.range === 'string') headers.Range = req.headers.range;
    const fetchResponse = (current, method, outgoing, timeout = readTimeoutMs) => timed(fetchFn(entry.url,
        { method, headers: outgoing, credentials: 'omit', redirect: 'follow', signal: current.controller.signal }), current.controller, timeout);
    const failureMarker = {};
    entry.failedTransfers ??= new Set();
    let current = attempt(), upstream, original, range, nextByte = 0, received = 0, retrySince = null, retries = 0;
    let observer, reader;
    const markFailure = (code, retryable, error) => {
        entry.failedTransfers.add(failureMarker);
        fail(code, retryable);
        log(error);
    };
    try {
        try { upstream = await fetchResponse(current, req.method, headers); }
        catch (error) {
            if (signal.aborted) return;
            markFailure('SOURCE_UNREACHABLE', networkFailure(error), error);
            res.writeHead(502, { 'Content-Length': '0' }); res.end(); return;
        }
        if (signal.aborted) return;
        if (upstream.status >= 400) {
            markFailure('SOURCE_UNREACHABLE', retryableStatus(upstream.status), new Error(`Remote audio answered ${upstream.status}`));
            res.writeHead(upstream.status, { 'Content-Length': '0' }); res.end(); return;
        }
        range = byteRange(upstream);
        const requested = range && parseRange(req.headers.range, range.total);
        if (rejectedType(upstream) || upstream.status === 206 && (!range || !requested || requested.unsatisfiable
            || requested.start !== range.start || requested.end + 1 !== range.end)) {
            markFailure('SOURCE_REJECTED', false, rejectedRange());
            res.writeHead(502, { 'Content-Length': '0' }); res.end(); return;
        }
        original = upstream;
        nextByte = range?.start ?? 0;
        let seekable = upstream.status === 206;
        const ignoredRange = upstream.status === 200 && requested && !requested.unsatisfiable;
        if (ignoredRange) entry.verifiedRangeKey = null;
        if (seekable && strongEtag(upstream.headers.get('etag'))) entry.verifiedRangeKey = `${range.total}:${upstream.headers.get('etag')}`;
        if (!seekable && !ignoredRange && range?.total) {
            const probe = attempt();
            try { seekable = await verifyRanges({ entry, original, fetchFn, controller: probe.controller, timeoutMs: probeTimeoutMs }); }
            finally { probe.close(); }
        }
        if (signal.aborted) return;
        const forwarded = {};
        for (const name of ['content-type', 'content-length', 'content-range']) {
            const value = upstream.headers.get(name);
            if (value !== null) forwarded[name] = value;
        }
        // fetch 已经解了压缩，上游的长度对不上解出来的字节，改走分块。
        if (!identityEncoding(upstream)) delete forwarded['content-length'];
        if (seekable) forwarded['Accept-Ranges'] = 'bytes';
        res.writeHead(upstream.status, forwarded);
        const read = onRead({ start: range?.start ?? 0, end: range?.end ?? null, total: range?.total ?? null, seekable });
        if (req.method === 'HEAD' || !upstream.body) { res.end(); return; }
        const validator = original.headers.get('etag');
        const canResume = range && strongEtag(validator);
        for (;;) {
            let error = null, segmentComplete = false;
            try {
                // Optional archive observers copy bounded chunks asynchronously; their failures must not interrupt playback.
                try { observer = observe?.(upstream); }
                catch (observerError) { log(observerError); }
                reader = upstream.body.getReader();
                while (!signal.aborted) {
                    const chunk = await timed(reader.read(), current.controller, readTimeoutMs);
                    if (signal.aborted) return;
                    if (chunk.done) {
                        if (range && nextByte !== range.end) throw transportError('Remote audio ended before its declared byte length');
                        segmentComplete = true; break;
                    }
                    if (range && chunk.value.byteLength > range.end - nextByte) throw rejectedRange();
                    nextByte += chunk.value.byteLength;
                    received += chunk.value.byteLength;
                    retrySince = null;
                    try { observer?.write(chunk.value); } catch { observer = null; }
                    read?.write(chunk.value.byteLength);
                    if (!res.write(chunk.value)) await waitForDrain(res);
                }
            } catch (caught) { error = caught; }
            finally {
                try { observer?.end(segmentComplete && !signal.aborted); } catch { /* Archiving cannot interrupt playback. */ }
                observer = null;
                await reader?.cancel().catch(() => {});
                reader?.releaseLock(); reader = null;
                current.close();
            }
            // mpv 主动断开或 seek 引起的取消，不算上游的错。
            if (signal.aborted) return;
            if (segmentComplete) {
                read?.end();
                entry.failedTransfers.delete(failureMarker);
                res.once('finish', () => { if (received > 1) complete(); });
                res.end(); return;
            }
            const code = error?.sourceCode ?? 'SOURCE_UNREACHABLE';
            const retryable = code !== 'SOURCE_REJECTED' && networkFailure(error);
            markFailure(code, retryable, error);
            if (!canResume || !retryable || nextByte >= range.end) { res.destroy(); return; }
            retrySince ??= Date.now();
            for (;;) {
                const remaining = retryWindowMs - (Date.now() - retrySince);
                if (remaining <= 0) { res.destroy(); return; }
                await delay(Math.min(retryDelayMs * 2 ** Math.min(retries++, 3), remaining), signal);
                if (signal.aborted) return;
                if (Date.now() - retrySince >= retryWindowMs) { res.destroy(); return; }
                current = attempt();
                try {
                    upstream = await fetchResponse(current, 'GET', { Range: `bytes=${nextByte}-${range.end - 1}`, 'If-Range': validator },
                        Math.min(readTimeoutMs, Math.max(1, retryWindowMs - (Date.now() - retrySince))));
                    if (signal.aborted) return;
                    if (retryableStatus(upstream.status)) throw transportError(`Remote audio retry answered ${upstream.status}`);
                    const resumed = byteRange(upstream);
                    if (upstream.status !== 206 || !resumed || rejectedType(upstream) || !upstream.body
                        || resumed.start !== nextByte || resumed.end !== range.end || resumed.total !== range.total || !sameVersion(upstream, original)) throw rejectedRange();
                    break;
                } catch (caught) {
                    cancelBody(upstream); current.close();
                    if (signal.aborted) return;
                    const retry = !caught.sourceCode && networkFailure(caught);
                    markFailure(caught.sourceCode ?? 'SOURCE_UNREACHABLE', retry, caught);
                    if (!retry) { res.destroy(); return; }
                }
            }
        }
    } finally {
        entry.failedTransfers.delete(failureMarker);
        cancelBody(upstream);
        current.close();
    }
};

module.exports = { serveRemote };
