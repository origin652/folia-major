import { getPlaybackBackend, selectedPlaybackBackend, subscribePlaybackBackends } from './registry';
import { prepareBackendSource } from './source';
import type { PlaybackBackendDefinition, PlaybackBackendEvent, PlaybackBackendSession, PlaybackBackendStatus } from './types';
import { backendMediaShim } from '../hifi/hifiMediaShim';
import type { ArchiveContext } from '../audioArchive/types';
import { createNetworkRecovery } from './networkRecovery';
import { createResumeConfirmation } from './resumeConfirmation';

// Serializes transport intent around asynchronous opens; stale sessions cannot move the host clock.

type PreparedSource = Awaited<ReturnType<typeof prepareBackendSource>>;
type PrepareSource = (url: string, sourceId: string, allowHttp: boolean, context?: ArchiveContext) => Promise<PreparedSource>;

export const createBackendController = (prepare: PrepareSource = prepareBackendSource) => {
    const listeners = new Set<(event: PlaybackBackendEvent) => void>();
    let session: PlaybackBackendSession | null = null;
    let definition: PlaybackBackendDefinition | null = null;
    let generation = 0;
    let revision = 0;
    let wantsPlay = false;
    let volume = 1;
    let prepared: PreparedSource | null = null;
    let sourceId = '';
    let sourceUrl = '';
    let ready: Promise<void> = Promise.resolve();
    let backendReady = ready;
    let retired: { session: PlaybackBackendSession; source: PreparedSource | null } | null = null;
    let status: PlaybackBackendStatus = { sourceId, state: 'stopped', position: 0, duration: 0 };
    let capturedAt = performance.now();
    let resumeStatus = status;
    const resumeConfirmation = createResumeConfirmation();
    const recovery = createNetworkRecovery({
        canSeek: () => Boolean(definition?.capabilities.seek),
        wantsPlay: () => wantsPlay,
        waiting: () => {
            status = { ...resumeStatus, state: 'loading' };
            capturedAt = performance.now();
            notify({ type: 'status', status });
        },
        restore: current => {
            const active = session, source = prepared, position = status.position;
            const previousReady = ready;
            ready = (async () => {
                await previousReady.catch(() => {});
                const valid = () => current() && active === session && source === prepared;
                if (!valid() || !active || !source) return;
                await active.pause();
                if (!valid()) return;
                recovery.checkRestore();
                const inputBefore = (await source.getTransfer?.())?.input?.requestId;
                if (!valid()) return;
                // A reopened transport gets a new identity: late reports from the interrupted one cannot rewind it.
                sourceId = `source-${generation}-${++revision}`;
                resumeStatus = status = { ...status, sourceId };
                await active.open({ ...source.source, sourceId });
                if (!valid()) return;
                recovery.checkRestore();
                await active.seek(position);
                if (!valid()) return;
                recovery.checkRestore();
                if (definition?.capabilities.volume) await active.setVolume(volume);
                if (!valid()) return;
                recovery.checkRestore();
                resumeConfirmation.begin(sourceId, position);
                try {
                    await active.play();
                    if (!valid()) { if (active === session && !wantsPlay) await active.pause(); return; }
                    recovery.checkRestore();
                    const confirmed = await resumeConfirmation.wait(valid, async () => {
                        if (position < 1) return true;
                        const input = (await source.getTransfer?.())?.input;
                        // A fresh nonzero range read (or a complete new input) must back the native seek clock.
                        return inputBefore !== undefined && Boolean(input?.seekable
                            && (input.fullReadId > inputBefore || input.rangeReadId > inputBefore));
                    });
                    if (confirmed && valid()) {
                        recovery.checkRestore();
                        deliver({ type: 'status', status: confirmed }, generation);
                    }
                } catch (error) {
                    if (valid()) {
                        try { await active.pause(); }
                        catch (pauseError) { console.warn('[PlaybackBackend] Could not pause after failed resume', pauseError); }
                    }
                    throw error;
                } finally { resumeConfirmation.cancel(); }
            })();
            return ready;
        },
        failed: message => {
            // The failed restore was handled here; a later explicit Play must not inherit its rejected promise.
            ready = ready.catch(() => {});
            deliver({ type: 'error', sourceId, message }, generation);
        },
    });

    const notify = (event: PlaybackBackendEvent) => listeners.forEach(listener => {
        try { listener(event); }
        catch (error) { console.error('[PlaybackBackend] Listener failed', error); }
    });
    const release = async (source: PreparedSource | null) => {
        try { await source?.release(); }
        catch (error) { console.warn('[PlaybackBackend] Releasing source failed', error); }
    };
    const deliver = (event: PlaybackBackendEvent, token: number) => {
        if (token !== generation) return;
        const eventSource = event.type === 'status' ? event.status?.sourceId : event.sourceId;
        if (!sourceId || eventSource !== sourceId) return;
        if (event.type === 'status') {
            if (!Number.isFinite(event.status.position) || event.status.position < 0
                || !Number.isFinite(event.status.duration) || event.status.duration < 0
                || !['loading', 'playing', 'paused', 'stopped'].includes(event.status.state)) return;
            status = { ...event.status };
            if (status.state === 'playing' || status.state === 'paused') resumeStatus = status;
            if (status.state === 'playing') {
                prepared?.markPlayed?.();
                prepared?.progress?.(status.position);
            }
            capturedAt = performance.now();
        } else {
            wantsPlay = false;
            status = { ...status, state: event.type === 'ended' ? 'stopped' : 'paused',
                ...(event.type === 'error' && status.output ? { output: { ...status.output, exclusiveActive: null } } : {}),
            };
        }
        notify(event);
    };
    const report = (event: PlaybackBackendEvent, token: number) => {
        if (token !== generation) return;
        if ((event.type === 'status' ? event.status?.sourceId : event.sourceId) !== sourceId) return;
        if (recovery.pending()) {
            if (event.type !== 'status') {
                const message = event.type === 'error' ? event.message : 'Playback stopped before the resume position was confirmed';
                recovery.captureError(message);
                resumeConfirmation.fail(message);
            }
            if (event.type === 'status') resumeConfirmation.observe(event.status);
            return;
        }
        // An interrupted authenticated stream is not EOF, even if a backend treats early stops as ended.
        const source = prepared;
        if (!source || event.type === 'status' && (event.status.state !== 'stopped' || !source.getTransfer)
            || event.type === 'error' && !source.getTransfer
            || event.type === 'ended' && !source.getError && !source.getTransfer) { deliver(event, token); return; }
        const eventSourceId = event.type === 'status' ? event.status.sourceId : event.sourceId;
        void recovery.recover().then(async recovered => {
            if (prepared !== source || recovered) return;
            const code = event.type === 'ended' ? await source.getError?.() : null;
            if (prepared !== source) return;
            deliver(code ? { type: 'error', sourceId: eventSourceId, message: `Playback stream failed (${code})` } : event, token);
        }).catch(() => {
            if (prepared === source) deliver({ type: 'error', sourceId: eventSourceId, message: 'Playback stream status unavailable' }, token);
        });
    };

    const setBackend = async (next: PlaybackBackendDefinition | null, force = false) => {
        if (definition === next && !force && !retired) return ready;
        const token = ++generation;
        revision++;
        recovery.attach(null);
        resumeConfirmation.cancel();
        wantsPlay = false;
        const previous = session;
        const previousSource = prepared;
        if (previous) retired = { session: previous, source: previousSource };
        session = null;
        definition = next;
        prepared = null;
        sourceId = '';
        sourceUrl = '';
        status = { sourceId: '', state: 'stopped', position: 0, duration: 0 };
        resumeStatus = status;
        const previousReady = ready;
        const changing = (async () => {
            await previousReady.catch(() => {});
            if (retired) {
                const retiring = retired;
                await retiring.session.dispose();
                await release(retiring.source);
                if (retired === retiring) retired = null;
            }
            if (token === generation) {
                if (next) session = next.create(event => report(event, token));
                console.info('[PlaybackBackend] Backend session changed', { generation: token, backend: next?.name ?? null });
            }
        })();
        // Observers may synchronously open/play from this notification; publish their barrier first.
        backendReady = ready = changing;
        notify({ type: 'status', status });
        await changing;
    };

    const open = (url: string, context?: ArchiveContext) => {
        if (url === sourceUrl && sourceId) return ready;
        const currentRevision = ++revision;
        recovery.attach(null);
        resumeConfirmation.cancel();
        const token = generation;
        wantsPlay = false;
        sourceUrl = url;
        sourceId = `source-${token}-${currentRevision}`;
        const id = sourceId;
        status = { sourceId: id, state: 'loading', position: 0, duration: 0 };
        resumeStatus = status;
        capturedAt = performance.now();
        const previousReady = ready;
        const selectedReady = backendReady;
        const loading = (async () => {
            await previousReady.catch(() => {});
            if (token !== generation || currentRevision !== revision) return;
            await selectedReady;
            if (token !== generation || currentRevision !== revision) return;
            if (!session || !definition) {
                console.warn('[PlaybackBackend] Source open has no backend session', { generation: token, revision: currentRevision,
                    backend: definition?.name ?? null, retired: Boolean(retired) });
                throw new Error('playback-backend-unavailable');
            }
            const active = session;
            await active.pause();
            const next = context ? await prepare(url, id, definition.capabilities.http, context)
                : await prepare(url, id, definition.capabilities.http);
            if (token !== generation || currentRevision !== revision) { await release(next); return; }
            const previous = prepared;
            prepared = next;
            recovery.attach(next);
            try {
                await active.open(next.source);
                if (token === generation && currentRevision === revision && definition?.capabilities.volume) await active.setVolume(volume);
            } catch (error) {
                if (token === generation && currentRevision === revision && await recovery.recover()) return;
                if (prepared === next) prepared = null;
                recovery.attach(null);
                await release(next);
                throw error;
            } finally { await release(previous); }
        })().catch(error => {
            if (token === generation && currentRevision === revision) {
                sourceUrl = '';
                wantsPlay = false;
                status = { ...status, state: 'paused' };
            }
            throw error;
        });
        ready = loading;
        notify({ type: 'status', status });
        return loading;
    };

    const play = async () => {
        wantsPlay = true;
        const token = generation;
        const id = sourceId;
        try { await ready; }
        catch (error) { if (!recovery.pending()) throw error; }
        if (token !== generation || id !== sourceId || !wantsPlay) return false;
        if (!session) throw new Error('playback-backend-unavailable');
        if (recovery.pending()) { recovery.resume(); return false; }
        try { await session.play(); }
        catch (error) {
            if (token === generation && id === sourceId && await recovery.recover()) return false;
            throw error;
        }
        // A pause may have arrived while the backend was starting.
        if (!wantsPlay && token === generation) await session.pause();
        return token === generation && id === sourceId && wantsPlay && !recovery.pending();
    };
    const pause = async () => {
        wantsPlay = false;
        recovery.cancel();
        resumeConfirmation.cancel();
        if (recovery.pending()) {
            status = { ...status, state: 'paused' };
            notify({ type: 'status', status });
        }
        const token = generation;
        await ready.catch(() => {});
        if (token === generation) await session?.pause();
    };
    const seek = async (seconds: number) => {
        if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('invalid-backend-seek');
        const id = sourceId;
        await ready;
        if (id !== sourceId || !session) return;
        if (!definition?.capabilities.seek) throw new Error('backend-seek-unsupported');
        if (recovery.pending()) { resumeStatus = status = { ...status, position: seconds }; return; }
        await session.seek(seconds);
    };
    const setVolume = async (value: number) => {
        if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('invalid-backend-volume');
        volume = value;
        if (session && definition?.capabilities.volume) await session.setVolume(value);
    };

    return {
        setBackend, open, play, pause, seek, setVolume,
        stop: () => setBackend(definition, true),
        getStatus: () => status,
        getSourceUrl: () => sourceUrl,
        getTransferStatus: () => {
            const transfer = recovery.snapshot();
            return transfer ? { ...transfer, buffering: transfer.buffering || status.state === 'loading' } : null;
        },
        isWaitingForNetwork: () => Boolean(recovery.snapshot()?.buffering),
        getPosition: () => status.state === 'playing'
            ? Math.min(status.duration || Infinity, status.position + Math.min(1, (performance.now() - capturedAt) / 1000))
            : status.position,
        subscribe: (listener: (event: PlaybackBackendEvent) => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
};

export const backendPlayback = createBackendController();
backendMediaShim.setClockReader(backendPlayback.getPosition);
let observedSource = '';
backendPlayback.subscribe(event => {
    if (event.type === 'status') {
        const { status } = event;
        if (status.sourceId !== observedSource) {
            observedSource = status.sourceId;
            if (observedSource) backendMediaShim.beginTrack(observedSource);
            else backendMediaShim.reset();
        }
        backendMediaShim.setDuration(status.duration);
        if (status.state === 'playing') {
            if (backendMediaShim.paused) backendMediaShim.markPlaying();
        } else backendMediaShim.markPaused();
    } else if (event.type === 'ended') backendMediaShim.markEnded();
    else backendMediaShim.markPaused();
});
export const usesPlaybackBackend = () => selectedPlaybackBackend() !== null;
subscribePlaybackBackends(() => {
    const entry = getPlaybackBackend();
    if (!entry && selectedPlaybackBackend()) console.warn('[PlaybackBackend] Selected backend registration is unavailable', { id: selectedPlaybackBackend() });
    void backendPlayback.setBackend(entry?.definition ?? null).catch(error => {
        console.error('[PlaybackBackend] Backend change failed', error);
    });
});
