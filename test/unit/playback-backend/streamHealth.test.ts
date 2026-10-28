import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Only audio transfer bytes count as speed; probes are bounded, anonymous and owner-revocable.
const require = createRequire(import.meta.url);
const { createStreamHealth } = require('../../../electron/playbackBackends/streamHealth.cjs');
const { networkFailure, retryableStatus } = require('../../../electron/hifi/networkFailure.cjs');

describe('stream health', () => {
    it('counts actual bytes, aggregates a bounded two-second window and decays to zero', () => {
        let now = 0;
        const health = createStreamHealth({ fetchFn: vi.fn(), now: () => now });
        health.add('id', 'https://synthetic.test/audio?token=private');
        health.observe('id').write(new Uint8Array(4096));
        expect(health.read('id')).toMatchObject({ receivedBytes: 4096, bytesPerSecond: 2048 });
        now = 2500;
        expect(health.read('id')).toMatchObject({ receivedBytes: 4096, bytesPerSecond: 0 });
        expect(JSON.stringify(health.read('id'))).not.toContain('private');
        health.remove('id'); expect(health.read('id')).toBeNull();
    });
    it('reads only the first chunk and cancels even when the server ignores Range', async () => {
        const cancel = vi.fn();
        const fetchFn = vi.fn(async (_url: string, _init: RequestInit) => new Response(new ReadableStream({
            start: controller => controller.enqueue(new Uint8Array([1])), cancel,
        }), { headers: { 'Content-Type': 'audio/flac' } }));
        const health = createStreamHealth({ fetchFn }); health.add('id', 'https://synthetic.test/audio');
        expect(await health.probe('id')).toEqual({ ready: true, retryable: true });
        expect(fetchFn.mock.calls[0][1]).toMatchObject({ credentials: 'omit', headers: { Range: 'bytes=0-0' } });
        expect(cancel).toHaveBeenCalledOnce();
        expect(health.read('id').receivedBytes).toBe(0);
    });
    it.each([401, 403, 404, 416, 500, 503, 408, 429])('classifies HTTP %s even with an HTML error page', async status => {
        const health = createStreamHealth({ fetchFn: async () => new Response('failure', { status, headers: { 'Content-Type': 'text/html' } }) });
        health.add('id', 'https://synthetic.test/audio');
        expect(await health.probe('id')).toEqual({ ready: false, retryable: retryableStatus(status) });
    });
    it('aborts probes on retirement and treats a timeout as transient', async () => {
        vi.useFakeTimers();
        try {
            let signal!: AbortSignal;
            const health = createStreamHealth({ probeTimeoutMs: 100, fetchFn: (_url: string, init: RequestInit) => {
                signal = init.signal!;
                return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
            } });
            health.add('id', 'https://synthetic.test/audio');
            const pending = health.probe('id');
            health.remove('id'); expect(signal.aborted).toBe(true);
            expect(await pending).toEqual({ ready: false, retryable: false });
            health.add('id', 'https://synthetic.test/audio');
            const timeout = health.probe('id'); await vi.advanceTimersByTimeAsync(100);
            expect(await timeout).toEqual({ ready: false, retryable: true });
        } finally { vi.useRealTimers(); }
    });
    it('recognizes Chromium and nested undici failures, never generic media/device errors', () => {
        for (const error of [new Error('net::ERR_INTERNET_DISCONNECTED'), new Error('net::ERR_CONTENT_LENGTH_MISMATCH'),
            { cause: { code: 'UND_ERR_SOCKET' } }, { code: 'ECONNRESET' }]) {
            expect(networkFailure(error)).toBe(true);
        }
        for (const message of ['unsupported format', 'device refused', 'license expired', 'fetch failed', 'net::ERR_CERT_DATE_INVALID']) {
            expect(networkFailure(new Error(message))).toBe(false);
        }
    });
});
