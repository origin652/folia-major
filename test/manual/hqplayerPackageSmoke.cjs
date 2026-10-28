'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { Module, builtinModules } = require('node:module');
const { pathToFileURL } = require('node:url');
const { unzipSync, strFromU8 } = require('fflate');
const { parseResponse, commandXml } = require('../../extensions/hqplayer/protocol.cjs');

// Runs the delivered main/client/clock with a local protocol simulator, not the user's player.

const run = async () => {
    const root = path.resolve(__dirname, '../..');
    const { version } = require('../../extensions/hqplayer/mod.json');
    const zip = unzipSync(await fs.readFile(path.join(root, `release/hqplayer-${version}.zip`)));
    const entry = new Module('hqplayer-standalone.cjs');
    entry.require = id => {
        if (!builtinModules.includes(id.replace(/^node:/, ''))) throw new Error(`Unbundled dependency: ${id}`);
        return require(id);
    };
    entry._compile(strFromU8(zip['hqplayer/index.cjs']), 'hqplayer-standalone.cjs');
    let state = 0, position = 0, volume = -30, tracks = 0;
    let serial = 0;
    let streamedUri = null;
    let stopping = 0, pausing = 0;
    const dsp = { mode: 0, filter: 0, filter1x: 0, filterNx: 0, shaper: 0, rate: 0 };
    const lists = {
        GetModes: '<ModesItem index="0" name="PCM" value="0"/>',
        GetFilters: '<FiltersItem index="0" name="none" value="0"/><FiltersItem index="1" name="poly-sinc" value="9"/>',
        GetShapers: '<ShapersItem index="0" name="none" value="0"/><ShapersItem index="1" name="TPDF" value="5"/>',
        GetRates: '<RatesItem index="0" rate="0"/><RatesItem index="1" rate="384000"/>',
    };
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.setEncoding('utf8');
        let buffer = '';
        socket.on('data', data => {
            buffer += data;
            while (buffer.includes('\n')) {
                const index = buffer.indexOf('\n');
                const xml = buffer.slice(0, index);
                buffer = buffer.slice(index + 1);
                const name = xml.match(/<([A-Z][A-Za-z]+)\b/)[1];
                const request = parseResponse(xml, name);
                let attrs = { result: 'OK' };
                if (name === 'GetInfo') attrs = { product: 'Signalyst HQPlayer Desktop', version: '6', engine: 'test' };
                if (name === 'GetLicense') attrs = { valid: '0' };
                if (name === 'VolumeRange') attrs = { enabled: '1', min: '-120', max: '0' };
                assert(!['PlaylistAdd', 'SetTransport', 'PlaylistClear'].includes(name), 'Must not use the failing playlist transport');
                if (name === 'PlayNextURI') {
                    assert.equal(request.getAttribute('freewheel'), '0');
                    tracks = 1; serial++; state = 2; position = 0;
                    const uri = request.getAttribute('value');
                    if (uri.startsWith('http:')) {
                        assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\/audio\.flac$/);
                        streamedUri = uri;
                    } else {
                        assert(path.isAbsolute(uri));
                        assert.match(uri, /\.wav$/);
                    }
                }
                if (name === 'Play') { assert.equal(request.getAttribute('last'), '0'); state = 2; }
                if (name === 'Pause') pausing = 2;
                if (name === 'Stop') { state = 3; tracks = 0; position = 0; stopping = 2; }
                if (name === 'Volume') volume = Number(request.getAttribute('value'));
                if (name === 'Seek') position = Number(request.getAttribute('position'));
                if (name === 'State') attrs = dsp;
                if (name === 'SetFilter') { dsp.filterNx = Number(request.getAttribute('value')); dsp.filter1x = Number(request.getAttribute('value1x')); }
                if (name === 'SetShaping') dsp.shaper = Number(request.getAttribute('value'));
                if (name === 'SetRate') dsp.rate = Number(request.getAttribute('value'));
                if (name === 'Status') {
                    if (pausing && --pausing === 0) state = 1;
                    if (stopping && --stopping === 0) state = 0;
                    attrs = { state, position, length: state === 3 ? 0 : 8, volume, tracks_total: tracks, track_id: `track-${serial}`, repeat: 0, random: 0 };
                }
                if (name in lists) { socket.write(`<${name}>${lists[name]}</${name}>\n`); continue; }
                socket.write(commandXml(name, attrs));
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const cache = await fs.mkdtemp(path.join(root, 'test-results/hqplayer-package-'));
    const handlers = new Map();
    const listeners = new Map();
    const events = [];
    const shown = [];
    let session;
    let cleanup;
    entry.exports({
        storage: { paths: { cache } },
        rpc: { handle: (name, fn) => handlers.set(name, fn), send: (name, event) => {
            events.push(event);
            listeners.get(name)?.(event);
        } },
        log: { error: console.error }, onDispose: fn => { cleanup = fn; },
    });
    const call = (name, ...args) => handlers.get(`hqplayer.${name}`)(...args);
    try {
        const port = server.address().port;
        const info = await call('inspect', { port });
        assert.equal(info.licensed, false);
        assert.equal(info.variableVolume, true);
        for (const name of ['client.mjs', 'settings.mjs', 'dspSettings.mjs', 'displayClock.mjs']) {
            assert(zip[`hqplayer/${name}`], `Missing client dependency: ${name}`);
            await fs.writeFile(path.join(cache, name), zip[`hqplayer/${name}`]);
        }
        const { default: activate } = await import(pathToFileURL(path.join(cache, 'client.mjs')).href);
        let backend;
        const commands = new Map();
        const sections = new Map();
        await activate({
            env: { context: 'main', locale: 'en' },
            experimental: { 'playback.backends': { supportsStreams: true, register: definition => { backend = definition; return { unregister() {} }; } } },
            rpc: { call: (name, ...args) => handlers.get(name)(...args),
                on: (name, listener) => { listeners.set(name, listener); return () => listeners.delete(name); } },
            registries: {
                commands: { register: def => { commands.set(def.id, def); return { unregister: () => commands.delete(def.id) }; } },
                settingsSections: { register: def => {
                    const values = def.id === 'connection' ? { port } : Object.fromEntries(def.settings.map(field => [field.key, field.defaultValue]));
                    const section = { settings: { get: () => ({ ...values }), set: patch => Object.assign(values, patch), onChange: () => () => {} }, unregister: () => sections.delete(def.id) };
                    sections.set(def.id, section);
                    return section;
                } },
            },
            every() {}, onDispose() {}, playback: { pause() {} }, ui: { toast() {} },
            log: { warn() {}, error: console.error },
        });
        session = backend.create(event => shown.push(event));
        const file = path.join(cache, 'source.audio');
        const wave = Buffer.alloc(44 + 480);
        wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
        wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
        wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(288000, 28); wave.writeUInt16LE(6, 32);
        wave.writeUInt16LE(24, 34); wave.write('data', 36); wave.writeUInt32LE(480, 40);
        await fs.writeFile(file, wave);
        await session.open({ sourceId: 'one', filePath: file });
        await session.setVolume(0.5);
        await session.play();
        assert(Math.abs(volume + 36.0206) < 0.001);
        assert.equal(state, 2);
        const playingReports = shown.filter(event => event.status?.state === 'playing').length;
        await session.setVolume(0.5);
        assert.equal(shown.filter(event => event.status?.state === 'playing').length, playingReports, 'Repeated progress must not reset the old host clock');
        await session.seek(3.9);
        assert.equal(position, 3);
        assert(shown.some(event => event.status?.state === 'loading' && event.status.position === 3));
        assert.equal(shown.at(-1).status.position, 3);
        assert.equal(shown.at(-1).status.state, 'playing');
        await commands.get('refresh-dsp').run();
        assert.equal(state, 2, 'Read-only DSP refresh must not pause output');
        sections.get('dsp').settings.set({ filter: '1', shaper: '1', rate: '1' });
        assert.equal(dsp.filterNx, 0, 'Editing a draft must not send setters');
        await commands.get('apply-dsp').run();
        assert.equal(state, 0);
        assert.equal(dsp.filterNx, 1);
        assert.equal(dsp.filter1x, 0);
        assert.equal(dsp.shaper, 1);
        assert.equal(dsp.rate, 1);
        await session.play();
        assert.equal(position, 3, 'Explicit Play after DSP apply must restore the saved position');
        for (let cycle = 0; cycle < 5; cycle++) {
            await session.pause();
            await session.open({ sourceId: `repeat-${cycle}`, filePath: file });
            await session.play();
            await session.seek(cycle === 2 ? 2 : 7);
            state = 3; tracks = 0; position = 0; stopping = 2;
            const deadline = Date.now() + 4000;
            while (!shown.some(event => event.type === 'ended' && event.sourceId === `repeat-${cycle}`)) {
                assert(Date.now() < deadline, 'STOPREQ must settle into EOF, not lose control');
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        assert.equal(backend.capabilities.http, true);
        const hostUri = `http://127.0.0.1:12345/${'a'.repeat(32)}/audio.flac`;
        await session.open({ sourceId: 'stream-check', url: hostUri });
        await session.play();
        assert.equal(streamedUri, hostUri, 'The standalone package must pass only the host lease to HQPlayer');
        await session.pause();
        await session.seek(4);
        await session.play();
        assert.equal(position, 4);
        await session.open({ sourceId: 'mute-check', filePath: file });
        await session.play();
        await session.setVolume(0);
        assert.equal(state, 1);
        await assert.rejects(session.play(), /muted/);
        await session.dispose();
        session = null;
        assert.equal(tracks, 0);
        assert(events.some(event => event.status?.sourceId === 'one' && event.status.state === 'playing'));
        assert(shown.some(event => event.status?.sourceId === 'one' && event.status.state === 'playing'));
        console.log('[HQPlayerPackageSmoke] ZIP main + client + clock + DSP settings, TCP/XML, asynchronous Pause/STOPREQ, five EOF transitions including an early stop, host stream URI/pause/seek, explicit DSP apply, PCM24, mute and disposal passed.');
    } finally {
        try { if (session) await session.dispose(); }
        finally {
            await cleanup();
            sockets.forEach(socket => socket.destroy());
            await new Promise(resolve => server.close(resolve));
        }
    }
};
run().catch(error => { console.error('[HQPlayerPackageSmoke]', error); process.exitCode = 1; });
