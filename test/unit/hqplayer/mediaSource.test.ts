import { createRequire } from 'node:module';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Recognize opaque staging bytes with the bundled library, retaining exact PCM24 bytes and bounded ownership.
const require = createRequire(import.meta.url);
const { stageHqpSource } = require('../../../extensions/hqplayer/mediaSource.cjs');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('HQPlayer source copies', () => {
    it('adds a recognized suffix without changing bytes and releases only its own copy', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'folia-hqp-unit-'));
        roots.push(root);
        const original = path.join(root, 'opaque.audio');
        const wav = Buffer.alloc(44 + 96);
        wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
        wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
        wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(288000, 28); wav.writeUInt16LE(6, 32);
        wav.writeUInt16LE(24, 34); wav.write('data', 36); wav.writeUInt32LE(96, 40);
        wav[44] = 255;
        await writeFile(original, wav);
        const prepared = await stageHqpSource({ sourceId: 'test', filePath: original }, path.join(root, 'cache'));
        expect(prepared.filePath).toMatch(/\.wav$/);
        expect(path.isAbsolute(prepared.filePath)).toBe(true);
        const copy = prepared.filePath;
        expect(await readFile(copy)).toEqual(wav);
        await prepared.release();
        await expect(stat(copy)).rejects.toThrow();
        expect(await readFile(original)).toEqual(wav);
    });
    it('rejects remote/unrecognized sources rather than converting or falling back', async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'folia-hqp-unit-'));
        roots.push(root);
        await expect(stageHqpSource({ sourceId: 'x', url: 'https://example.test/a.flac' }, root)).rejects.toThrow('local file');
        const file = path.join(root, 'source.audio');
        await writeFile(file, Buffer.alloc(100));
        await expect(stageHqpSource({ sourceId: 'x', filePath: file }, root)).rejects.toThrow('Unrecognized');
    });
});
