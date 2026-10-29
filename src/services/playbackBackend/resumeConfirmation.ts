import type { PlaybackBackendStatus } from './types';

// Require advancing feedback and input evidence, not a desired seek target or a stationary placeholder.
export const createResumeConfirmation = (timeoutMs = 8000) => {
    let expected: { sourceId: string; position: number; startedAt: number } | null = null;
    let first: { position: number; at: number } | null = null;
    let candidate: PlaybackBackendStatus | null = null;
    let candidateAt = 0;
    let notify: ((error?: Error) => void) | null = null;
    let cancelWait: (() => void) | null = null;
    let failure: Error | null = null;
    const cancel = () => {
        expected = candidate = null;
        first = null;
        failure = null;
        cancelWait?.();
        cancelWait = notify = null;
    };
    return {
        begin: (sourceId: string, position: number) => {
            cancel();
            expected = { sourceId, position, startedAt: performance.now() };
        },
        observe: (status: PlaybackBackendStatus) => {
            if (!expected || failure || status.sourceId !== expected.sourceId) return;
            if (status.state !== 'playing') { first = candidate = null; return; }
            if (!Number.isFinite(status.position) || !Number.isFinite(status.duration) || status.duration < 0) { first = candidate = null; return; }
            const at = performance.now();
            const elapsed = Math.max(0, at - expected.startedAt) / 1000;
            if (status.position < Math.max(0, expected.position - 1.25) || status.position > expected.position + elapsed + 1.25) { first = candidate = null; return; }
            if (!first || status.position < first.position) { first = { position: status.position, at }; candidate = null; return; }
            if (status.position - first.position < 0.25 || at - first.at < 250) return;
            if (candidate && status.position <= candidate.position) return;
            candidate = { ...status };
            candidateAt = at;
            notify?.();
        },
        wait: (current: () => boolean, inputReady: () => Promise<boolean> = async () => true): Promise<PlaybackBackendStatus | null> => {
            if (!current()) return Promise.resolve(null);
            if (failure) return Promise.reject(failure);
            return new Promise((resolve, reject) => {
                let settled = false, checking = false;
                const finish = (error?: Error) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    clearInterval(poll);
                    cancelWait = notify = null;
                    if (error && current()) reject(error);
                    else resolve(current() ? candidate : null);
                };
                const check = (error?: Error) => {
                    if (error || !current()) { finish(error); return; }
                    if (!candidate || performance.now() - candidateAt > 1500 || checking || settled) return;
                    checking = true;
                    void inputReady().then(ready => {
                        if (ready && candidate && performance.now() - candidateAt <= 1500) finish();
                    }, error => finish(error instanceof Error ? error : new Error('Could not verify resumed audio input')))
                        .finally(() => { checking = false; });
                };
                const timer = setTimeout(() => finish(new Error('Playback backend did not confirm advancing playback and resumed audio input; playback remains paused')), timeoutMs);
                const poll = setInterval(check, 250);
                notify = check;
                cancelWait = () => finish();
                check();
            });
        },
        fail: (message: string) => {
            if (!expected) return;
            failure = new Error(message);
            notify?.(failure);
        },
        cancel,
    };
};
