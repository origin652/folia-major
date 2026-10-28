import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareBackendSource } from '../../../src/services/playbackBackend/source';

// Mods see a lease, never the signed provider URL; staging remains available for file-only backends.
afterEach(() => vi.unstubAllGlobals());

describe('backend media preparation', () => {
    it('passes archive context only to the host and marks a playing lease once, never on prepare', async () => {
        const context = { songKey: 'online:test:1', quality: 'lossless', title: 'Title', artist: 'Artist', durationMs: 1000, preview: false as const, collection: null };
        const bridge = { stream: vi.fn(async () => ({ id: 'ticket', url: 'http://127.0.0.1:1/audio' })), markPlayed: vi.fn(async () => {}), release: vi.fn(async () => {}) };
        vi.stubGlobal('window', { electron: { playbackSources: bridge } });
        const prepared = await prepareBackendSource('https://test/song.wav', 'source', true, context);
        expect(bridge.stream).toHaveBeenCalledWith('https://test/song.wav', context);
        expect(prepared.source).not.toHaveProperty('title'); expect(bridge.markPlayed).not.toHaveBeenCalled();
        prepared.markPlayed?.(); prepared.markPlayed?.();
        expect(bridge.markPlayed).toHaveBeenCalledOnce();
        await prepared.release();
    });
    it('leases an authenticated HTTP or host protocol without reading the response body', async () => {
        const url = `http://127.0.0.1:12345/${'b'.repeat(32)}/audio.flac`;
        const bridge = { stream: vi.fn(async () => ({ id: 'lease', url })),
            streamError: vi.fn(async () => null), release: vi.fn(async () => {}), stage: vi.fn() };
        vi.stubGlobal('window', { electron: { playbackSources: bridge } });
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);
        for (const upstream of ['https://cdn.test/song.flac?vkey=private', 'folia-test://audio/authorized']) {
            const prepared = await prepareBackendSource(upstream, 'source-1', true);
            expect(prepared.source).toEqual({ sourceId: 'source-1', url });
            expect(JSON.stringify(prepared.source)).not.toContain('private');
            expect(bridge.stream).toHaveBeenLastCalledWith(upstream);
            expect(await prepared.getError?.()).toBeNull();
            await prepared.release();
            expect(bridge.release).toHaveBeenLastCalledWith('lease');
        }
        expect(fetch).not.toHaveBeenCalled();
        expect(bridge.stage).not.toHaveBeenCalled();
    });
    it('retains exact complete bytes for a blob or a file-only backend', async () => {
        const bridge = { stream: vi.fn(), stage: vi.fn(async (_data: ArrayBuffer) => ({ id: 'file', filePath: '/host/song.audio' })),
            release: vi.fn(async () => {}) };
        vi.stubGlobal('window', { electron: { playbackSources: bridge } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 255]))));
        for (const [url, http] of [['blob:test', true], ['https://cdn.test/file', false]] as const) {
            const prepared = await prepareBackendSource(url, 'file', http);
            expect(prepared.source.filePath).toBe('/host/song.audio');
            expect(new Uint8Array(bridge.stage.mock.calls.at(-1)![0])).toEqual(new Uint8Array([1, 2, 255]));
            await prepared.release();
        }
        expect(bridge.stream).not.toHaveBeenCalled();
    });
    it('fails closed when a stream cannot be leased instead of exposing a provider URL', async () => {
        const stream = vi.fn(async () => { throw new Error('retired'); });
        const stage = vi.fn();
        vi.stubGlobal('window', { electron: { playbackSources: { stream, stage } } });
        await expect(prepareBackendSource('https://cdn.test/private', 'id', true)).rejects.toThrow('retired');
        expect(stage).not.toHaveBeenCalled();
    });
});
