import type { PlaybackBackendStatus } from './types';

// Resume from an observed playing clock, never from the desired seek target or a paused placeholder.
export const createResumeConfirmation = (timeoutMs = 8000) => {
    let expected: { sourceId: string; position: number; startedAt: number } | null = null;
    let candidate: PlaybackBackendStatus | null = null;
    let notify: ((error?: Error) => void) | null = null;
    let cancelWait: (() => void) | null = null;
    let failure: Error | null = null;
    const cancel = () => {
        expected = candidate = null;
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
            if (!expected || failure || status.sourceId !== expected.sourceId || status.state !== 'playing'
                || !Number.isFinite(status.position) || !Number.isFinite(status.duration) || status.duration < 0) return;
            const elapsed = Math.max(0, performance.now() - expected.startedAt) / 1000;
            if (status.position < Math.max(0, expected.position - 1.25) || status.position > expected.position + elapsed + 1.25) return;
            candidate = { ...status };
            notify?.();
        },
        wait: (current: () => boolean): Promise<PlaybackBackendStatus | null> => {
            if (!current()) return Promise.resolve(null);
            if (failure) return Promise.reject(failure);
            if (candidate) return Promise.resolve(candidate);
            return new Promise((resolve, reject) => {
                const finish = (error?: Error) => {
                    clearTimeout(timer);
                    cancelWait = notify = null;
                    if (error && current()) reject(error);
                    else resolve(current() ? candidate : null);
                };
                const timer = setTimeout(() => finish(new Error('Playback backend did not confirm the resume position; playback remains paused')), timeoutMs);
                notify = finish;
                cancelWait = () => finish();
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
