'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { parseRangeHeader } = require('../transcode/protocol.cjs');
const { normalizeContext, archiveKey, MAX_AUDIO_BYTES } = require('./model.cjs');
const { childPath, hashFile } = require('./files.cjs');
const { createArchiveSession } = require('./session.cjs');

// Host-owned archive settings, capture jobs and opaque local playback tickets; no provider credentials are stored.
const ARCHIVE_SCHEME = 'folia-archive';
const createAudioArchive = ({ readSettings, writeSettings, inspect, log = (...args) => console.warn('[AudioArchive]', ...args) }) => {
    const tickets = new Map(), jobs = new Map();
    let savedCount = 0, lastSaved = null;
    const settings = () => {
        const value = readSettings() || {};
        return { enabled: value.enabled === true, preferLocal: value.preferLocal !== false,
            directory: typeof value.directory === 'string' ? value.directory : '', savedCount, lastSaved };
    };
    const configure = patch => {
        const before = settings();
        const next = { enabled: before.enabled, preferLocal: before.preferLocal, directory: before.directory };
        for (const name of ['enabled', 'preferLocal']) if (typeof patch?.[name] === 'boolean') next[name] = patch[name];
        if (next.enabled && !next.directory) throw new Error('Choose an archive directory first');
        writeSettings(next);
        if (!next.enabled) for (const job of jobs.keys()) void job.cancel();
        return settings();
    };
    const choose = async directory => {
        const resolved = await fs.realpath(directory);
        if (!(await fs.stat(resolved)).isDirectory()) throw new Error('Archive root is not a directory');
        for (const job of jobs.keys()) void job.cancel();
        writeSettings({ ...settings(), enabled: false, directory: resolved });
        return settings();
    };
    const capture = (value, { url, fetchFn, ownerId } = {}) => {
        const config = settings(), context = normalizeContext(value);
        if (!config.enabled || !config.directory || !context || jobs.size >= 8) return null;
        const job = createArchiveSession({ root: config.directory, context, url, fetchFn, inspect, log,
            onClosed: () => jobs.delete(job), onSaved: saved => {
                savedCount++; lastSaved = saved.title;
                console.info('[AudioArchive] Complete audio archived', { songKey: saved.songKey, quality: saved.quality });
            } });
        jobs.set(job, ownerId);
        return job;
    };
    const find = async (query, ownerId) => {
        const config = settings();
        if (!config.preferLocal || !config.directory || typeof query?.songKey !== 'string' || query.songKey.length > 512
            || typeof query?.quality !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(query.quality)) return null;
        try {
            const index = await childPath(config.directory, `.folia-index/${archiveKey(query)}.json`);
            if ((await fs.stat(index)).size > 16384) return null;
            const entry = JSON.parse(await fs.readFile(index, 'utf8'));
            if (entry.version !== 1 || !normalizeContext(entry) || entry.songKey !== query.songKey || entry.quality !== query.quality
                || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_AUDIO_BYTES
                || !/^[a-f0-9]{64}$/.test(entry.sha256) || !/^audio\//.test(entry.mimeType)) return null;
            const file = await childPath(config.directory, entry.relative);
            const suffix = path.extname(file).toLowerCase();
            if (!/^\.(flac|wav|aif|mp3|m4a|mp4|ogg|opus|wv|dsf|dff|ape|caf)$/.test(suffix)) return null;
            const stat = await fs.stat(file);
            if (!stat.isFile() || stat.size !== entry.size || await hashFile(file) !== entry.sha256) {
                log('Local archive failed integrity check', { songKey: query.songKey }); return null;
            }
            // Prefetch must not revoke the address the same song is already playing or seeking through.
            for (const [token, ticket] of tickets) {
                if (ticket.ownerId === ownerId && ticket.key === archiveKey(query) && ticket.file === file && ticket.mtimeMs === stat.mtimeMs) {
                    return { url: `${ARCHIVE_SCHEME}://audio/${token}/audio${suffix}`, quality: entry.quality };
                }
            }
            if (tickets.size >= 256) tickets.delete(tickets.keys().next().value);
            const token = randomBytes(16).toString('hex');
            tickets.set(token, { ownerId, file, root: config.directory, relative: entry.relative, size: stat.size,
                mimeType: entry.mimeType, key: archiveKey(query), mtimeMs: stat.mtimeMs, suffix });
            return { url: `${ARCHIVE_SCHEME}://audio/${token}/audio${suffix}`, quality: entry.quality };
        } catch (error) {
            if (error.code !== 'ENOENT') log('Local archive lookup skipped', { code: error.code || 'invalid-entry' });
            return null;
        }
    };
    const response = async request => {
        const url = new URL(request.url), token = /^\/([a-f0-9]{32})\/audio\.[a-z0-9]+$/.exec(url.pathname)?.[1];
        const ticket = url.hostname === 'audio' && !url.search && !url.hash && token ? tickets.get(token) : null;
        if (ticket && url.pathname !== `/${token}/audio${ticket.suffix}`) return new Response(null, { status: 404 });
        if (!ticket || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 });
        try {
            const file = await childPath(ticket.root, ticket.relative), stat = await fs.stat(file);
            if (file !== ticket.file || stat.size !== ticket.size || stat.mtimeMs !== ticket.mtimeMs) return new Response(null, { status: 404 });
            const range = parseRangeHeader(request.headers.get('range'), stat.size);
            if (range?.invalid) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
            const headers = { 'Content-Type': ticket.mimeType, 'Content-Length': String(range ? range.end - range.start + 1 : stat.size),
                'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
            if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`;
            return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file, range || undefined)), { status: range ? 206 : 200, headers });
        } catch { return new Response(null, { status: 404 }); }
    };
    const releaseOwner = ownerId => {
        for (const [id, ticket] of tickets) if (ticket.ownerId === ownerId) tickets.delete(id);
        for (const [job, owner] of jobs) if (owner === ownerId) void job.cancel();
    };
    const dispose = async () => {
        tickets.clear();
        await Promise.all([...jobs.keys()].map(job => job.cancel()));
        jobs.clear();
    };
    return { settings, configure, choose, capture, find, response, releaseOwner, dispose };
};

module.exports = { ARCHIVE_SCHEME, createAudioArchive };
