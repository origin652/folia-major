import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire, builtinModules } from 'node:module';
import { createHash } from 'node:crypto';
import { rolldown } from 'rolldown';
import { zipSync, strToU8 } from 'fflate';

// Bundle declared parser/type dependencies into the mod; never depend on Folia's private Node modules.

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const mod = JSON.parse(await fs.readFile(path.join(root, 'mod.json'), 'utf8'));
const dependencies = { '@xmldom/xmldom': '0.9.12', 'file-type': '21.3.4' };
const files = {};
for (const name of ['mod.json', 'client.mjs', 'settings.mjs', 'dspSettings.mjs', 'displayClock.mjs', 'README.md', 'THIRD_PARTY_NOTICES.md']) {
    files[`${mod.id}/${name}`] = new Uint8Array(await fs.readFile(path.join(root, name)));
}
for (const [name, version] of Object.entries(dependencies)) {
    const packageRoot = name === 'file-type' ? path.dirname(require.resolve('file-type')) : path.resolve(path.dirname(require.resolve(name)), '..');
    const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    if (manifest.version !== version) throw new Error(`Expected ${name}@${version}, found ${manifest.version}`);
}
const bundle = await rolldown({ input: path.join(root, 'index.cjs'), platform: 'node', external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)] });
const runtimePackages = new Map();
try {
    const result = await bundle.generate({ format: 'cjs', codeSplitting: false });
    if (result.output.length !== 1 || result.output[0].type !== 'chunk') throw new Error('Expected one self-contained main entry');
    files[`${mod.id}/index.cjs`] = strToU8(result.output[0].code);
    for (const id of Object.keys(result.output[0].modules)) {
        const normalized = id.replaceAll('\\', '/');
        const marker = normalized.lastIndexOf('/node_modules/');
        if (marker === -1) continue;
        const parts = normalized.slice(marker + 14).split('/');
        const name = parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
        runtimePackages.set(name, normalized.slice(0, marker + 14) + name);
    }
} finally { await bundle.close(); }
files[`${mod.id}/LICENSE`] = new Uint8Array(await fs.readFile(path.resolve(root, '../../LICENSE')));
// Preserve the license text of every npm package included in the main bundle.
const versions = {};
for (const [name, directory] of runtimePackages) {
    versions[name] = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')).version;
    const names = await fs.readdir(directory);
    const license = names.find(entry => /^licen[cs]e(?:\.md|\.txt)?$/i.test(entry));
    if (!license) throw new Error(`Missing bundled dependency license: ${name}`);
    files[`${mod.id}/licenses/${name.replaceAll('/', '-')}.txt`] = new Uint8Array(await fs.readFile(path.join(directory, license)));
}
files[`${mod.id}/runtimeVersions.json`] = strToU8(JSON.stringify(versions, null, 4) + '\n');
const output = path.resolve(root, '../../release', `${mod.id}-${mod.version}.zip`);
await fs.mkdir(path.dirname(output), { recursive: true });
const bytes = zipSync(files, { level: 6 });
await fs.writeFile(output, bytes);
console.log(`[HQPlayerPackage] ${output}`);
console.log(`[HQPlayerPackage] SHA256 ${createHash('sha256').update(bytes).digest('hex')}`);
