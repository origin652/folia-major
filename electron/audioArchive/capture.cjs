'use strict';

const fs = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { responseRange, isStrongEtag, mergeRanges, archiveRelativePath, archiveKey } = require('./model.cjs');
const { childPath, hashFile, inspectAudio } = require('./files.cjs');

// A bounded, asynchronous disk observer: playback never waits for disk writes or archive validation.
const createCapture = (root, context, { log, onSaved, onIdle = () => {}, inspect = inspectAudio }) => {
    let queue = Promise.resolve(), pendingBytes = 0, file = null, temporary = null;
    let played = false, retired = false, failed = false, finalized = false, total = null, validator = null;
    let ranges = [], transfers = 0;
    const schedule = action => {
        queue = queue.then(action).catch(error => {
            failed = true;
            log('Archive write skipped', error);
        });
        return queue;
    };
    const cleanup = async () => {
        await file?.close(); file = null;
        if (temporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') log('Archive temporary cleanup failed', error); });
        temporary = null;
    };
    const finish = async () => {
        if (finalized) return;
        if (failed || (retired && (!played || ranges.length !== 1 || ranges[0][0] !== 0 || ranges[0][1] !== total))) {
            failed = true; await cleanup(); return;
        }
        if (!played || transfers || !total || ranges.length !== 1 || ranges[0][0] !== 0 || ranges[0][1] !== total) return;
        finalized = true;
        try {
            await file.sync(); await file.close(); file = null;
            const type = await inspect(temporary, context.durationMs);
            const sha256 = await hashFile(temporary);
            if (failed) return;
            const relative = archiveRelativePath(context, type.ext);
            const destination = await childPath(root, relative, true);
            // Never overwrite a file the listener or a different archive session already owns.
            try { await fs.copyFile(temporary, destination, fs.constants.COPYFILE_EXCL); }
            catch (error) {
                if (error.code !== 'EEXIST' || await hashFile(destination) !== sha256) throw error;
            }
            const index = await childPath(root, `.folia-index/${archiveKey(context)}.json`, true);
            const staging = `${index}.${randomBytes(8).toString('hex')}.part`;
            try {
                await fs.writeFile(staging, JSON.stringify({ version: 1, ...context, relative, size: total, sha256, mimeType: type.mime }), { flag: 'wx' });
                await fs.rename(staging, index);
            } finally { await fs.unlink(staging).catch(error => { if (error.code !== 'ENOENT') log('Archive index cleanup failed', error); }); }
            onSaved(context);
        } finally { await cleanup(); }
    };
    return {
        played: () => { played = true; schedule(finish); },
        retire: () => { retired = true; schedule(finish); },
        cancel: () => { failed = true; retired = true; schedule(cleanup); },
        snapshot: () => queue.then(() => ({ total, validator, transfers, failed, finalized, ranges: ranges.map(range => [...range]) })),
        response: response => {
            if (failed || finalized || retired) return null;
            const range = responseRange(response);
            if (!range) return null;
            if (total !== null && (total !== range.total || !isStrongEtag(validator) || validator !== range.etag)) {
                failed = true; schedule(cleanup); return null;
            }
            total = range.total; validator = range.etag;
            transfers++;
            if (!temporary) schedule(async () => {
                if (file || failed) return;
                temporary = await childPath(root, `.folia-partials/${randomBytes(16).toString('hex')}.part`, true);
                file = await fs.open(temporary, 'wx');
            });
            let received = 0, ended = false;
            return {
                write: data => {
                    if (failed || finalized || ended) return;
                    const offset = range.start + received;
                    received += data.length;
                    if (received > range.end - range.start || pendingBytes + data.length > 8 * 1024 * 1024) {
                        failed = true; schedule(cleanup); return;
                    }
                    const copy = Buffer.from(data);
                    pendingBytes += copy.length;
                    return schedule(async () => {
                        try {
                            if (failed) return;
                            let written = 0;
                            while (written < copy.length) {
                                const result = await file.write(copy, written, copy.length - written, offset + written);
                                if (!result.bytesWritten) throw new Error('Archive disk write made no progress');
                                written += result.bytesWritten;
                            }
                        } finally { pendingBytes -= copy.length; }
                    });
                },
                end: success => {
                    if (ended) return; ended = true;
                    schedule(async () => {
                        transfers--;
                        // A cancelled playback read still contributed version-validated bytes; only its missing tail needs fetching.
                        if ((!success || received !== range.end - range.start) && !isStrongEtag(validator)) failed = true;
                        if (received) ranges = mergeRanges(ranges, range.start, range.start + received);
                        await finish();
                        if (!transfers) onIdle();
                    });
                },
            };
        },
        drain: () => queue,
    };
};

module.exports = { createCapture };
