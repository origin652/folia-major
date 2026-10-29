import net from 'node:net';
import { createRequire } from 'node:module';
import { vi } from 'vitest';

// A real TCP peer keeps its audio transport alive when a control socket fails.
const require = createRequire(import.meta.url);
const { HqConnection } = require('../../../extensions/hqplayer/connection.cjs');
const { createHqpEngine } = require('../../../extensions/hqplayer/engine.cjs');
const { parseResponse, commandXml } = require('../../../extensions/hqplayer/protocol.cjs');

export const controlFixture = async ({ controlRecoveryMs = 250 } = {}) => {
    const state = { state: 0, position: 0, length: 120, volume: -20, tracks_total: 0, track_id: 'owned', repeat: 0, random: 0 };
    const uri = 'http://127.0.0.1/isolated/source';
    let activeUri = uri;
    let drop = '';
    let rejectConnections = false;
    let failedRecoveries = 0;
    const sockets = new Set<net.Socket>();
    const commands: Array<{ socket: number; name: string }> = [];
    let serial = 0;
    const server = net.createServer(socket => {
        sockets.add(socket);
        const id = ++serial;
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', chunk => {
            buffer += chunk;
            if (!buffer.endsWith('\n')) return;
            const name = buffer.match(/<(\w+)/)![1];
            const request = parseResponse(buffer, name);
            buffer = '';
            commands.push({ socket: id, name });
            if (name === 'GetInfo' && failedRecoveries > 0) { failedRecoveries--; socket.destroy(); return; }
            if (name === 'Stop') Object.assign(state, { state: 0, position: 0, tracks_total: 0 });
            if (name === 'Pause') state.state = 1;
            if (name === 'Play') state.state = 2;
            if (name === 'PlayNextURI') { Object.assign(state, { state: 2, position: 0, tracks_total: 1 }); activeUri = request.getAttribute('value'); }
            if (name === 'Volume') state.volume = Number(request.getAttribute('value'));
            if (name === 'Seek') state.position = Number(request.getAttribute('position'));
            if (name === drop) { drop = ''; return; }
            if (rejectConnections) { socket.destroy(); return; }
            let xml = commandXml(name, { result: 'OK' });
            if (name === 'GetInfo') xml = commandXml(name, { product: 'Signalyst HQPlayer Desktop' });
            if (name === 'VolumeRange') xml = commandXml(name, { min: -120, max: 0, enabled: 1 });
            if (name === 'Status') xml = commandXml(name, state);
            if (name === 'PlaylistGet') xml = `<PlaylistGet>${commandXml('PlaylistItem', { uri: activeUri }).replace(/<\?xml[^?]*\?>/, '').trim()}</PlaylistGet>\n`;
            socket.write(xml);
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    const listeners = new Set<(event: any) => void>();
    const report = vi.fn(event => listeners.forEach(listener => listener(event)));
    const ensureRunning = vi.fn(async () => {});
    const prepare = vi.fn(async () => ({ uri, release: async () => {} }));
    const engine = createHqpEngine(report, '/isolated', {
        connect: (config: object) => new HqConnection(config, { timeoutMs: 80 }),
        ensureRunning, prepare, pollMs: 25, controlRecoveryMs,
    });
    await engine.configure({ port });
    await engine.open({ sourceId: 'one', url: uri });
    await engine.play();
    return {
        engine, state, report, commands, prepare, ensureRunning, listeners, port,
        drop: (name: string) => { drop = name; },
        foreignUri: () => { activeUri = 'http://127.0.0.1/foreign/source'; },
        disconnect: () => { for (const socket of sockets) socket.destroy(); },
        rejectConnections: () => { rejectConnections = true; },
        failRecoveries: (count: number) => { failedRecoveries = count; },
        close: async () => {
            try { await engine.dispose(); } catch { /* A deliberately disconnected transport cannot be stopped by the test. */ }
            for (const socket of sockets) socket.destroy();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
};
