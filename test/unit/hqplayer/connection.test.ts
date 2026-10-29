import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// TCP fragmentation, serialization and failure rejection without a real HQPlayer instance.
const require = createRequire(import.meta.url);
const { HqConnection } = require('../../../extensions/hqplayer/connection.cjs');
class Socket extends EventEmitter {
    writes: string[] = [];
    setEncoding() {}
    write(text: string, done: () => void) { this.writes.push(text); done(); }
    destroy() { this.emit('close'); }
}
const setup = () => {
    const socket = new Socket();
    const client = new HqConnection({ host: '127.0.0.1', port: 4321 }, { connect: () => socket, timeoutMs: 100 });
    socket.emit('connect');
    return { socket, client };
};

describe('HQPlayer connection', () => {
    it('allows a bounded slow HTTP seek without extending ordinary command timeouts', async () => {
        vi.useFakeTimers();
        try {
            const { client, socket } = setup();
            const seeking = client.request('Seek', { position: 42 }, 1000);
            await vi.advanceTimersByTimeAsync(500);
            expect(client.closed).toBe(false);
            socket.emit('data', '<Seek result="OK"/>\n');
            await seeking;
            const status = expect(client.request('Status')).rejects.toThrow('Status timed out');
            await vi.advanceTimersByTimeAsync(100);
            await status;
            expect(socket.writes).toHaveLength(2);
        } finally { vi.useRealTimers(); }
    });
    it('reassembles fragments and sends only one request at a time', async () => {
        const { client, socket } = setup();
        const one = client.request('GetInfo');
        const two = client.request('Status');
        await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
        socket.emit('data', '<GetInfo product="HQ');
        socket.emit('data', 'Player"/>\n');
        expect((await one).getAttribute('product')).toBe('HQPlayer');
        await vi.waitFor(() => expect(socket.writes).toHaveLength(2));
        socket.emit('data', '<Status state="0"/>\n');
        expect((await two).getAttribute('state')).toBe('0');
        client.close();
    });
    it('rejects pending and queued operations on disconnect', async () => {
        const { client, socket } = setup();
        const one = expect(client.request('Play')).rejects.toThrow('closed');
        const two = expect(client.request('Pause')).rejects.toThrow('closed');
        await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
        socket.emit('close');
        await Promise.all([one, two]);
    });
    it('names the pending command on reset without suggesting the player was never started', async () => {
        const { client, socket } = setup();
        const failure = client.request('Play', { last: 0 }).catch((error: Error) => error);
        await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
        socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
        const error = await failure;
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toContain('while awaiting Play');
        expect(error.message).toContain('ECONNRESET');
        expect(error.message).not.toContain('start HQPlayer');
        expect(socket.writes).toHaveLength(1);
        expect(client.closed).toBe(true);
    });
    it('names the pending command when the server exits without a socket error', async () => {
        const { client, socket } = setup();
        const failure = client.request('PlaylistAdd', { uri: 'file:///private/track.wav' }).catch((error: Error) => error);
        await vi.waitFor(() => expect(socket.writes).toHaveLength(1));
        socket.emit('close');
        const error = await failure;
        expect(error.message).toContain('PlaylistAdd');
        expect(error.message).toContain('closed');
        expect(error.message).not.toContain('private');
    });
    it('rejects timeouts and never retries a mutating command', async () => {
        const { client, socket } = setup();
        await expect(client.request('Play')).rejects.toThrow('timed out');
        expect(socket.writes).toHaveLength(1);
        expect(client.closed).toBe(true);
        await expect(client.request('Pause')).rejects.toThrow('Play timed out');
        expect(client.closeReason.message).toContain('Play timed out');
        expect(socket.writes).toHaveLength(1);
    });
});
