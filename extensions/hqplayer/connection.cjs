'use strict';

const net = require('node:net');
const { parseResponse, commandXml } = require('./protocol.cjs');

// One ordered connection: a delayed command reply can never be mistaken for the next command's result.

class HqConnection {
    constructor(config, { timeoutMs = 5000, connect = options => net.createConnection(options) } = {}) {
        this.timeoutMs = timeoutMs;
        this.work = Promise.resolve();
        this.pending = null;
        this.buffer = '';
        this.closed = false;
        this.closeReason = null;
        this.socket = connect({ host: config.host, port: config.port });
        this.socket.setEncoding('utf8');
        this.ready = new Promise((resolve, reject) => {
            this.rejectConnect = reject;
            this.connectTimer = setTimeout(() => this.fail(new Error('HQPlayer connection timed out; start HQPlayer and enable network control')), timeoutMs);
            this.socket.once('connect', () => { clearTimeout(this.connectTimer); resolve(); });
        });
        // Callers may register a connection before making their first request.
        void this.ready.catch(() => {});
        this.socket.on('data', chunk => this.receive(chunk));
        this.socket.on('error', error => this.socketError(error));
        this.socket.on('close', () => this.fail(new Error('HQPlayer connection closed'
            + (this.pending ? ` while awaiting ${this.pending.name}; output state is unknown` : ''))));
    }

    socketError(error) {
        const context = this.pending ? ` while awaiting ${this.pending.name}` : '';
        const advice = this.pending
            ? 'check HQPlayer error display or crash log before retrying; output state is unknown'
            : 'start HQPlayer, enable network control and close its Settings dialog';
        this.fail(new Error(`HQPlayer connection failed${context} (${error.code || 'socket error'}); ${advice}`, { cause: error }));
    }

    receive(chunk) {
        this.buffer += chunk;
        if (Buffer.byteLength(this.buffer) > 1024 * 1024) { this.fail(new Error('HQPlayer response exceeds 1 MiB')); return; }
        if (!this.buffer.endsWith('\n')) return;
        if (!this.pending) { this.fail(new Error('Unexpected unsolicited HQPlayer response')); return; }
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        const xml = this.buffer;
        this.buffer = '';
        try { pending.resolve(parseResponse(xml, pending.name)); }
        catch (error) { pending.reject(error); this.fail(error); }
    }

    request(name, attributes, timeoutMs = this.timeoutMs) {
        const result = this.work.then(async () => {
            await this.ready;
            if (this.closed) throw this.closeReason;
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => this.fail(new Error(`HQPlayer ${name} timed out; output state is unknown`)), timeoutMs);
                this.pending = { name, resolve, reject, timer };
                this.socket.write(commandXml(name, attributes), error => { if (error) this.socketError(error); });
            });
        });
        this.work = result.catch(() => {});
        return result;
    }

    fail(error) {
        if (this.closed) return;
        this.closed = true;
        this.closeReason = error;
        clearTimeout(this.connectTimer);
        this.rejectConnect(error);
        if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending.reject(error);
            this.pending = null;
        }
        this.socket.destroy();
    }

    close() { this.fail(new Error('HQPlayer connection disposed')); }
}

module.exports = { HqConnection };
