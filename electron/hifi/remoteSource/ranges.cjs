'use strict';

// Byte identity and range checks for remote transport, independent of any player or music provider.
// Navidrome 出错时常回 200 加 Subsonic 的 JSON / XML 错误体，代理或登录页回 HTML：都不是音频。
const rejectedType = response => /json|xml|html/i.test(response.headers.get('content-type') || '');
const identityEncoding = response => !response.headers.get('content-encoding')
    || response.headers.get('content-encoding').toLowerCase() === 'identity';
const strongEtag = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
const byteRange = response => {
    if (!identityEncoding(response)) return null;
    const text = response.headers.get('content-length');
    const length = text !== null && /^\d+$/.test(text) ? Number(text) : NaN;
    const validLength = Number.isSafeInteger(length) && length >= 0;
    if (response.status === 200) return validLength ? { start: 0, end: length, total: length } : null;
    const match = response.status === 206 && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!match) return null;
    const [start, last, total] = match.slice(1).map(Number);
    return [start, last, total].every(Number.isSafeInteger) && start <= last && last < total
        && (text === null || validLength && last - start + 1 === length)
        ? { start, end: last + 1, total } : null;
};
const sameVersion = (response, original) => response.headers.get('etag') === original.headers.get('etag')
    && (strongEtag(original.headers.get('etag')) || response.headers.get('last-modified') === original.headers.get('last-modified'));
const cancelBody = response => {
    try { response?.body?.cancel().catch(() => {}); }
    catch {
        // body 已被读过或已锁住，没有可释放的
    }
};
const transportError = message => Object.assign(new Error(message), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
const rejectedRange = () => Object.assign(new Error('Remote audio byte range or content version changed'), { sourceCode: 'SOURCE_REJECTED' });

// Time only upstream work, never downstream backpressure (e.g. a paused decoder).
const timed = (promise, controller, timeoutMs) => new Promise((resolve, reject) => {
    const signal = controller.signal;
    const aborted = () => { cleanup(); reject(signal.reason ?? new Error('Remote request cancelled')); };
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Remote audio read timed out'), { code: 'UND_ERR_BODY_TIMEOUT' })), timeoutMs);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
});

// A successful tiny GET proves the missing advertisement; an upstream claim alone is not proof.
const verifyRanges = async ({ entry, original, fetchFn, controller, timeoutMs }) => {
    const range = byteRange(original);
    if (!range || !range.total) return false;
    const key = strongEtag(original.headers.get('etag')) ? `${range.total}:${original.headers.get('etag')}` : null;
    if (key && entry.verifiedRangeKey === key) return true;
    const deadline = Date.now() + timeoutMs;
    const wait = promise => timed(promise, controller, Math.max(1, deadline - Date.now()));
    let response, reader;
    try {
        response = await wait(fetchFn(entry.url, { method: 'GET', headers: { Range: 'bytes=0-0' },
            credentials: 'omit', redirect: 'follow', signal: controller.signal }));
        const part = byteRange(response);
        if (response.status !== 206 || rejectedType(response) || !part || part.start !== 0 || part.end !== 1
            || part.total !== range.total || !sameVersion(response, original) || !response.body) return false;
        reader = response.body.getReader();
        const first = await wait(reader.read());
        const end = await wait(reader.read());
        if (first.done || first.value.byteLength !== 1 || !end.done) return false;
        if (key) entry.verifiedRangeKey = key;
        return true;
    } catch { return false; }
    finally {
        if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        else cancelBody(response);
    }
};

module.exports = { byteRange, sameVersion, strongEtag, identityEncoding, rejectedType, cancelBody, transportError, rejectedRange, timed, verifyRanges };
