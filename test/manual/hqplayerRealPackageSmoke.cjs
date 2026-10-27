'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Module, builtinModules } = require('node:module');
const { unzipSync, strFromU8 } = require('fflate');
const { HqConnection } = require('../../extensions/hqplayer/connection.cjs');
const { decodeStatus, decodeVolumeRange } = require('../../extensions/hqplayer/protocol.cjs');

// Explicit opt-in: exercise the delivered ZIP against a stopped, empty real HQPlayer, without a Folia profile.

const run = async () => {
    assert(process.argv.includes('--play-silence'), 'Pass --play-silence to authorize real playback');
    const root = path.resolve(__dirname, '../..');
    const packageIndex = process.argv.indexOf('--package');
    const cycleIndex = process.argv.indexOf('--cycles');
    const cycles = cycleIndex === -1 ? 0 : Number(process.argv[cycleIndex + 1]);
    assert(Number.isInteger(cycles) && cycles >= 0 && cycles <= 30, '--cycles must be an integer from 0 to 30');
    const current = require('../../extensions/hqplayer/mod.json');
    const archive = packageIndex === -1 ? path.join(root, `release/hqplayer-${current.version}.zip`) : process.argv[packageIndex + 1];
    assert(archive && path.isAbsolute(archive), '--package requires an absolute path');
    const zip = unzipSync(await fs.readFile(archive));
    const { version } = JSON.parse(strFromU8(zip['hqplayer/mod.json']));
    const records = [];
    let socketId = 0;
    const trace = (stage, data) => records.push({ time: new Date().toISOString(), stage, ...data });
    const entry = new Module('hqplayer-real-standalone.cjs');
    entry.require = id => {
        if (!builtinModules.includes(id.replace(/^node:/, ''))) throw new Error(`Unbundled dependency: ${id}`);
        if (id.replace(/^node:/, '') === 'net') return { ...net, createConnection: options => {
            const socket = net.createConnection(options);
            const connection = ++socketId;
            let buffer = '';
            const write = socket.write.bind(socket);
            socket.write = (chunk, ...args) => {
                trace('wire-request', { connection, command: String(chunk).match(/<([A-Z][A-Za-z]+)\b/)?.[1] });
                return write(chunk, ...args);
            };
            socket.on('data', chunk => {
                buffer += chunk;
                while (buffer.includes('\n')) {
                    const index = buffer.indexOf('\n');
                    const response = buffer.slice(0, index);
                    buffer = buffer.slice(index + 1);
                    const command = response.match(/<([A-Z][A-Za-z]+)\b/)?.[1];
                    const status = {};
                    if (command === 'Status') for (const key of ['state', 'position', 'length', 'tracks_total']) {
                        const value = response.match(new RegExp(`\\b${key}="([^"]*)"`));
                        if (value) status[key] = Number(value[1]);
                    }
                    trace('wire-response', { connection, command, ...status });
                }
            });
            socket.on('close', () => trace('wire-close', { connection }));
            trace('wire-open', { connection });
            return socket;
        } };
        return require(id);
    };
    entry._compile(strFromU8(zip['hqplayer/index.cjs']), 'hqplayer-real-standalone.cjs');
    const directory = await fs.mkdtemp(path.join(root, 'test-results/hqplayer-real-package-'));
    const observer = new HqConnection({ host: '127.0.0.1', port: Number(process.env.FOLIA_HQP_PORT || 4321) });
    const readStatus = async () => decodeStatus(await observer.request('Status', { subscribe: 0 }));
    const log = (stage, data = {}) => {
        const record = { time: new Date().toISOString(), stage, ...data };
        records.push(record);
        console.log('[HQPlayerRealPackage] ' + JSON.stringify(record));
    };
    const sample = async stage => {
        const command = "$p = Get-Process -Name HQPlayer6Desktop -ErrorAction Stop; $p | ForEach-Object { [pscustomobject]@{ pid=$_.Id; startTimeUtc=$_.StartTime.ToUniversalTime().ToString('o'); threads=$_.Threads.Count; handles=$_.HandleCount; privateBytes=$_.PrivateMemorySize64; workingSet=$_.WorkingSet64; cpuSeconds=$_.CPU; responding=$_.Responding } } | ConvertTo-Json -Compress";
        const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
            windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024,
        });
        log(stage, { resources: JSON.parse(stdout.trim()) });
    };
    const handlers = new Map();
    const events = [];
    let cleanup, heartbeat, before, attempted = false;
    const testVolume = -50 + 20 * Math.log10(0.5);
    entry.exports({
        storage: { paths: { cache: path.join(directory, 'cache') } },
        rpc: {
            handle: (name, fn) => handlers.set(name, fn),
            send: (_name, event) => { events.push(event); if (event.type === 'error') log('engine-error', { message: event.message }); },
        },
        log: { error: (...args) => console.error('[HQPlayerRealPackage]', ...args) },
        onDispose: fn => { cleanup = fn; },
    });
    const call = async (name, ...args) => { log(name); return handlers.get(`hqplayer.${name}`)(...args); };
    // Observe the module's own 2 Hz events rather than adding another fast status polling loop.
    const waitFor = async (sourceId, predicate, timeoutMs = 16000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const failure = events.find(event => event.type === 'error');
            if (failure) throw new Error(failure.message);
            const event = events.findLast(item => (item.sourceId || item.status?.sourceId) === sourceId);
            if (event && predicate(event)) return event;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Timed out waiting for ${sourceId} state`);
    };
    const advancing = sourceId => waitFor(sourceId, event => event.status?.state === 'playing' && event.status.position > 0.5);
    try {
        before = await readStatus();
        assert.equal(before.state, 'stopped', 'Refusing to interrupt playback');
        assert.equal(before.tracks, 0, 'Refusing to replace a playlist');
        const range = decodeVolumeRange(await observer.request('VolumeRange'));
        assert(range.enabled, 'Variable volume is required');
        assert(testVolume >= range.min && -50 <= range.max, 'Test volume outside configured range');
        assert(before.volumeDb >= -50, 'Current volume is quieter than this test; refusing to raise it');
        log('before', { state: before.state, tracks: before.tracks, volumeDb: before.volumeDb });
        log('inspect-result', await call('inspect', { port: Number(process.env.FOLIA_HQP_PORT || 4321) }));

        const wave = Buffer.alloc(44 + 48000 * 8 * 6);
        wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
        wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
        wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(288000, 28); wave.writeUInt16LE(6, 32);
        wave.writeUInt16LE(24, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
        const file = path.join(directory, 'silence.audio');
        await fs.writeFile(file, wave);
        attempted = true;
        await call('configure', { port: Number(process.env.FOLIA_HQP_PORT || 4321), ceilingDb: -50 });
        heartbeat = setInterval(() => { void handlers.get('hqplayer.heartbeat')(); }, 2000);
        await call('open', { sourceId: 'silence', filePath: file });
        await call('setVolume', 0.5);
        assert(!events.some(event => event.status?.state === 'playing'), 'Preparation must not start audio');
        await call('play');
        await advancing('silence');
        const active = await readStatus();
        log('playing-confirmed', { position: active.position, duration: active.duration, sampleRate: active.sampleRate, bits: active.bits });
        await call('pause');
        await waitFor('silence', event => event.status?.state === 'paused');
        await call('seek', 2);
        await call('play');
        await advancing('silence');
        await call('setVolume', 0);
        await waitFor('silence', event => event.status?.state === 'paused');
        await assert.rejects(call('play'), /muted/);
        // A deliberate muted-play refusal emits an error; it must not mask later test failures.
        events.splice(0);
        await call('setVolume', 0.5);
        assert.equal((await readStatus()).state, 'paused', 'Unmuting must not resume');
        await call('play');
        await advancing('silence');

        const fileIndex = process.argv.indexOf('--file');
        const input = fileIndex === -1 ? null : process.argv[fileIndex + 1];
        if (fileIndex !== -1) {
            assert(input && path.isAbsolute(input), '--file requires an absolute path');
            await call('open', { sourceId: 'supplied-file', filePath: input });
            await call('play');
            await advancing('supplied-file');
            const supplied = await readStatus();
            log('supplied-file-confirmed', { position: supplied.position, duration: supplied.duration, sampleRate: supplied.sampleRate, bits: supplied.bits });
            await call('seek', 30);
            await waitFor('supplied-file', event => event.status?.state === 'playing' && event.status.position >= 29 && event.status.position < 34);
            await call('pause');
            const paused = await readStatus();
            assert.equal(paused.state, 'paused');
            assert(paused.position >= 29 && paused.position < 34, 'Seek did not advance to 30 seconds');
        }

        await call('open', { sourceId: 'eof', filePath: file });
        await call('play');
        await advancing('eof');
        await waitFor('eof', event => event.type === 'ended', 20000);
        log('natural-end-confirmed');
        if (cycles) await sample('cycles-before');
        for (let cycle = 1; cycle <= cycles; cycle++) {
            const sourceId = `cycle-${cycle}`;
            await call('pause');
            await call('open', { sourceId, filePath: input && cycle % 2 === 0 ? input : file });
            await call('play');
            await advancing(sourceId);
            const active = await readStatus();
            await call('pause');
            assert.equal((await readStatus()).state, 'paused');
            await call('seek', Math.max(0, Math.floor(active.duration - 3)));
            await call('play');
            await waitFor(sourceId, event => event.type === 'ended', 20000);
            await sample(`cycle-${cycle}-ended`);
        }
        await call('dispose');
        const after = await readStatus();
        assert.equal(after.state, 'stopped');
        assert.equal(after.tracks, 0);
        log('passed', { version, state: after.state, tracks: after.tracks });
    } finally {
        clearInterval(heartbeat);
        try { await cleanup?.(); }
        catch (error) { log('cleanup-failed', { message: error.message }); }
        try {
            if (attempted && before && !observer.closed) {
                const after = await readStatus();
                if (after.state === 'stopped' && after.tracks === 0 && Math.abs(after.volumeDb - testVolume) < 0.15) {
                    await observer.request('Volume', { value: before.volumeDb });
                    log('volume-restored', { volumeDb: before.volumeDb });
                }
            }
        } finally {
            observer.close();
            await fs.writeFile(path.join(directory, 'result.json'), JSON.stringify(records, null, 2) + '\n');
            console.log('[HQPlayerRealPackage] Report: ' + path.join(directory, 'result.json'));
        }
    }
};
run().catch(error => { console.error('[HQPlayerRealPackage]', error); process.exitCode = 1; });
