'use strict';

const { createCapture } = require('./capture.cjs');
const { createCompletion } = require('./completion.cjs');

// Playback release may leave an 80%-qualified job alive; owner retirement, disabling or app shutdown always cancels it.
const createArchiveSession = ({ root, context, url, fetchFn, inspect, log, onSaved, onClosed }) => {
    let played = false, retained = false, released = false, closing = null;
    let completion;
    const job = createCapture(root, context, { inspect, log, onSaved, onIdle: () => completion.kick() });
    const close = (cancel = false) => {
        if (cancel) { completion.cancel(); job.cancel(); }
        else job.retire();
        closing ??= Promise.all([completion.drain(), job.drain()]).finally(onClosed);
        return closing;
    };
    completion = createCompletion({ capture: job, url, fetchFn, log, onSettled: () => { if (released) close(); } });
    return {
        response: response => released ? null : job.response(response),
        played: () => { if (!released) { played = true; job.played(); } },
        progress: seconds => {
            if (!played || released || retained || !Number.isFinite(seconds) || seconds * 1000 < context.durationMs * 0.8) return;
            retained = true;
            console.info('[AudioArchive] Retaining received audio for completion', { songKey: context.songKey, quality: context.quality });
            completion.retain();
        },
        retire: () => {
            if (released) return;
            released = true;
            if (!retained || completion.isSettled()) close();
            else completion.kick();
        },
        cancel: () => { released = true; return close(true); },
        drain: async () => { await completion.drain(); await job.drain(); await closing; },
    };
};

module.exports = { createArchiveSession };
