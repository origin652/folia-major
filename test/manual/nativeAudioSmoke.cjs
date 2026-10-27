'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createNativeEngine } = require('../../extensions/native-audio/engine.cjs');

// A silent hardware probe. It never changes the system endpoint or produces a nonzero sample.
const wave = (bits, floating = false) => {
    const rate = 48000;
    const bytes = bits / 8;
    const data = Buffer.alloc(rate * 2 * bytes);
    const header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(data.length + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(floating ? 3 : 1, 20);
    header.writeUInt16LE(2, 22); header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2 * bytes, 28); header.writeUInt16LE(2 * bytes, 32);
    header.writeUInt16LE(bits, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
};

const main = async () => {
    const root = path.resolve('test-results/native-audio');
    await fs.mkdir(root, { recursive: true });
    for (const test of [
        { name: 'shared-pcm24', bits: 24 },
        { name: 'shared-pcm32', bits: 32 },
        { name: 'shared-float32', bits: 32, floating: true },
        { name: 'exclusive-pcm24', bits: 24, exclusive: true },
        { name: 'exclusive-s32', bits: 32, exclusive: true, outputFormat: 's32' },
        { name: 'soxr-96k', bits: 24, dspEnabled: true, resampleEnabled: true, targetRate: 96000 },
        { name: 'soxr-exclusive-96k', bits: 24, exclusive: true, dspEnabled: true, resampleEnabled: true, targetRate: 96000 },
        { name: 'exclusive-headroom-eq', bits: 24, exclusive: true, dspEnabled: true, eqEnabled: true, bassDb: 2, trebleDb: -1 },
    ]) {
        const filePath = path.join(root, `${test.name}.wav`);
        await fs.writeFile(filePath, wave(test.bits, test.floating));
        let latest;
        let ended = 0;
        const engine = createNativeEngine(event => {
            if (event.type === 'status') latest = event.status;
            if (event.type === 'ended') ended++;
        });
        try {
            await engine.configure({ ...test, executable: process.argv[2] ? path.resolve(process.argv[2]) : 'mpv.exe' });
            await engine.setVolume(0);
            await engine.open({ sourceId: test.name, filePath });
            await engine.play();
            await new Promise(resolve => setTimeout(resolve, 1250));
            await engine.seek(0);
            await engine.play();
            await new Promise(resolve => setTimeout(resolve, 1250));
            await engine.pause();
            console.log(JSON.stringify({ test: test.name, result: 'initialized', output: latest?.output, ended }));
        } catch (error) {
            console.log(JSON.stringify({ test: test.name, result: 'refused', error: error.message }));
        } finally { await engine.dispose(); }
    }
};

main().catch(error => { console.error('[NativeAudioSmoke]', error); process.exitCode = 1; });
