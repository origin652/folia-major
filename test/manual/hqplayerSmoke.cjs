'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { inspectHqplayer } = require('../../extensions/hqplayer/diagnostics.cjs');
const { createHqpEngine } = require('../../extensions/hqplayer/engine.cjs');

// Default is read-only; --play-silence explicitly tests a stopped, empty HQPlayer with zero-valued PCM24.

const run = async () => {
    const port = Number(process.env.FOLIA_HQP_PORT || 4321);
    const before = await inspectHqplayer({ port });
    console.log(JSON.stringify({ before }, null, 2));
    const directory = await fs.mkdtemp(path.join(path.resolve(__dirname, '../../test-results'), 'hqplayer-smoke-'));
    const calls = [];
    const { HqConnection } = require('../../extensions/hqplayer/connection.cjs');
    const engine = createHqpEngine(event => {
        calls.push(event);
        if (event.type === 'error') console.log('[HQPlayerSmoke] Engine error:', event.message);
    }, path.join(directory, 'cache'), {
        connect: config => {
            const connection = new HqConnection(config);
            const request = connection.request.bind(connection);
            connection.request = (name, attrs) => {
                calls.push({ command: name });
                return request(name, attrs);
            };
            return connection;
        },
    });
    try {
        await engine.configure({ port });
        if (!before.variableVolume) {
            await assert.rejects(engine.open({ sourceId: 'guard', filePath: path.join(directory, 'not-read.audio') }), /fixed\/bypassed/);
            assert(!calls.some(item => ['PlayNextURI', 'Play', 'Pause', 'Stop', 'PlaylistAdd', 'PlaylistClear', 'Volume'].includes(item.command)));
            console.log('[HQPlayerSmoke] Fixed-volume guard passed; no playback, playlist or volume command was sent.');
        } else if (process.argv.includes('--play-silence')) {
            assert.equal(before.state, 'stopped', 'Refusing to interrupt existing HQPlayer playback');
            const samples = 48000 * 8;
            const wave = Buffer.alloc(44 + samples * 6);
            wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
            wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
            wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(288000, 28); wave.writeUInt16LE(6, 32);
            wave.writeUInt16LE(24, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
            const file = path.join(directory, 'source.audio');
            await fs.writeFile(file, wave);
            await engine.open({ sourceId: 'silence', filePath: file });
            await engine.play();
            assert(calls.some(event => event.status?.state === 'playing'));
            await engine.pause();
            await engine.seek(2);
            console.log('[HQPlayerSmoke] Silent PCM24 open/play/pause/seek passed.');
        } else console.log('[HQPlayerSmoke] Read-only diagnostics completed; playback was not tested.');
    } finally { await engine.dispose(); }
    const after = await inspectHqplayer({ port });
    console.log(JSON.stringify({ after }, null, 2));
};
run().catch(error => { console.error('[HQPlayerSmoke]', error); process.exitCode = 1; });
