'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { fileTypeFromFile } = require('file-type/node');

// HQPlayer needs a recognizable suffix; copy opaque host staging bytes without decoding or re-encoding.

const EXTENSIONS = new Set(['flac', 'wav', 'aif', 'aiff', 'mp3', 'm4a', 'mp4', 'ogg', 'opus', 'wv', 'dsf', 'dff', 'ape', 'caf']);
const stageHqpSource = async (source, cache) => {
    if (!source?.sourceId || typeof source.filePath !== 'string' || !path.isAbsolute(source.filePath)) {
        throw new Error('HQPlayer requires a host-staged local file; remote HQPlayer servers are not supported');
    }
    const stat = await fs.stat(source.filePath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 512 * 1024 * 1024) throw new Error('HQPlayer source must be a file of at most 512 MiB');
    const type = await fileTypeFromFile(source.filePath);
    if (!type || !EXTENSIONS.has(type.ext)) throw new Error('Unrecognized HQPlayer audio container; no lossy conversion or browser fallback was performed');
    await fs.mkdir(cache, { recursive: true });
    const directory = await fs.mkdtemp(path.join(cache, 'source-'));
    const file = path.join(directory, `audio.${type.ext}`);
    const release = () => fs.rm(directory, { recursive: true, force: true });
    try { await fs.copyFile(source.filePath, file, fs.constants.COPYFILE_EXCL); }
    catch (error) { await release(); throw error; }
    return { filePath: file, release };
};

module.exports = { stageHqpSource };
