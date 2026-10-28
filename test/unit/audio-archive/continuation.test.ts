import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Continuation uses synthetic byte ranges and isolated roots, with no provider account or audio device.
const require = createRequire(import.meta.url);
const { createAudioArchive } = require('../../../electron/audioArchive/service.cjs');
const { createPlaybackStreams } = require('../../../electron/playbackBackends/streams.cjs');
const { createCompletion } = require('../../../electron/audioArchive/completion.cjs');
const fixtures: { archive: any; store: any; root: string }[] = [];
const context = { songKey: 'online:test:continued', quality: 'lossless', title: 'Continued', artist: 'Test', durationMs: 1000,
    preview: false, collection: null };
const audio = () => {
    const bytes = Buffer.alloc(16044);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16000, 40);
    for (let i = 44; i < bytes.length; i++) bytes[i] = i % 251;
    return bytes;
};
const part = (data: Buffer, start: number, end: number, etag = '"same-version"') => new Response(new Uint8Array(data.subarray(start, end)), {
    status: 206, headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(end - start),
        'Content-Range': `bytes ${start}-${end - 1}/${data.length}`, ETag: etag },
});
const setup = async (fetchFn: any) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-continue-test-'));
    let settings = {};
    const log = vi.fn();
    const archive = createAudioArchive({ readSettings: () => settings, writeSettings: (next: object) => { settings = next; }, log });
    const store = createPlaybackStreams({ archive, fetchFn, logInfo: vi.fn(), logWarn: vi.fn() });
    fixtures.push({ archive, store, root });
    await archive.choose(root); archive.configure({ enabled: true });
    return { root, archive, store, log };
};
const seed = async (capture: any, response: Response) => {
    const sink = capture.response(response);
    expect(sink).not.toBeNull();
    await sink.write(Buffer.from(await response.arrayBuffer())); sink.end(true);
    await capture.drain();
};
const saved = (archive: any) => vi.waitFor(() => expect(archive.settings().savedCount).toBe(1));
afterEach(async () => {
    for (const { store, archive, root } of fixtures.splice(0)) {
        await store.dispose(); await archive.dispose(); await fs.rm(root, { recursive: true, force: true });
    }
});

describe('80% background completion', () => {
    it('aborts an unresponsive supplement at its deadline', async () => {
        vi.useFakeTimers();
        let signal!: AbortSignal;
        const onSettled = vi.fn();
        const completion = createCompletion({ url: 'https://cdn.test/test.wav', log: vi.fn(), onSettled, timeoutMs: 100,
            capture: { snapshot: async () => ({ total: 100, ranges: [[0, 80]], validator: '"same"', transfers: 0 }) },
            fetchFn: (_url: string, options: RequestInit) => {
                signal = options.signal!;
                return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
            },
        });
        try {
            completion.retain(); await Promise.resolve();
            await vi.advanceTimersByTimeAsync(100); await completion.drain();
            expect(signal.aborted).toBe(true); expect(onSettled).toHaveBeenCalledOnce();
        } finally { completion.cancel(); vi.useRealTimers(); }
    });
    it('keeps the saved prefix, fetches only the tail once, and finishes after playback release', async () => {
        const bytes = audio(), prefix = 12000;
        let finish!: () => void;
        const gate = new Promise<void>(resolve => { finish = resolve; });
        const fetchFn = vi.fn(async (_url: string, options: RequestInit) => {
            const headers = new Headers(options.headers);
            if (!headers.has('if-range')) return part(bytes, 0, prefix);
            await gate; return part(bytes, prefix, bytes.length);
        });
        const { archive, store } = await setup(fetchFn);
        const lease = await store.create('https://cdn.test/audio.wav?vkey=private', 7, context);
        expect(Buffer.from(await (await fetch(lease.url, { headers: { Range: `bytes=0-${prefix - 1}` } })).arrayBuffer())).toEqual(bytes.subarray(0, prefix));
        store.markPlayed(lease.id, 7);
        store.progress(lease.id, 8, 1); store.progress(lease.id, 7, NaN); store.progress(lease.id, 7, 0.799);
        await new Promise(resolve => setImmediate(resolve)); expect(fetchFn).toHaveBeenCalledTimes(1);
        store.progress(lease.id, 7, 0.8); store.progress(lease.id, 7, 0.99);
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
        expect(fetchFn.mock.calls[1][1]).toMatchObject({ method: 'GET', credentials: 'omit', headers: {
            Range: `bytes=${prefix}-${bytes.length - 1}`, 'If-Range': '"same-version"',
        } });
        store.release(lease.id, 7);
        expect((await fetch(lease.url)).status).toBe(404); expect(archive.settings().savedCount).toBe(0);
        finish(); await saved(archive);
        const local = await archive.find(context, 7);
        expect(Buffer.from(await (await archive.response(new Request(local.url))).arrayBuffer())).toEqual(bytes);
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
    it('fills multiple missing intervals without fetching any already saved interval', async () => {
        const bytes = audio();
        const fetchFn = vi.fn(async (_url: string, options: RequestInit) => {
            const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(options.headers).get('range')!)!;
            return part(bytes, Number(range[1]), Number(range[2]) + 1);
        });
        const { archive } = await setup(fetchFn);
        const capture = archive.capture(context, { url: 'https://cdn.test/a.wav', fetchFn, ownerId: 7 });
        await seed(capture, part(bytes, 0, 4000)); await seed(capture, part(bytes, 8000, 12000));
        capture.played(); capture.progress(0.8); capture.retire(); await saved(archive);
        expect(fetchFn.mock.calls.map(call => new Headers(call[1].headers).get('range'))).toEqual(['bytes=4000-7999', 'bytes=12000-16043']);
    });
    it('reuses the bytes written before a playback connection was aborted', async () => {
        const bytes = audio(), prefix = 13000;
        const fetchFn = vi.fn(async (_url: string, _options: RequestInit) => part(bytes, prefix, bytes.length));
        const { archive } = await setup(fetchFn);
        const capture = archive.capture(context, { url: 'https://cdn.test/a.wav', fetchFn, ownerId: 7 });
        const sink = capture.response(new Response(null, { headers: {
            'Content-Length': String(bytes.length), ETag: '"same-version"', 'Content-Type': 'audio/wav',
        } }));
        await sink.write(bytes.subarray(0, prefix));
        capture.played(); capture.progress(0.8); capture.retire();
        expect(fetchFn).not.toHaveBeenCalled(); sink.end(false);
        await saved(archive);
        expect(new Headers(fetchFn.mock.calls[0][1].headers).get('range')).toBe(`bytes=${prefix}-${bytes.length - 1}`);
    });
    it.each(['no-etag', 'weak-etag', 'unplayed', 'below-threshold'])('does not supplement %s audio', async mode => {
        const bytes = audio(), fetchFn = vi.fn(); const { archive } = await setup(fetchFn);
        const capture = archive.capture(context, { url: 'https://cdn.test/a.wav', fetchFn, ownerId: 7 });
        if (mode === 'no-etag' || mode === 'weak-etag') {
            const sink = capture.response(new Response(null, { headers: {
                'Content-Length': String(bytes.length), ...(mode === 'weak-etag' ? { ETag: 'W/"same-version"' } : {}),
            } }));
            await sink.write(bytes.subarray(0, 12000)); sink.end(false);
        } else await seed(capture, part(bytes, 0, 12000));
        if (mode !== 'unplayed') capture.played();
        capture.progress(mode === 'below-threshold' ? 0.799 : 0.8); capture.retire(); await capture.drain();
        expect(fetchFn).not.toHaveBeenCalled(); expect(archive.settings().savedCount).toBe(0);
    });
    it.each(['version', 'range', 'ignored-range', 'network'])('never publishes mismatched %s completion', async mode => {
        const bytes = audio();
        const fetchFn = vi.fn(async () => {
            if (mode === 'network') throw new Error('network https://cdn.test/private?vkey=secret');
            if (mode === 'ignored-range') return new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } });
            return part(bytes, mode === 'range' ? 11999 : 12000, bytes.length, mode === 'version' ? '"changed"' : '"same-version"');
        });
        const { archive, log } = await setup(fetchFn);
        const capture = archive.capture(context, { url: 'https://cdn.test/a.wav?vkey=secret', fetchFn, ownerId: 7 });
        await seed(capture, part(bytes, 0, 12000)); capture.played(); capture.progress(0.8); capture.retire();
        await capture.drain(); expect(fetchFn).toHaveBeenCalledOnce();
        expect(archive.settings().savedCount).toBe(0); expect(await archive.find(context, 7)).toBeNull();
        expect(log.mock.calls.flat().map(value => value instanceof Error ? value.stack : String(value)).join('\n')).not.toContain('secret');
    });
    it.each(['disabled', 'owner', 'dispose', 'directory'])('cancels detached work on %s', async mode => {
        const bytes = audio(); let signal!: AbortSignal;
        const fetchFn = vi.fn((_url: string, options: RequestInit) => {
            signal = options.signal!;
            return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        });
        const { archive, root } = await setup(fetchFn);
        const capture = archive.capture(context, { url: 'https://cdn.test/a.wav', fetchFn, ownerId: 7 });
        await seed(capture, part(bytes, 0, 12000)); capture.played(); capture.progress(0.8); capture.retire();
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
        if (mode === 'disabled') archive.configure({ enabled: false });
        if (mode === 'owner') archive.releaseOwner(7);
        if (mode === 'dispose') await archive.dispose();
        if (mode === 'directory') await archive.choose(root);
        await capture.drain(); expect(signal.aborted).toBe(true); expect(archive.settings().savedCount).toBe(0);
        expect(await fs.readdir(path.join(root, '.folia-partials'))).toEqual([]);
    });
});
