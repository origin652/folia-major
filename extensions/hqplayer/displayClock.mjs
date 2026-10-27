// Adapts sparse HQPlayer positions to the existing host's one-second linear interpolation.

const HOST_EXTRAPOLATION_SEC = 1;
const BACKWARD_SEEK_SEC = 0.25;
const DISCONTINUITY_SEC = 2;
const MAX_FORWARD_CORRECTION_SEC = 0.02;
const SEEK_SETTLE_MS = 3000;

export const createHqpDisplayClock = (report, { now = () => performance.now() } = {}) => {
    let sourceId = '';
    let raw = null;
    let forwarded = null;
    let highWater = 0;
    let fractional = false;
    let terminal = false;
    let seeking = null;

    const emit = status => {
        forwarded = { ...status, at: now() };
        report({ type: 'status', status });
    };
    const reset = status => {
        raw = status;
        highWater = status.position;
        fractional ||= !Number.isInteger(status.position);
        emit(status);
    };
    const projected = () => {
        if (!forwarded) return 0;
        const elapsed = forwarded.state === 'playing'
            ? Math.min(HOST_EXTRAPOLATION_SEC, Math.max(0, now() - forwarded.at) / 1000) : 0;
        return Math.min(forwarded.duration || Infinity, forwarded.position + elapsed);
    };

    return {
        setSource: id => {
            sourceId = id;
            raw = forwarded = seeking = null;
            highWater = 0;
            fractional = terminal = false;
        },
        receive: event => {
            const id = event.type === 'status' ? event.status?.sourceId : event.sourceId;
            if (!sourceId || id !== sourceId || terminal) return;
            if (event.type !== 'status') {
                terminal = event.type;
                seeking = null;
                report(event);
                return;
            }
            const next = event.status;
            if (!Number.isFinite(next.position) || next.position < 0 || !Number.isFinite(next.duration)
                || next.duration < 0 || !['loading', 'playing', 'paused', 'stopped'].includes(next.state)) return;
            if (seeking) {
                seeking.sample = next;
                if (seeking.acknowledged && (Math.abs(next.position - seeking.target) <= 1
                    || now() >= seeking.deadline)) {
                    seeking = null;
                    reset(next);
                }
                return;
            }
            if (!raw || raw.state !== 'playing' || next.state !== 'playing') {
                reset(next);
                return;
            }
            const current = projected();
            fractional ||= !Number.isInteger(next.position);
            const backwards = next.position < highWater - BACKWARD_SEEK_SEC;
            const forwards = next.position - current > DISCONTINUITY_SEC;
            raw = next;
            if (backwards || forwards) {
                reset(next);
                return;
            }
            // Do not refresh the host anchor for repeats or small backwards timestamp noise.
            if (next.position <= highWater) return;
            highWater = next.position;
            // If the local clock leads too far, let the host's existing extrapolation cap hold it
            // until HQPlayer catches up. Repeated fresh reports must not create unbounded drift.
            if (current - next.position > (fractional ? 0.25 : 1.25)) return;
            const correction = Math.min(MAX_FORWARD_CORRECTION_SEC, Math.max(0, next.position - current));
            emit({ ...next, position: Math.min(next.duration || Infinity, current + correction) });
        },
        beginSeek: seconds => {
            if (!sourceId || terminal === 'error' || !Number.isFinite(seconds) || seconds < 0) return;
            terminal = false;
            seeking = { target: Math.floor(seconds), acknowledged: false, sample: null, deadline: Infinity };
            // A deliberate seek may move backwards. Hold its target while the command is in flight
            // so a queued pre-seek poll cannot pull the old host back to the previous position.
            emit({ sourceId, state: 'loading', position: seeking.target, duration: raw?.duration ?? 0 });
        },
        finishSeek: () => {
            if (!seeking) return;
            seeking.acknowledged = true;
            seeking.deadline = now() + SEEK_SETTLE_MS;
            const next = seeking.sample;
            if (next && Math.abs(next.position - seeking.target) <= 1) {
                seeking = null;
                reset(next);
            }
        },
        cancelSeek: () => {
            seeking = null;
            if (!terminal && raw) reset(raw);
        },
    };
};
