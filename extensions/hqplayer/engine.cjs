'use strict';

const { HqConnection } = require('./connection.cjs');
const { stageHqpSource } = require('./mediaSource.cjs');
const { normalizeConfig, decodeStatus, decodeVolumeRange, volumeTarget } = require('./protocol.cjs');
const { ensureHqplayer } = require('./launcher.cjs');
const { readDsp, planDsp, applyDsp } = require('./dsp.cjs');
const { confirmResumeSeek } = require('./resumeSeek.cjs');

// Owns one local HQPlayer URI transport, not the process, license, filters or device configuration.

const createHqpEngine = (report, cache, { connect = config => new HqConnection(config), prepare = stageHqpSource,
    ensureRunning = ensureHqplayer, pollMs = 500 } = {}) => {
    let config = normalizeConfig();
    let connection = null;
    let source = null;
    let media = null;
    let range = null;
    let owned = false;
    let loaded = false;
    let pendingSeek = null;
    let trackId = '';
    let volume = 1;
    let volumeBlocked = false;
    let ceilingDb = config.ceilingDb;
    let originalFlags = null;
    let previous = null;
    let transitionSince = null;
    let playing = false;
    let timer = null;
    const retiredMedia = new Set();
    let work = Promise.resolve();
    const enqueue = action => {
        const result = work.then(action);
        work = result.catch(() => {});
        return result;
    };
    const request = (name, attrs) => connection.request(name, attrs);
    const readStatus = async () => decodeStatus(await request('Status', { subscribe: 0 }));
    const pauseOutput = async () => {
        // Do not send a pause toggle to an already paused/stopped external player.
        if ((await readStatus()).state === 'playing') await request('Pause');
        for (let attempt = 0; attempt < 10; attempt++) {
            const status = await readStatus();
            if (status.state === 'paused' || status.state === 'stopped') return;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('HQPlayer did not pause; confirm output is stopped in HQPlayer');
    };
    const statusEvent = status => {
        if (source) report({ type: 'status', status: { sourceId: source.sourceId, state: status.state, position: status.position, duration: status.duration } });
        // No output.exclusiveActive claim: this API does not prove exclusive device access.
    };
    const fail = error => {
        clearTimeout(timer);
        timer = null;
        playing = false;
        transitionSince = null;
        if (source) report({ type: 'error', sourceId: source.sourceId, message: error.message });
    };
    const stillOwns = status => (['stopped', 'loading'].includes(status.state) && status.tracks === 0)
        || (status.tracks === 1 && ((!!trackId && status.trackId === trackId)
            || (loaded && (!trackId || !status.trackId))));
    const retireEmptyTransport = status => {
        if (!loaded || status.state !== 'stopped' || status.tracks !== 0) return;
        // Play(last=0) cannot resume a URI that HQPlayer has already removed.
        loaded = false;
        trackId = '';
        pendingSeek ??= Math.floor(previous?.position ?? 0);
    };
    const stopOutput = async () => {
        await request('Stop');
        for (let attempt = 0; attempt < 10; attempt++) {
            const status = await readStatus();
            if (status.state === 'stopped') return;
            if (!stillOwns(status)) { owned = false; throw new Error('HQPlayer transport changed while stopping'); }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('HQPlayer did not stop; confirm output is stopped in HQPlayer');
    };
    const waitForLoaded = async () => {
        // PlayNextURI acknowledges before the new URI transport's track count is published.
        for (let attempt = 0; attempt < 20; attempt++) {
            const status = await readStatus();
            if (status.tracks === 1 && status.state === 'playing') {
                trackId = status.trackId;
                return;
            }
            if (status.tracks > 1) {
                owned = false;
                loaded = false;
                throw new Error('HQPlayer playlist changed outside Folia while loading');
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error('HQPlayer did not finish loading the URI; check its device and processing settings');
    };
    const releaseRetired = async () => {
        for (const retired of retiredMedia) {
            try {
                await retired.release();
                retiredMedia.delete(retired);
            } catch (error) {
                if (error.code !== 'EBUSY') throw error;
                // Stop does not necessarily close the Windows decoder handle; retry after the next URI loads.
                console.warn('[HQPlayer] Stopped source is still locked; cache cleanup deferred', error);
            }
        }
    };
    const poll = async () => {
        const status = await readStatus();
        if (!stillOwns(status)) {
            // Another controller took over. Do not stop or clear its playlist.
            owned = false;
            loaded = false;
            throw new Error('HQPlayer playlist changed outside Folia; select the backend again to reconnect');
        }
        if (status.trackId) trackId = status.trackId;
        if (status.state === 'loading') {
            // STOPREQ can temporarily clear track count and clock before publishing STOPPED.
            transitionSince ??= Date.now();
            if (Date.now() - transitionSince >= 10000) throw new Error('HQPlayer is still stopping; check its device and processing load');
            return;
        }
        transitionSince = null;
        const stopped = playing && status.state === 'stopped';
        const nearEnd = previous?.duration > 0
            && Math.max(previous.position, status.position) >= previous.duration - 1.25;
        if (stopped && !nearEnd) {
            if (config.earlyStopAsEnded) {
                // User-requested temporary policy, not evidence that the audio really reached EOF.
                console.warn('[HQPlayer] Early stop treated as track end by temporary policy', {
                    lastPosition: previous?.position ?? 0, lastDuration: previous?.duration ?? 0,
                    stoppedPosition: status.position, stoppedDuration: status.duration, tracks: status.tracks,
                });
            } else {
                retireEmptyTransport(status);
                const last = previous?.position ?? 0;
                const duration = previous?.duration ?? 0;
                throw new Error(`HQPlayer stopped before the track ended (last ${last.toFixed(3)} / ${duration.toFixed(3)} s; stopped ${status.position.toFixed(3)} / ${status.duration.toFixed(3)} s; tracks ${status.tracks}). Check its device, license and processing load; press Play to retry. No automatic restart.`);
            }
        }
        const ended = stopped && (nearEnd || config.earlyStopAsEnded);
        statusEvent(status);
        previous = status;
        if (ended) {
            playing = false;
            loaded = false;
            pendingSeek = null;
            if (status.tracks === 0) trackId = '';
            report({ type: 'ended', sourceId: source.sourceId });
        }
    };
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            void enqueue(poll).then(() => { if (source && owned && loaded) schedule(); }, fail);
        }, pollMs);
        timer.unref?.();
    };
    const cleanup = async () => {
        clearTimeout(timer);
        timer = null;
        playing = false;
        try {
            if (owned && connection && !connection.closed) {
                const status = await readStatus();
                if (stillOwns(status)) {
                    await stopOutput();
                    if (originalFlags && status.repeat === 0 && status.random === 0) {
                        await request('SetRepeat', { value: originalFlags.repeat });
                        await request('SetRandom', { value: originalFlags.random });
                    }
                }
            } else if (owned) throw new Error('HQPlayer connection lost; confirm playback has stopped in HQPlayer');
        } finally {
            owned = false;
            loaded = false;
            pendingSeek = null;
            trackId = '';
            originalFlags = null;
            connection?.close();
            connection = null;
            source = null;
            range = null;
            previous = null;
            transitionSince = null;
            const retired = media;
            media = null;
            if (retired) retiredMedia.add(retired);
            await releaseRetired();
        }
    };
    const applyVolume = async () => {
        const target = volumeTarget(volume, { ...config, ceilingDb }, range);
        if (volume === 0) {
            playing = false;
            await pauseOutput();
            return;
        }
        await request('Volume', { value: target.toFixed(6) });
        const actual = await readStatus();
        if (Math.abs(actual.volumeDb - target) > 0.15) throw new Error('HQPlayer did not accept the requested volume; playback remains paused');
    };
    const run = action => enqueue(async () => {
        try { return await action(); }
        catch (error) { fail(error); throw error; }
    });
    const withDspConnection = async (values, action) => {
        const target = normalizeConfig(values);
        if (connection && !connection.closed) {
            if (target.port !== config.port) throw new Error('HQPlayer connection is changing; wait, then refresh DSP options');
            return action(connection);
        }
        // Settings reads never launch HQPlayer or configure/take over a playback session.
        const temporary = connect(target);
        try {
            const info = await temporary.request('GetInfo');
            if (!/HQPlayer/.test(info.getAttribute('product') || '')) throw new Error('The selected service is not HQPlayer');
            return await action(temporary);
        } finally { temporary.close(); }
    };

    return {
        readDsp: values => enqueue(() => withDspConnection(values, readDsp)),
        applyDsp: (values, revision, patch) => enqueue(() => withDspConnection(values, async control => {
            // Validate a fresh snapshot before stopping anything or sending a setter.
            const snapshot = await readDsp(control);
            const changes = planDsp(snapshot, revision, patch);
            if (!Object.keys(changes).length) return snapshot;
            const status = decodeStatus(await control.request('Status', { subscribe: 0 }));
            if (owned && !stillOwns(status)) {
                owned = false;
                throw new Error('HQPlayer transport changed outside Folia; refusing to change its DSP');
            }
            if (!owned && (status.state !== 'stopped' || status.tracks > 0)) {
                throw new Error('Stop and clear external HQPlayer playback before changing DSP from Folia');
            }
            if (owned) {
                clearTimeout(timer);
                timer = null;
                playing = false;
                try { await stopOutput(); }
                catch (error) { fail(error); throw error; }
                if (loaded) pendingSeek = Math.floor(status.position);
                loaded = false;
                trackId = '';
                transitionSince = null;
                previous = { state: 'paused', position: pendingSeek ?? 0, duration: previous?.duration ?? 0 };
                statusEvent(previous);
            }
            return applyDsp(control, snapshot, changes);
        })),
        configure: values => run(async () => {
            const next = normalizeConfig(values);
            await cleanup();
            config = next;
            volumeBlocked = false;
        }),
        open: next => run(async () => {
            clearTimeout(timer);
            volumeBlocked = true;
            if (!connection || connection.closed) {
                await ensureRunning(config);
                connection = connect(config);
                try {
                    const info = await request('GetInfo');
                    if (!/HQPlayer/.test(info.getAttribute('product') || '')) throw new Error('The selected service is not HQPlayer');
                } catch (error) {
                    connection.close();
                    connection = null;
                    throw error;
                }
            }
            const before = await readStatus();
            if (owned && !stillOwns(before)) {
                owned = false;
                throw new Error('HQPlayer playlist changed outside Folia; refusing to replace it');
            }
            range = decodeVolumeRange(await request('VolumeRange'));
            if (!owned) ceilingDb = Math.min(config.ceilingDb, before.volumeDb);
            volumeTarget(1, { ...config, ceilingDb }, range);
            if (!owned && !config.takeOver && (before.state !== 'stopped' || before.tracks > 0)) {
                throw new Error('HQPlayer already has playback or a playlist. Stop and clear it, or explicitly allow playlist takeover in this mod.');
            }
            const staged = await prepare(next, cache);
            try {
                await stopOutput();
                owned = true;
                originalFlags ??= { repeat: before.repeat, random: before.random };
                await request('SetRepeat', { value: 0 });
                await request('SetRandom', { value: 0 });
                const retired = media;
                media = staged;
                source = next;
                loaded = false;
                pendingSeek = null;
                trackId = '';
                if (retired) retiredMedia.add(retired);
            } catch (error) {
                const adopted = media === staged;
                if (owned) {
                    try { await cleanup(); }
                    catch (cleanupError) { console.error('[HQPlayer] Failed-load cleanup failed', cleanupError); }
                }
                if (!adopted) await staged.release();
                throw error;
            }
            playing = false;
            transitionSince = null;
            previous = { state: 'paused', position: 0, duration: 0 };
            volumeBlocked = false;
            await applyVolume();
            statusEvent(previous);
        }),
        play: () => run(async () => {
            if (!owned || !source || volumeBlocked) throw new Error('HQPlayer output is not ready; correct the last error and reload the track');
            if (volume === 0) throw new Error('Folia is muted. HQPlayer output stays paused until you unmute and press Play.');
            const before = await readStatus();
            if (!stillOwns(before)) {
                owned = false;
                loaded = false;
                throw new Error('HQPlayer playlist changed outside Folia; refusing to start playback');
            }
            retireEmptyTransport(before);
            await applyVolume();
            const wasLoaded = loaded;
            if (!loaded) {
                // Match the working official --play-next-uri path; PlaylistAdd can terminate HQPlayer 6 here.
                await request('PlayNextURI', { value: media.uri, freewheel: 0 });
                loaded = true;
                await waitForLoaded();
                await releaseRetired();
            }
            if (pendingSeek !== null) {
                // Hold the newly started URI while its decoder catches up. Never knowingly continue at zero.
                await pauseOutput();
                let confirmed;
                try { confirmed = await confirmResumeSeek({ request, readStatus, stillOwns }, pendingSeek); }
                catch (error) {
                    try {
                        const actual = await readStatus();
                        if (stillOwns(actual)) await pauseOutput();
                        else owned = false;
                    } catch (pauseError) { console.warn('[HQPlayer] Could not confirm paused output after failed resume', pauseError); }
                    throw error;
                }
                pendingSeek = null;
                previous = confirmed;
                await request('Play', { last: 0 });
            } else if (wasLoaded) await request('Play', { last: 0 });
            playing = true;
            await poll();
            schedule();
        }),
        pause: () => run(async () => {
            playing = false;
            if (!owned || !loaded) return;
            await pauseOutput();
            await poll();
        }),
        seek: seconds => run(async () => {
            if (!owned || !Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid HQPlayer seek');
            if (!loaded) {
                pendingSeek = Math.floor(seconds);
                previous = { state: 'paused', position: pendingSeek, duration: 0 };
                statusEvent(previous);
                return;
            }
            await request('Seek', { position: Math.floor(seconds) });
            await poll();
        }),
        setVolume: value => run(async () => {
            if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('Invalid Folia volume');
            volume = value;
            if (!owned || !loaded) return;
            try { await applyVolume(); volumeBlocked = false; await poll(); }
            catch (error) {
                volumeBlocked = true;
                playing = false;
                try { await pauseOutput(); }
                catch (pauseError) { console.error('[HQPlayer] Could not pause after volume refusal', pauseError); }
                throw error;
            }
        }),
        dispose: () => enqueue(cleanup),
    };
};

module.exports = { createHqpEngine };
