'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');

// Archive identity is provider/song/actual quality, never an expiring media URL or a display name.
const MAX_AUDIO_BYTES = 512 * 1024 * 1024;
const isStrongEtag = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
const cleanName = value => {
    let name = String(value).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 100).replace(/[. ]+$/, '');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    return name || 'Untitled';
};
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const normalizeContext = value => {
    if (!value || !text(value.songKey, 512) || !/^online:[a-z0-9-]+:.+$/i.test(value.songKey)
        || !text(value.quality, 64) || !/^[a-z0-9_-]+$/i.test(value.quality)
        || !text(value.title, 500) || typeof value.artist !== 'string' || value.artist.length > 1000
        || value.preview !== false || !Number.isFinite(value.durationMs) || value.durationMs <= 0) return null;
    const collection = value.collection && text(value.collection.id, 512) && text(value.collection.name, 500)
        ? { id: value.collection.id, name: value.collection.name } : null;
    return { songKey: value.songKey, quality: value.quality, title: value.title, artist: value.artist,
        durationMs: value.durationMs, collection, preview: false };
};
const digest = value => createHash('sha256').update(value).digest('hex');
const archiveKey = ({ songKey, quality }) => digest(JSON.stringify([songKey, quality]));
const archiveRelativePath = (context, extension) => {
    const provider = context.songKey.split(':')[1];
    const folder = context.collection ? `${cleanName(context.collection.name)} [${digest(context.collection.id).slice(0, 8)}]` : 'Unsorted';
    const title = cleanName(context.artist ? `${context.artist} - ${context.title}` : context.title);
    return path.join(provider, folder, `${title} [${context.quality}-${archiveKey(context).slice(0, 8)}].${extension}`);
};
const mergeRanges = (ranges, start, end) => {
    const merged = [];
    for (const range of [...ranges, [start, end]].sort((a, b) => a[0] - b[0])) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
    }
    return merged;
};
const responseRange = response => {
    if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') return null;
    const length = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_AUDIO_BYTES) return null;
    if (response.status === 200) return { start: 0, end: length, total: length, etag: response.headers.get('etag') };
    if (response.status !== 206) return null;
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!match) return null;
    const [start, last, total] = match.slice(1).map(Number);
    if (![start, last, total].every(Number.isSafeInteger) || start > last || last >= total
        || total > MAX_AUDIO_BYTES || last - start + 1 !== length) return null;
    const etag = response.headers.get('etag');
    // Without a strong validator, only a single complete response may prove completeness.
    if ((start !== 0 || last + 1 !== total) && !isStrongEtag(etag)) return null;
    return { start, end: last + 1, total, etag };
};

module.exports = { MAX_AUDIO_BYTES, isStrongEtag, cleanName, normalizeContext, archiveKey, archiveRelativePath, mergeRanges, responseRange };
