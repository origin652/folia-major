'use strict';

const net = require('node:net');
const { EventEmitter } = require('node:events');

// Bounded JSON-line IPC to the mod's own child process, not to a network listener.

class MpvIpc extends EventEmitter {
    constructor(socket) {
        super();
        this.socket = socket;
        this.pending = new Map();
        this.nextId = 1;
        let buffered = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
            buffered += chunk;
            if (buffered.length > 1024 * 1024) { socket.destroy(new Error('mpv IPC buffer limit exceeded')); return; }
            let end;
            while ((end = buffered.indexOf('\n')) !== -1) {
                const line = buffered.slice(0, end);
                buffered = buffered.slice(end + 1);
                let message;
                try { message = JSON.parse(line); }
                catch (error) { socket.destroy(new Error('Invalid mpv IPC JSON', { cause: error })); return; }
                if (message.request_id) {
                    const waiting = this.pending.get(message.request_id);
                    if (waiting) {
                        this.pending.delete(message.request_id);
                        clearTimeout(waiting.timer);
                        if (message.error === 'success') waiting.resolve(message.data);
                        else waiting.reject(new Error(`mpv command failed: ${message.error}`));
                    }
                } else this.emit('message', message);
            }
        });
        socket.on('error', error => this.emit('failure', error));
        socket.on('close', () => {
            const error = new Error('mpv IPC closed');
            this.pending.forEach(waiting => { clearTimeout(waiting.timer); waiting.reject(error); });
            this.pending.clear();
            this.emit('closed');
        });
    }

    command(command) {
        return new Promise((resolve, reject) => {
            const request_id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(request_id);
                reject(new Error(`mpv command timed out: ${command[0]}`));
            }, 8000);
            this.pending.set(request_id, { resolve, reject, timer });
            this.socket.write(`${JSON.stringify({ command, request_id })}\n`, error => {
                if (!error) return;
                clearTimeout(timer);
                this.pending.delete(request_id);
                reject(error);
            });
        });
    }

    close() { this.socket.destroy(); }
}

const connectMpv = async (pipe, alive) => {
    const until = Date.now() + 8000;
    while (Date.now() < until && alive()) {
        const socket = net.connect(pipe);
        const connected = await new Promise(resolve => {
            socket.once('connect', () => resolve(true));
            socket.once('error', () => { socket.destroy(); resolve(false); });
        });
        if (connected) return new MpvIpc(socket);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('mpv did not start its IPC pipe; check executable path and WASAPI support');
};

module.exports = { MpvIpc, connectMpv };
