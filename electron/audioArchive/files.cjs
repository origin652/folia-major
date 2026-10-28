'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// All archive access stays below the user-selected root and refuses symlink/reparse path components.
const childPath = async (root, relative, create = false) => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Invalid archive path');
    const parts = relative.split(/[\\/]/);
    if (!parts.length || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid archive path');
    const base = await fs.realpath(root);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
        || base.toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('Archive root changed');
    let current = base;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        if (create && index < parts.length - 1) {
            try { await fs.mkdir(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        let stat;
        try { stat = await fs.lstat(current); } catch (error) {
            if (error.code === 'ENOENT' && index === parts.length - 1) return current;
            throw error;
        }
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error('Unsafe archive path');
        const resolved = await fs.realpath(current);
        const inside = path.relative(base, resolved);
        if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('Unsafe archive path');
    }
    return current;
};
const hashFile = async file => {
    const hash = createHash('sha256');
    for await (const data of createReadStream(file)) hash.update(data);
    return hash.digest('hex');
};
const inspectAudio = async (file, durationMs) => {
    const [{ fileTypeFromFile }, { parseFile }] = await Promise.all([import('file-type'), import('music-metadata')]);
    const type = await fileTypeFromFile(file);
    if (!type || !['flac', 'wav', 'aif', 'mp3', 'm4a', 'mp4', 'ogg', 'opus', 'wv', 'dsf', 'dff', 'ape', 'caf'].includes(type.ext)) throw new Error('Unrecognized archive audio');
    const metadata = await parseFile(file, { duration: true, skipCovers: true });
    if (!Number.isFinite(metadata.format.duration) || metadata.format.duration * 1000 < durationMs * 0.9) throw new Error('Archive audio is shorter than the song');
    return type;
};

module.exports = { childPath, hashFile, inspectAudio };
