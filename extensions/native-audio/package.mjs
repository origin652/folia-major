import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';

// Builds a self-contained, unsigned mod. Downloaded engine bytes never enter the host source tree.
const root = path.dirname(fileURLToPath(import.meta.url));
const mod = JSON.parse(await fs.readFile(path.join(root, 'mod.json'), 'utf8'));
const lock = JSON.parse(await fs.readFile(path.join(root, 'runtime.lock.json'), 'utf8'));
const output = path.resolve(root, '../../test-results/native-audio-package');
await fs.mkdir(output, { recursive: true });
const archive = process.argv[2] ? path.resolve(process.argv[2]) : path.join(output, 'engine.7z');
if (!process.argv[2]) {
    const result = spawnSync('curl.exe', ['-sS', '-L', '--fail', '--max-time', '900', '--output', archive, lock.url], { stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Engine download failed');
}
const bytes = await fs.readFile(archive);
if (createHash('sha256').update(bytes).digest('hex') !== lock.sha256) throw new Error('Engine archive SHA-256 mismatch; nothing packaged');
const extracted = await fs.mkdtemp(path.join(output, 'engine-'));
const unpack = spawnSync('tar.exe', ['-xf', archive, '-C', extracted], { stdio: 'inherit', windowsHide: true });
if (unpack.error) throw unpack.error;
if (unpack.status !== 0) throw new Error('Engine extraction failed (tar.exe must support 7z)');
const executable = path.join(extracted, 'mpv.exe');
await fs.stat(executable);
// Test SoXR in the verified binary. mpv can exit successfully after disabling a failed filter.
const probe = Buffer.alloc(44 + 4800 * 4);
probe.write('RIFF'); probe.writeUInt32LE(probe.length - 8, 4); probe.write('WAVEfmt ', 8);
probe.writeUInt32LE(16, 16); probe.writeUInt16LE(1, 20); probe.writeUInt16LE(2, 22);
probe.writeUInt32LE(48000, 24); probe.writeUInt32LE(192000, 28); probe.writeUInt16LE(4, 32);
probe.writeUInt16LE(16, 34); probe.write('data', 36); probe.writeUInt32LE(probe.length - 44, 40);
const probePath = path.join(output, 'soxr-probe.wav');
await fs.writeFile(probePath, probe);
const checked = spawnSync(executable, ['--no-config', '--no-video', '--load-scripts=no', '--ao=null', '--audio-samplerate=96000',
    '--af=lavfi=[aresample=96000:resampler=soxr:precision=33:cheby=1:osf=dbl]', probePath], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
const log = String(checked.stdout) + String(checked.stderr);
if (checked.error) throw checked.error;
if (checked.status !== 0 || /unavailable|failed|Disabling filter/i.test(log) || !/96000Hz/.test(log)) {
    throw new Error(`Verified engine failed its silent SoXR probe: ${log.slice(-2000)}`);
}
const sources = ['mod.json', 'client.mjs', 'deviceSettings.mjs', 'index.cjs', 'engine.cjs', 'devices.cjs', 'dsp.cjs', 'mpvIpc.cjs', 'runtime.lock.json', 'README.md', 'THIRD_PARTY_NOTICES.md'];
const files = {};
for (const name of sources) files[`native-audio/${name}`] = new Uint8Array(await fs.readFile(path.join(root, name)));
files['native-audio/LICENSE'] = new Uint8Array(await fs.readFile(path.resolve(root, '../../LICENSE')));
for (const license of lock.licenses) {
    const cached = path.join(output, license.name);
    try { await fs.access(cached); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const downloaded = spawnSync('curl.exe', ['-sS', '-L', '--fail', '--max-time', '60', '--output', cached, license.url], { stdio: 'inherit', windowsHide: true });
        if (downloaded.error) throw downloaded.error;
        if (downloaded.status !== 0) throw new Error(`License download failed: ${license.name}`);
    }
    const text = new Uint8Array(await fs.readFile(cached));
    if (createHash('sha256').update(text).digest('hex') !== license.sha256) throw new Error(`License SHA-256 mismatch: ${license.name}`);
    files[`native-audio/licenses/${license.name}`] = text;
}

// Preserve upstream license/readme material alongside the engine, not just the executable.
const runtimeFiles = {};
const collect = async (directory, prefix = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (relative !== 'mpv.exe' && relative !== 'doc' && !relative.startsWith('doc/')) continue;
        if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in engine archive');
        if (entry.isDirectory()) await collect(path.join(directory, entry.name), `${relative}/`);
        else if (entry.isFile()) {
            if (/\.(exe|dll)$/i.test(entry.name) && entry.name !== 'mpv.exe') continue;
            const data = new Uint8Array(await fs.readFile(path.join(directory, entry.name)));
            runtimeFiles[relative] = data;
            files[`native-audio/runtime/win32-x64/${relative}`] = data;
        }
    }
};
await collect(extracted);
const manifest = Object.fromEntries(Object.entries(runtimeFiles).map(([name, data]) => [name, createHash('sha256').update(data).digest('hex')]));
files['native-audio/runtime/checksums.json'] = strToU8(JSON.stringify(manifest, null, 4) + '\n');
const packagePath = path.join(output, `${mod.id}-${mod.version}-win32-x64.zip`);
await fs.writeFile(packagePath, zipSync(files, { level: 6 }));
console.log(`[NativeAudioPackage] ${packagePath}`);
console.log(`[NativeAudioPackage] Smoke test engine: ${executable}`);
