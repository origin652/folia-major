import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';

// Pausing a decoder is downstream backpressure, not an upstream network timeout.
const require = createRequire(import.meta.url);
const { serveRemote } = require('../../../electron/hifi/remoteSource/serve.cjs');
const { parseRangeHeader } = require('../../../electron/hifi/sourceBridge.cjs');
afterEach(() => vi.useRealTimers());

it('does not run a read timeout or retry while the downstream is waiting for drain', async () => {
    vi.useFakeTimers();
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (pulls < 2) controller.enqueue(new Uint8Array([++pulls]));
        else controller.close();
    } }, { highWaterMark: 0 });
    const fetchFn = vi.fn(async () => new Response(body, { status: 206,
        headers: { 'Content-Length': '2', 'Content-Range': 'bytes 0-1/2', ETag: '"same"' } }));
    const res = Object.assign(new EventEmitter(), {
        writeHead: vi.fn(), write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
        destroy: vi.fn(), end: vi.fn(() => res.emit('finish')),
    });
    const fail = vi.fn(), complete = vi.fn();
    const work = serveRemote({ entry: { url: 'https://synthetic.test/audio' }, req: { method: 'GET', headers: { range: 'bytes=0-1' } },
        res, signal: new AbortController().signal, fetchFn, fail, complete, log: vi.fn(), parseRange: parseRangeHeader, readTimeoutMs: 20 });
    for (let i = 0; i < 25; i++) await Promise.resolve();
    expect(res.write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2000);
    expect(pulls).toBe(1);
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(fail).not.toHaveBeenCalled();
    res.emit('drain');
    await work;
    expect(complete).toHaveBeenCalledOnce();
    expect(res.destroy).not.toHaveBeenCalled();
});
