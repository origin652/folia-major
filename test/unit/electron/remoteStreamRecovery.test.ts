import http from 'node:http';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A downstream response must survive an upstream disconnect without duplicating or replacing audio bytes.
const require = createRequire(import.meta.url);
const { createSourceBridge, parseRangeHeader } = require('../../../electron/hifi/sourceBridge.cjs');
const cleanups: (() => Promise<void>)[] = [];
const bytes = Buffer.from(Array.from({ length: 196608 }, (_, i) => (i * 17 + Math.floor(i / 256)) % 251));

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const setup = async (mode = 'valid', options: { initialRange?: string; bridge?: Record<string, number> } = {}) => {
    const requests: { method: string; range?: string; ifRange?: string }[] = [];
    let broken = false, interrupt: (() => void) | undefined;
    const server = http.createServer((req, res) => {
        requests.push({ method: req.method!, range: req.headers.range,
            ifRange: typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined });
        const range = parseRangeHeader(req.headers.range, bytes.length);
        const start = range && !range.unsatisfiable ? range.start : 0;
        const end = range && !range.unsatisfiable ? range.end : bytes.length - 1;
        const retry = broken && start > 0;
        if (retry && mode === 'unavailable') { res.writeHead(503); res.end(); return; }
        const actualStart = retry && mode === 'wrong-offset' ? start + 1 : start;
        const ignored = retry && mode === 'ignored-range' || mode === 'no-range';
        const headers: Record<string, string> = { 'Content-Type': 'audio/flac',
            'Content-Length': String(ignored ? bytes.length : end - actualStart + 1),
            ETag: retry && mode === 'changed-version' ? '"v2"' : '"v1"' };
        if (mode === 'no-validator') delete headers.ETag;
        if (mode === 'no-range') headers['Accept-Ranges'] = 'bytes'; // Deliberately false upstream claim.
        if (range && !ignored) headers['Content-Range'] = `bytes ${actualStart}-${end}/${bytes.length}`;
        res.writeHead(range && !ignored ? 206 : 200, headers);
        if (req.method === 'HEAD') { res.end(); return; }
        if (!['normal', 'no-range'].includes(mode) && (!range || req.headers.range === options.initialRange) && !broken) {
            res.write(bytes.subarray(start, start + 65536));
            interrupt = () => { broken = true; if (mode !== 'stall') res.destroy(); };
        } else res.end(ignored ? bytes : bytes.subarray(actualStart, end + 1));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const logInfo = vi.fn(), logWarn = vi.fn();
    const bridge = createSourceBridge({ logInfo, logWarn, remoteRetryDelayMs: 1, remoteRetryWindowMs: 100, ...options.bridge });
    await bridge.start();
    cleanups.push(() => bridge.stop());
    const source = bridge.registerRemote({ url: `http://127.0.0.1:${(server.address() as any).port}/audio.flac`, fileName: 'audio.flac' });
    return { bridge, source, requests, logInfo, logWarn, setMode: (value: string) => { mode = value; },
        interrupt: () => { expect(interrupt).toBeTypeOf('function'); interrupt!(); } };
};

const receiveInterrupted = async (test: Awaited<ReturnType<typeof setup>>, range?: string) => {
    const response = await fetch(test.source.url, range ? { headers: { Range: range } } : undefined);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value!.length).toBeGreaterThan(0);
    test.interrupt();
    const chunks = [Buffer.from(first.value!)];
    let error = false;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            chunks.push(Buffer.from(part.value));
        }
    } catch { error = true; }
    return { response, received: Buffer.concat(chunks), error };
};

describe('remote byte continuity', () => {
    it('verifies missing Range advertisement and reports it consistently on HEAD and GET', async () => {
        const test = await setup('normal');
        const head = await fetch(test.source.url, { method: 'HEAD' });
        expect(head.headers.get('accept-ranges')).toBe('bytes');
        const body = await fetch(test.source.url);
        expect(body.headers.get('accept-ranges')).toBe('bytes');
        expect(Buffer.from(await body.arrayBuffer())).toEqual(bytes);
        expect(test.requests.some(request => request.range === 'bytes=0-0')).toBe(true);
    });

    it('keeps one downstream response alive and resumes at exactly the first missing byte', async () => {
        const test = await setup();
        const reply = await receiveInterrupted(test);
        expect(reply.error).toBe(false);
        expect(reply.response.status).toBe(200);
        expect(reply.received).toEqual(bytes);
        const resumed = test.requests.filter(request => request.range && request.range !== 'bytes=0-0');
        expect(resumed).toHaveLength(1);
        expect(Number(resumed[0].range!.match(/bytes=(\d+)/)![1])).toBeGreaterThan(0);
        expect(resumed[0].ifRange).toBe('"v1"');
        expect(test.bridge.getSourceError(test.source.token)).toBeNull();
    });

    it.each(['bytes=50000-180000', 'bytes=-100000'])('preserves the original response bounds when resuming %s', async range => {
        const test = await setup('valid', { initialRange: range });
        const reply = await receiveInterrupted(test, range);
        const bounds = parseRangeHeader(range, bytes.length);
        expect(reply.error).toBe(false);
        expect(reply.response.status).toBe(206);
        expect(reply.received).toEqual(bytes.subarray(bounds.start, bounds.end + 1));
        const resumed = test.requests.at(-1)!.range!.match(/^bytes=(\d+)-(\d+)$/)!;
        expect(Number(resumed[1])).toBeGreaterThan(bounds.start);
        expect(Number(resumed[1])).toBeLessThanOrEqual(bounds.start + 65536);
        expect(Number(resumed[2])).toBe(bounds.end);
    });

    it('does not advertise a false upstream range claim or alter its complete body', async () => {
        const test = await setup('no-range');
        const reply = await fetch(test.source.url);
        expect(reply.headers.get('accept-ranges')).toBeNull();
        expect(Buffer.from(await reply.arrayBuffer())).toEqual(bytes);
    });

    it('invalidates cached seekability if an actual nonzero request is subsequently ignored', async () => {
        const test = await setup('normal');
        expect((await fetch(test.source.url, { method: 'HEAD' })).headers.get('accept-ranges')).toBe('bytes');
        test.setMode('no-range');
        const reply = await fetch(test.source.url, { headers: { Range: 'bytes=1000-' } });
        expect(reply.status).toBe(200);
        expect(reply.headers.get('accept-ranges')).toBeNull();
        expect(Buffer.from(await reply.arrayBuffer())).toEqual(bytes);
        expect(test.bridge.getSourceInput(test.source.token)).toMatchObject({ seekable: false, rangeReadId: 0 });
    });

    it('does not splice different requests without a strong resource validator', async () => {
        const test = await setup('no-validator');
        const reply = await receiveInterrupted(test);
        expect(reply.error).toBe(true);
        expect(reply.received).toEqual(bytes.subarray(0, reply.received.length));
        expect(test.requests.every(request => !request.ifRange)).toBe(true);
        expect(test.bridge.getSourceError(test.source.token)).toBe('SOURCE_UNREACHABLE');
    });

    it('treats a silent upstream stall as a recoverable read timeout', async () => {
        const test = await setup('stall', { bridge: { remoteReadTimeoutMs: 50 } });
        const reply = await receiveInterrupted(test);
        expect(reply.error).toBe(false);
        expect(reply.received).toEqual(bytes);
        expect(test.requests.some(request => request.ifRange)).toBe(true);
    });

    it('ends an unrecovered response after its retry window instead of retrying forever', async () => {
        const test = await setup('unavailable', { bridge: { remoteRetryWindowMs: 30 } });
        const reply = await receiveInterrupted(test);
        expect(reply.error).toBe(true);
        expect(test.requests.some(request => request.ifRange)).toBe(true);
        expect(test.bridge.getSourceError(test.source.token)).toBe('SOURCE_UNREACHABLE');
    });

    it.each(['ignored-range', 'wrong-offset', 'changed-version'])('never appends an unsafe retry: %s', async mode => {
        const test = await setup(mode);
        const reply = await receiveInterrupted(test);
        expect(reply.error).toBe(true);
        expect(reply.received.length).toBeLessThan(bytes.length);
        expect(reply.received).toEqual(bytes.subarray(0, reply.received.length));
        expect(test.bridge.getSourceError(test.source.token)).toBe('SOURCE_REJECTED');
    });

    it('cancels retry work when the lease is revoked', async () => {
        const test = await setup('unavailable', { bridge: { remoteRetryWindowMs: 5000 } });
        const pending = receiveInterrupted(test);
        await vi.waitFor(() => expect(test.requests.some(request => request.ifRange)).toBe(true));
        expect(test.bridge.getSourceError(test.source.token)).toBe('SOURCE_UNREACHABLE');
        await fetch(test.source.url, { method: 'HEAD' });
        const probe = await fetch(test.source.url, { headers: { Range: 'bytes=0-0' } });
        expect((await probe.arrayBuffer()).byteLength).toBe(1);
        expect(test.bridge.getSourceError(test.source.token)).toBe('SOURCE_UNREACHABLE');
        test.bridge.revoke(test.source.token);
        expect((await pending).error).toBe(true);
        const count = test.requests.length;
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(test.requests).toHaveLength(count);
        expect(test.bridge.getSourceError(test.source.token)).toBeNull();
    });
});
