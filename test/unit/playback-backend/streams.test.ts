import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the real loopback transport with synthetic authenticated sources, never a real account.
const require = createRequire(import.meta.url);
const { createPlaybackStreams } = require('../../../electron/playbackBackends/streams.cjs');
const stores: any[] = [];
const setup = (fetchFn: any, protocols: string[] = []) => {
    const logInfo = vi.fn(), logWarn = vi.fn();
    const store = createPlaybackStreams({ fetchFn, protocols, logInfo, logWarn });
    stores.push(store);
    return { store, logInfo, logWarn };
};
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.dispose())); });

describe('authenticated playback stream leases', () => {
    it('isolates health/probes by owner and clears stale failures only after a successful probe', async () => {
        let status = 503;
        const fetchFn = vi.fn(async () => new Response('audio', { status,
            headers: { 'Content-Type': status >= 400 ? 'text/html' : 'audio/flac' } }));
        const { store } = setup(fetchFn);
        const lease = await store.create('https://cdn.test/song.flac?token=private', 7);
        expect(store.transfer(lease.id, 8)).toBeNull();
        expect(await store.probe(lease.id, 8)).toEqual({ ready: false, retryable: false });
        expect(fetchFn).not.toHaveBeenCalled();
        await fetch(lease.url);
        expect(store.transfer(lease.id, 7).failure.retryable).toBe(true);
        status = 403;
        await fetch(lease.url);
        expect(store.transfer(lease.id, 7).failure.retryable).toBe(false);
        status = 200;
        expect(await store.probe(lease.id, 7)).toEqual({ ready: true, retryable: true });
        expect(store.transfer(lease.id, 7).failure).toBeNull();
        expect(store.getError(lease.id, 7)).toBeNull();
        expect(fetchFn.mock.calls.every((call: any[]) => call[1].credentials === 'omit')).toBe(true);
        store.releaseOwner(7);
        expect(store.transfer(lease.id, 7)).toBeNull();
    });
    it('adds a host media protocol only after its handler has been registered', async () => {
        const handle = vi.fn();
        const fetchFn = vi.fn(async () => new Response('audio', { headers: { 'Content-Type': 'audio/flac' } }));
        const store = createPlaybackStreams({ fetchFn, protocol: { handle }, logInfo: vi.fn(), logWarn: vi.fn() });
        stores.push(store);
        await expect(store.create('folia-provider://audio/ticket', 7)).rejects.toThrow('unsupported');
        const handler = vi.fn();
        store.registerProtocol('folia-provider', handler);
        expect(handle).toHaveBeenCalledWith('folia-provider', handler);
        const lease = await store.create('folia-provider://audio/ticket', 7);
        expect(await (await fetch(lease.url)).text()).toBe('audio');
        expect(() => store.registerProtocol('file', handler)).toThrow('invalid-media');
    });
    it('does not label local archive reads as network downloads or probe them', async () => {
        const fetchFn = vi.fn(async () => new Response('audio', { headers: { 'Content-Type': 'audio/flac' } }));
        const store = createPlaybackStreams({ fetchFn, protocol: { handle: vi.fn() }, logInfo: vi.fn(), logWarn: vi.fn() });
        stores.push(store);
        store.registerProtocol('folia-local', vi.fn(), { network: false });
        const lease = await store.create('folia-local://audio/ticket', 7);
        expect(lease.network).toBe(false);
        expect(await (await fetch(lease.url)).text()).toBe('audio');
        expect(store.transfer(lease.id, 7)).toBeNull();
        expect(await store.probe(lease.id, 7)).toEqual({ ready: false, retryable: false });
        expect(fetchFn).toHaveBeenCalledOnce();
    });
    it('forwards Range and HEAD through the host without exposing upstream auth or downstream cookies', async () => {
        const fetchFn = vi.fn(async (_url: string, init: RequestInit) => new Response(init.method === 'HEAD' ? null : '3456', {
            status: 206, headers: { 'Content-Type': 'audio/flac', 'Content-Length': '4', 'Content-Range': 'bytes 3-6/10',
                'Accept-Ranges': 'bytes', 'Set-Cookie': 'secret=must-not-escape', Location: 'https://cdn.test/secret' },
        }));
        const { store } = setup(fetchFn);
        const upstream = 'https://cdn.test/song.flac?vkey=private-signature';
        const lease = await store.create(upstream, 7);
        expect(fetchFn).not.toHaveBeenCalled();
        expect(lease.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\/audio\.flac$/);
        expect(JSON.stringify(lease)).not.toContain('private-signature');
        const response = await fetch(lease.url, { headers: { Range: 'bytes=3-6', Cookie: 'foreign=not-forwarded', Authorization: 'not-forwarded' } });
        expect(response.status).toBe(206);
        expect(await response.text()).toBe('3456');
        expect(response.headers.get('content-range')).toBe('bytes 3-6/10');
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(response.headers.get('location')).toBeNull();
        expect(fetchFn.mock.calls[0][0]).toBe(upstream);
        expect(fetchFn.mock.calls[0][1].headers).toEqual({ Range: 'bytes=3-6' });
        const head = await fetch(lease.url, { method: 'HEAD', headers: { Range: 'bytes=3-6' } });
        expect(await head.text()).toBe('');
        expect(fetchFn.mock.calls[1][1].method).toBe('HEAD');
        store.release(lease.id, 8);
        expect((await fetch(lease.url, { method: 'HEAD' })).status).toBe(206);
        store.release(lease.id, 7);
        expect((await fetch(lease.url)).status).toBe(404);
    });
    it('delivers the first chunk while the rest of the song is still unavailable and aborts on release', async () => {
        let signal!: AbortSignal;
        const cancelled = vi.fn();
        const { store } = setup(async (_url: string, init: { signal: AbortSignal }) => {
            signal = init.signal;
            return new Response(new ReadableStream({ start: controller => controller.enqueue(new Uint8Array([1, 2, 3])),
                cancel: cancelled }), { headers: { 'Content-Type': 'audio/flac' } });
        });
        const lease = await store.create('https://cdn.test/slow.flac', 7);
        const response = await fetch(lease.url);
        const reader = response.body!.getReader();
        expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
        expect(signal.aborted).toBe(false);
        store.release(lease.id, 7);
        await expect(reader.read()).rejects.toThrow();
        await vi.waitFor(() => expect(signal.aborted).toBe(true));
        await vi.waitFor(() => expect(cancelled).toHaveBeenCalled());
        expect((await fetch(lease.url)).status).toBe(404);
    });
    it('accepts only explicitly registered host media protocols and rejects files and URL credentials', async () => {
        const fetchFn = vi.fn(async (_url: string) => new Response('audio', { headers: { 'Content-Type': 'audio/flac' } }));
        const { store } = setup(fetchFn, ['folia-test:']);
        const lease = await store.create('folia-test://audio/opaque?key=host-private', 7);
        expect(await (await fetch(lease.url)).text()).toBe('audio');
        expect(fetchFn.mock.calls[0][0]).toBe('folia-test://audio/opaque?key=host-private');
        for (const url of ['file:///C:/private', 'blob:renderer-only', 'folia-mod://private', 'https://user:pass@cdn.test/audio']) {
            await expect(store.create(url, 7)).rejects.toThrow('unsupported');
        }
        store.releaseOwner(7);
        expect((await fetch(lease.url)).status).toBe(404);
        await store.dispose();
        await expect(store.create('https://cdn.test/audio', 7)).rejects.toThrow('retired');
    });
    it('bounds leases, isolates owners and makes network or non-audio failures observable without credentials', async () => {
        const failure = new Error('refused private-signature');
        const { store, logWarn } = setup(async () => { throw failure; });
        const leases = [];
        for (let i = 0; i < 8; i++) leases.push(await store.create('https://cdn.test/a.flac?vkey=private-signature', 7));
        await expect(store.create('https://cdn.test/a.flac', 7)).rejects.toThrow('too-many');
        expect((await fetch(leases[0].url)).status).toBe(502);
        expect(store.getError(leases[0].id, 7)).toBe('SOURCE_UNREACHABLE');
        expect(JSON.stringify(logWarn.mock.calls)).not.toContain('private-signature');
        const other = await store.create('https://cdn.test/other.flac', 8);
        store.releaseOwner(7);
        expect((await fetch(leases[0].url)).status).toBe(404);
        expect((await fetch(other.url)).status).toBe(502);
        const html = setup(async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })).store;
        const login = await html.create('https://cdn.test/login', 7);
        expect((await fetch(login.url)).status).toBe(502);
        expect(html.getError(login.id, 7)).toBe('SOURCE_REJECTED');
    });
    it('does not forward unknown tokens or write requests upstream', async () => {
        const fetchFn = vi.fn();
        const { store } = setup(fetchFn);
        const lease = await store.create('https://cdn.test/audio', 7);
        expect((await fetch(lease.url.replace(lease.id, '0'.repeat(32)))).status).toBe(404);
        expect((await fetch(lease.url, { method: 'POST' })).status).toBe(405);
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it('cancels lease creation when its renderer retires while the listener is starting', async () => {
        const fetchFn = vi.fn();
        const { store } = setup(fetchFn);
        const pending = store.create('https://cdn.test/audio.flac', 7);
        store.releaseOwner(7);
        await expect(pending).rejects.toThrow('retired');
        expect(fetchFn).not.toHaveBeenCalled();
    });
});
