import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// IPC framing, command rejection and disconnect cleanup do not require an audio device.
const require = createRequire(import.meta.url);
const { MpvIpc } = require('../../../extensions/native-audio/mpvIpc.cjs');
class Socket extends EventEmitter {
    writes: string[] = [];
    setEncoding() {}
    write(data: string, done: (error?: Error) => void) { this.writes.push(data); done(); }
    destroy(error?: Error) { if (error) this.emit('error', error); this.emit('close'); }
}
describe('mpv IPC', () => {
    it('reassembles split messages and correlates responses out of order', async () => {
        const socket = new Socket();
        const ipc = new MpvIpc(socket);
        const event = vi.fn();
        ipc.on('message', event);
        const one = ipc.command(['get_property', 'pause']);
        const two = ipc.command(['get_property', 'duration']);
        const ids = socket.writes.map(line => JSON.parse(line).request_id);
        socket.emit('data', JSON.stringify({ request_id: ids[1], error: 'success', data: 12 }) + '\n{"event":');
        socket.emit('data', '"file-loaded"}\n' + JSON.stringify({ request_id: ids[0], error: 'success', data: false }) + '\n');
        expect(await one).toBe(false);
        expect(await two).toBe(12);
        expect(event).toHaveBeenCalledWith({ event: 'file-loaded' });
        ipc.close();
    });
    it('rejects failed commands and commands still pending on disconnect', async () => {
        const socket = new Socket();
        const ipc = new MpvIpc(socket);
        const first = ipc.command(['bad']);
        socket.emit('data', '{"request_id":1,"error":"invalid parameter"}\n');
        await expect(first).rejects.toThrow('invalid parameter');
        const second = ipc.command(['pause']);
        ipc.close();
        await expect(second).rejects.toThrow('closed');
        expect(ipc.pending.size).toBe(0);
    });
    it('terminates malformed and overlong streams', () => {
        for (const bytes of ['bad-json\n', 'x'.repeat(1024 * 1024 + 1)]) {
            const socket = new Socket();
            const ipc = new MpvIpc(socket);
            const failure = vi.fn();
            ipc.on('failure', failure);
            socket.emit('data', bytes);
            expect(failure).toHaveBeenCalledOnce();
        }
    });
});
