import type { PreparedBackendSource } from './source';
import type { AudioTransferSnapshot } from '../../types/playbackTransfer';

// A single source owns polling and backoff. Cancellation invalidates every pending probe and restore.
export const createNetworkRecovery = (callbacks: {
    canSeek(): boolean;
    wantsPlay(): boolean;
    waiting(): void;
    restore(current: () => boolean): Promise<void>;
    failed(message: string): void;
}) => {
    let source: PreparedBackendSource | null = null;
    let epoch = 0;
    let pending = false;
    let running = false;
    let restoring = false;
    let restoreError: string | null = null;
    let speed = 0;
    let attachment = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;

    const cancel = (forget = false) => {
        epoch++;
        running = false;
        restoring = false;
        clearTimeout(timer);
        wake?.(); wake = undefined;
        void source?.cancelProbe?.().catch(error => console.warn('[PlaybackBackend] Cancelling network probe failed', error));
        if (forget) pending = false;
    };
    const attach = (next: PreparedBackendSource | null) => {
        cancel(true);
        clearTimeout(pollTimer);
        source = next;
        speed = 0;
        const attached = ++attachment;
        const poll = async () => {
            try {
                const transfer = await next?.getTransfer?.();
                if (attachment === attached) speed = Math.max(0, transfer?.bytesPerSecond ?? 0);
            } catch { if (attachment === attached) speed = 0; }
            if (attachment === attached && next?.getTransfer) pollTimer = setTimeout(poll, 500);
        };
        if (next?.getTransfer) void poll();
    };
    const resume = () => {
        if (!pending || running || !source?.probe || !callbacks.wantsPlay()) return;
        running = true;
        const currentSource = source, token = epoch;
        const current = () => token === epoch && source === currentSource && callbacks.wantsPlay();
        callbacks.waiting();
        void (async () => {
            let delay = 1000;
            while (current()) {
                await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, delay); });
                wake = undefined;
                if (!current()) return;
                const result = await currentSource.probe!();
                if (!current()) return;
                if (!result.ready) {
                    if (!result.retryable) throw new Error('Playback stream is unavailable or authorization has expired');
                    delay = Math.min(delay * 2, 10000);
                    continue;
                }
                restoring = true;
                restoreError = null;
                try {
                    await callbacks.restore(current);
                    if (!current()) return;
                    if (restoreError) throw new Error(restoreError);
                    pending = false;
                    console.info('[PlaybackBackend] Audio network recovered; resumed the current track');
                    return;
                } catch (error) {
                    if (!current()) return;
                    const transfer = await currentSource.getTransfer?.();
                    if (!current()) return;
                    if (!transfer?.failure?.retryable) throw error;
                } finally { if (token === epoch) restoring = false; }
                delay = Math.min(delay * 2, 10000);
            }
        })().catch(error => {
            if (current()) { pending = false; callbacks.failed(error instanceof Error ? error.message : 'Playback recovery failed'); }
        }).finally(() => { if (token === epoch) running = false; });
    };
    const recover = async () => {
        if (pending) return true;
        const previous = source, token = epoch;
        if (!previous?.getTransfer || !previous.probe || !callbacks.canSeek()) return false;
        const transfer = await previous.getTransfer();
        if (token !== epoch || previous !== source) return true;
        if (!transfer?.failure?.retryable) return false;
        pending = true;
        console.info('[PlaybackBackend] Audio stream interrupted; waiting for network');
        resume();
        return true;
    };
    return {
        attach, cancel, resume, recover,
        pending: () => pending,
        captureError: (message: string) => { if (restoring) restoreError = message; },
        checkRestore: () => { if (restoreError) throw new Error(restoreError); },
        snapshot: (): AudioTransferSnapshot | null => source?.getTransfer
            ? { buffering: pending && callbacks.wantsPlay(), bytesPerSecond: speed } : null,
    };
};
