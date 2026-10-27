'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createZipInstall } = require('../../electron/modSystem/zipInstall.cjs');
const { computeModDigest } = require('../../electron/modSystem/modDigest.cjs');

// Verifies the real ZIP installer and the installed mod's default bundled-engine RPC path in isolation.
const main = async () => {
    const userData = await fs.mkdtemp(path.resolve('test-results/native-audio-install-'));
    const installer = createZipInstall({
        app: { getPath: () => userData }, isModSystemEnabled: () => true,
        loadAll: () => [], emitLog: () => {}, serializeError: error => error.message,
    });
    const version = require('../../extensions/native-audio/mod.json').version;
    const zip = path.resolve(process.argv[2] || `test-results/native-audio-package/native-audio-${version}-win32-x64.zip`);
    const result = await installer.installModFromZip(zip);
    if (!result.ok) throw new Error(`ZIP install failed: ${JSON.stringify(result)}`);
    const modRoot = path.join(userData, 'mods', 'native-audio');
    if (!computeModDigest(modRoot)) throw new Error('Installed runtime exceeds content digest limits');
    const handlers = new Map();
    const disposers = [];
    let output;
    require(path.join(modRoot, 'index.cjs'))({
        rpc: { handle: (name, fn) => handlers.set(name, fn), send: (_name, event) => {
            if (event.type === 'status') output = event.status.output;
        } },
        log: { error: (...args) => console.error('[NativeAudioInstall]', ...args) },
        onDispose: fn => disposers.push(fn),
    });
    const call = (name, ...args) => handlers.get(`native.${name}`)(...args);
    try {
        await call('configure', { exclusive: true, dspEnabled: true, resampleEnabled: true, targetRate: 96000 });
        await call('setVolume', 0);
        await call('open', { sourceId: 'installed-default-bundled', filePath: path.resolve('test-results/native-audio/shared-pcm24.wav') });
        await call('play');
        await new Promise(resolve => setTimeout(resolve, 350));
        await call('pause');
        if (output?.sampleRate !== 96000 || output?.exclusiveActive !== true || output?.dspActive !== true) throw new Error('Installed bundle output was not confirmed');
        console.log(JSON.stringify({ installed: modRoot, defaultEngine: 'bundled', output }));
    } finally { for (const dispose of disposers.reverse()) await dispose(); }
};
main().catch(error => { console.error('[NativeAudioInstall]', error); process.exitCode = 1; });
