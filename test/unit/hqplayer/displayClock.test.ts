import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHqpDisplayClock } from '../../../extensions/hqplayer/displayClock.mjs';
import { createBackendController } from '../../../src/services/playbackBackend/controller';
import type { PlaybackBackendEvent, PlaybackBackendSession, PlaybackBackendStatus } from '../../../src/services/playbackBackend/types';

// Exercise the mod against the unchanged host controller, including its raw event/MotionValue writer.

const controllers: ReturnType<typeof createBackendController>[] = [];
const setup = async (filtered = true) => {
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    let forward!: (event: PlaybackBackendEvent) => void;
    const controller = createBackendController(async (url, sourceId) => ({ source: { url, sourceId }, release: async () => {} }));
    controllers.push(controller);
    const session: PlaybackBackendSession = {
        open: async () => {}, play: async () => {}, pause: async () => {}, seek: async () => {},
        setVolume: async () => {}, dispose: async () => {},
    };
    await controller.setBackend({ name: 'HQPlayer test', capabilities: { seek: true, volume: true, http: true },
        create: report => { forward = report; return session; } });
    await controller.open('https://test/one');
    const sourceId = controller.getStatus().sourceId;
    const reports: PlaybackBackendEvent[] = [];
    const observations: number[] = [];
    controller.subscribe(event => {
        // useBackendPlayback sets currentTime to this raw position before the next visualizer frame.
        if (event.type === 'status') observations.push(event.status.position);
    });
    const clock = createHqpDisplayClock((event: PlaybackBackendEvent) => { reports.push(event); forward(event); });
    clock.setSource(sourceId);
    const status = (position: number, state: PlaybackBackendStatus['state'] = 'playing', duration = 10000): PlaybackBackendStatus => ({ sourceId, position, state, duration });
    const send = (position: number, state: PlaybackBackendStatus['state'] = 'playing', duration = 10000) => {
        const event: PlaybackBackendEvent = { type: 'status', status: status(position, state, duration) };
        if (filtered) clock.receive(event);
        else forward(event);
    };
    return { controller, clock, reports, observations, sourceId, status, send,
        at: (ms: number) => { time = ms; },
        frame: () => { const position = controller.getPosition(); observations.push(position); return position; } };
};
afterEach(async () => {
    await Promise.all(controllers.splice(0).map(controller => controller.setBackend(null)));
    vi.restoreAllMocks();
});

describe('HQPlayer mod-only display clock compatibility', () => {
    it('reproduces the original half-second reversal without the mod filter', async () => {
        const s = await setup(false);
        s.send(10);
        s.at(500);
        expect(s.frame()).toBe(10.5);
        s.send(10);
        expect(s.observations.at(-1)).toBe(10);
        expect(s.frame()).toBe(10);
    });

    it('removes repeated integer-second anchors without adding timers, reports or a new host clock', async () => {
        const s = await setup();
        s.send(10);
        for (let ms = 10; ms <= 10000; ms += 10) {
            s.at(ms);
            if (ms % 500 === 0) s.send(10 + Math.floor(ms / 1000));
            expect(s.frame()).toBeCloseTo(10 + ms / 1000, 9);
        }
        expect(s.reports).toHaveLength(11);
        expect(s.observations.every((value, i, values) => i === 0 || value >= values[i - 1] - 1e-9)).toBe(true);
    });

    it('does not reverse either clock writer under fractional reports and jittered poll timing', async () => {
        const s = await setup();
        s.send(10.1);
        let previous = s.frame();
        for (let i = 1; i <= 100; i++) {
            const ms = i * 500 + (i % 3) * 7;
            s.at(ms);
            const before = s.controller.getPosition();
            s.send(10.1 + ms / 1000 + (i % 2 ? -0.045 : 0.035));
            const after = s.frame();
            expect(after).toBeGreaterThanOrEqual(before - 1e-9);
            expect(after - before).toBeLessThanOrEqual(0.02 + 1e-9);
            expect(after).toBeGreaterThanOrEqual(previous);
            previous = after;
        }
        expect(s.observations.every((value, i, values) => i === 0 || value >= values[i - 1] - 1e-9)).toBe(true);
    });

    it('freezes stale data even while repeated playing statuses continue arriving', async () => {
        const s = await setup();
        s.send(10);
        for (let ms = 500; ms <= 60000; ms += 500) { s.at(ms); s.send(10); }
        expect(s.frame()).toBe(11);
        expect(s.reports).toHaveLength(1);
        s.at(61000);
        s.send(11);
        s.at(61500);
        expect(s.frame()).toBe(11.5);
    });

    it('bounds long-term drift instead of refreshing an increasingly wrong synthetic anchor', async () => {
        const s = await setup();
        s.send(10.1);
        let maxLead = 0;
        let previous = 10.1;
        for (let ms = 500; ms <= 3600000; ms += 500) {
            s.at(ms);
            const actual = 10.1 + ms / 1000 * 0.999;
            s.send(actual);
            const shown = s.controller.getPosition();
            maxLead = Math.max(maxLead, shown - actual);
            if (shown < previous - 1e-9) throw new Error('Clock reversed while correcting drift');
            previous = shown;
        }
        expect(maxLead).toBeLessThanOrEqual(1.25 + 1e-9);
        expect(s.reports.length).toBeLessThan(7201);
    });

    it('keeps explicit seeks immediate and suppresses queued pre-seek samples until acknowledgement', async () => {
        const s = await setup();
        s.send(30);
        s.at(500);
        s.clock.beginSeek(5.9);
        expect(s.frame()).toBe(5);
        s.send(30.5);
        expect(s.frame()).toBe(5);
        s.send(5);
        expect(s.controller.getStatus().state).toBe('loading');
        s.clock.finishSeek();
        expect(s.frame()).toBe(5);
        expect(s.controller.getStatus().state).toBe('playing');
        s.at(1000);
        expect(s.frame()).toBe(5.5);
        s.clock.beginSeek(5.1);
        s.clock.finishSeek();
        s.send(5);
        expect(s.frame()).toBe(5);
        s.at(1100);
        expect(s.frame()).toBe(5.1);
    });

    it('does not freeze indefinitely if a successful seek never reaches its requested target', async () => {
        const s = await setup();
        s.send(30);
        s.clock.beginSeek(5);
        s.clock.finishSeek();
        s.at(500);
        s.send(30.5);
        expect(s.frame()).toBe(5);
        s.at(3500);
        s.send(33.5);
        expect(s.frame()).toBe(33.5);
    });

    it('handles pause, stopped, EOF repeat and external seeks without reusing an old running anchor', async () => {
        const s = await setup();
        s.send(30);
        s.at(500);
        s.send(5);
        expect(s.frame()).toBe(5);
        s.send(50);
        expect(s.frame()).toBe(50);
        s.send(50, 'paused');
        s.at(5000);
        expect(s.frame()).toBe(50);
        s.send(50);
        s.at(5500);
        expect(s.frame()).toBe(50.5);
        s.send(0, 'stopped');
        s.clock.receive({ type: 'ended', sourceId: s.sourceId });
        s.send(90);
        expect(s.frame()).toBe(0);
        s.clock.beginSeek(0);
        s.send(0, 'paused');
        s.clock.finishSeek();
        s.send(0);
        s.at(6000);
        expect(s.frame()).toBe(0.5);
    });

    it('ignores retired sources, invalid clocks and late playing reports after an error', async () => {
        const s = await setup();
        s.send(10);
        s.clock.receive({ type: 'status', status: { ...s.status(90), sourceId: 'old' } });
        s.send(NaN);
        s.send(-1);
        expect(s.reports).toHaveLength(1);
        s.clock.receive({ type: 'error', sourceId: s.sourceId, message: 'disconnected' });
        s.clock.beginSeek(0);
        s.send(20);
        expect(s.controller.getStatus().state).toBe('paused');
        expect(s.reports).toHaveLength(2);
        await s.controller.open('https://test/two');
        const sourceId = s.controller.getStatus().sourceId;
        s.clock.setSource(sourceId);
        s.clock.receive({ type: 'status', status: { ...s.status(0), sourceId } });
        expect(s.frame()).toBe(0);
    });

    it('clamps unknown and known durations and restores the last confirmed clock on a failed seek', async () => {
        const s = await setup();
        s.send(0, 'playing', 0);
        s.at(500);
        expect(s.frame()).toBe(0.5);
        s.send(1, 'playing', 1.2);
        s.at(1500);
        expect(s.frame()).toBe(1.2);
        s.send(1, 'paused', 1.2);
        s.clock.beginSeek(0);
        s.clock.cancelSeek();
        expect(s.frame()).toBe(1);
    });
});
