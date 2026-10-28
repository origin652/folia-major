import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Synthetic WAVs and disposable roots exercise real disk capture; no account, player or user archive is accessed.
const require = createRequire(import.meta.url);
const { createAudioArchive } = require('../../../electron/audioArchive/service.cjs');
const { createPlaybackStreams } = require('../../../electron/playbackBackends/streams.cjs');
const { archiveKey, normalizeContext, cleanName } = require('../../../electron/audioArchive/model.cjs');
const roots: string[] = [];
const services: any[] = [];
const stores: any[] = [];
const context = { songKey: 'online:test:42', quality: 'lossless', title: 'Song / title', artist: 'Artist', durationMs: 1000,
    preview: false, collection: { id: 'online:test:playlist:7', name: '../My playlist' } };
const wav = () => {
    const data = Buffer.alloc(16044);
    data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
    data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
    data.writeUInt32LE(8000, 24); data.writeUInt32LE(16000, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
    data.write('data', 36); data.writeUInt32LE(16000, 40);
    return data;
};
const setup = async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'folia-archive-test-')); roots.push(root);
    let settings = {};
    const log = vi.fn();
    const archive = createAudioArchive({ readSettings: () => settings, writeSettings: (next: object) => { settings = next; }, log });
    services.push(archive);
    await archive.choose(root); archive.configure({ enabled: true });
    return { root, archive, log };
};
const send = async (capture: any, data: Buffer, options: { start?: number; end?: number; etag?: string; total?: number; success?: boolean } = {}) => {
    const start = options.start ?? 0, end = options.end ?? data.length, total = options.total ?? data.length;
    const partial = start !== 0 || end !== total;
    const response = new Response(null, { status: partial ? 206 : 200, headers: {
        'Content-Length': String(end - start), 'Content-Type': 'audio/wav',
        ...(partial ? { 'Content-Range': `bytes ${start}-${end - 1}/${total}` } : {}),
        ...(options.etag ? { ETag: options.etag } : {}),
    } });
    const sink = capture.response(response);
    sink?.write(data.subarray(start, end)); sink?.end(options.success !== false);
    return sink;
};
const saved = (archive: any) => vi.waitFor(() => expect(archive.settings().savedCount).toBe(1));

afterEach(async () => {
    await Promise.all(stores.splice(0).map(store => store.dispose()));
    await Promise.all(services.splice(0).map(service => service.dispose()));
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('played audio archive', () => {
    it('is opt-in, rejects previews and snapshots metadata without URLs or credentials', async () => {
        const { archive, root } = await setup();
        archive.configure({ enabled: false });
        expect(archive.capture(context)).toBeNull();
        archive.configure({ enabled: true });
        expect(archive.capture({ ...context, preview: true })).toBeNull();
        expect(normalizeContext({ ...context, url: 'secret', cookie: 'secret' })).not.toHaveProperty('url');
        expect(cleanName('CON.txt')).toBe('_CON.txt');
        const capture = archive.capture(context);
        await send(capture, wav());
        capture.retire(); await archive.dispose();
        expect(archive.settings().savedCount).toBe(0);
        expect(await fs.readdir(root)).not.toContain('.folia-index');
    });
    it('saves only complete played audio and reuses it with Range/HEAD without requesting a provider', async () => {
        const { archive, root } = await setup();
        const capture = archive.capture(context), data = wav();
        await send(capture, data); capture.played(); await saved(archive);
        const index = JSON.parse(await fs.readFile(path.join(root, '.folia-index', `${archiveKey(context)}.json`), 'utf8'));
        expect(index.relative).toContain('My playlist');
        expect(index.relative).not.toContain('..' + path.sep);
        expect(await fs.readFile(path.join(root, index.relative))).toEqual(data);
        const local = await archive.find(context, 7);
        expect(local.url).toMatch(/^folia-archive:\/\/audio\/[a-f0-9]{32}\/audio\.wav$/);
        const response = await archive.response(new Request(local.url, { headers: { Range: 'bytes=4-7' } }));
        expect(response.status).toBe(206); expect(Buffer.from(await response.arrayBuffer())).toEqual(data.subarray(4, 8));
        const head = await archive.response(new Request(local.url, { method: 'HEAD' }));
        expect(head.headers.get('content-length')).toBe(String(data.length)); expect(await head.text()).toBe('');
        expect(await archive.find({ ...context, quality: 'high' }, 7)).toBeNull();
        expect(await archive.find({ ...context, songKey: 'online:other:42' }, 7)).toBeNull();
        archive.releaseOwner(7);
        expect((await archive.response(new Request(local.url))).status).toBe(404);
    });
    it('joins strong-validator ranges by byte offset, including duplicate and out-of-order reads', async () => {
        const { archive } = await setup(); const capture = archive.capture(context), data = wav();
        capture.played();
        await send(capture, data, { start: 8000, etag: '"version1"' });
        await send(capture, data, { start: 8000, etag: '"version1"' });
        expect(archive.settings().savedCount).toBe(0);
        await send(capture, data, { end: 8000, etag: '"version1"' });
        await saved(archive); expect(await archive.find(context, 7)).not.toBeNull();
    });
    it.each(['missing-validator', 'changed-validator', 'incomplete', 'aborted', 'preview-length', 'unknown-length'])('never publishes %s as a whole song', async mode => {
        const { archive } = await setup(); const capture = archive.capture(context), data = wav();
        capture.played();
        if (mode === 'unknown-length') expect(capture.response(new Response(data))).toBeNull();
        else if (mode === 'preview-length') {
            const clip = wav().subarray(0, 1644); clip.writeUInt32LE(clip.length - 8, 4); clip.writeUInt32LE(1600, 40);
            await send(capture, clip);
        } else {
            await send(capture, data, { end: 8000, etag: mode === 'missing-validator' ? undefined : '"one"', success: mode !== 'aborted' });
            if (mode === 'changed-validator') await send(capture, data, { start: 8000, etag: '"two"' });
        }
        capture.retire(); await archive.dispose();
        expect(archive.settings().savedCount).toBe(0); expect(await archive.find(context, 7)).toBeNull();
    });
    it('falls back for corrupted files and rejects path traversal in an edited index', async () => {
        const { archive, root } = await setup(); const capture = archive.capture(context);
        await send(capture, wav()); capture.played(); await saved(archive);
        const indexPath = path.join(root, '.folia-index', `${archiveKey(context)}.json`);
        const entry = JSON.parse(await fs.readFile(indexPath, 'utf8'));
        const file = path.join(root, entry.relative);
        const data = await fs.readFile(file); data[data.length - 1] ^= 1; await fs.writeFile(file, data);
        expect(await archive.find(context, 7)).toBeNull();
        await fs.writeFile(indexPath, JSON.stringify({ ...entry, relative: '../outside.wav' }));
        expect(await archive.find(context, 7)).toBeNull();
    });
    it('captures exactly the one upstream playback transfer without delaying its first byte', async () => {
        const { archive } = await setup(); const data = wav(); let finish!: () => void;
        const fetchFn = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
            controller.enqueue(data.subarray(0, 44));
            finish = () => { controller.enqueue(data.subarray(44)); controller.close(); };
        } }), { headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(data.length) } }));
        const store = createPlaybackStreams({ archive, fetchFn, logInfo: vi.fn(), logWarn: vi.fn() }); stores.push(store);
        const lease = await store.create('https://synthetic.test/a.wav?token=must-not-be-saved', 7, context);
        const response = await fetch(lease.url), reader = response.body!.getReader();
        expect((await reader.read()).value).toEqual(new Uint8Array(data.subarray(0, 44)));
        expect(archive.settings().savedCount).toBe(0); store.markPlayed(lease.id, 7); finish();
        while (!(await reader.read()).done) { /* Consume the rest of the same request. */ }
        await saved(archive); expect(fetchFn).toHaveBeenCalledTimes(1);
        expect(await archive.find(context, 7)).not.toBeNull(); expect(fetchFn).toHaveBeenCalledTimes(1);
    });
});
