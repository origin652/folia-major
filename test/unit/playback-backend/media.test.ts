// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendPlayback } from '../../../src/services/playbackBackend/controller';
import { registerPlaybackBackend, selectPlaybackBackend } from '../../../src/services/playbackBackend/registry';
import { backendMediaShim, getObservedMedia, hifiMediaShim } from '../../../src/services/hifi/hifiMediaShim';
import { hifiRouteFor } from '../../../src/services/hifi/hifiPlayback';
import { usePlaybackStore } from '../../../src/stores/usePlaybackStore';
import type { PlaybackBackendEvent, PlaybackBackendSource } from '../../../src/services/playbackBackend/types';

// Exercise the real host observer wiring with an in-memory backend; no fetch or audio device is used.
let off = () => {};
afterEach(async () => {
    await backendPlayback.setBackend(null);
    selectPlaybackBackend(null);
    off();
    hifiMediaShim.reset();
    vi.useRealTimers();
});

describe('mod media observations', () => {
    it('keeps mpv and mod clocks separate, ignores stale sources and does not repeat playing events on every tick', async () => {
        vi.useFakeTimers();
        usePlaybackStore.setState({ activePlaybackContext: 'main', playbackRoute: 'web' });
        let report!: (event: PlaybackBackendEvent) => void;
        let source!: PlaybackBackendSource;
        off = registerPlaybackBackend('test:media', {
            name: 'In-memory output', capabilities: { http: true, seek: true, volume: true },
            create: callback => {
                report = callback;
                return { open: async value => { source = value; }, play: async () => {}, pause: async () => {},
                    seek: async () => {}, setVolume: async () => {}, dispose: async () => {} };
            },
        });
        selectPlaybackBackend('test:media');
        expect(hifiRouteFor('local', 'local:one')).toBe('web');
        await backendPlayback.open('https://test.invalid/one');
        const playing = vi.fn();
        backendMediaShim.addEventListener('playing', playing);
        const first = source.sourceId;
        for (const position of [5, 6]) report({ type: 'status', status: { sourceId: first,
            state: 'playing', position, duration: 100 } });
        expect(playing).toHaveBeenCalledOnce();
        expect(getObservedMedia(null)).toBe(backendMediaShim);
        expect(backendMediaShim.currentSrc).toBe(`backend:${first}`);
        expect(backendMediaShim.currentTime).toBe(6);
        hifiMediaShim.reset();
        expect(backendMediaShim.currentTime).toBe(6);
        report({ type: 'status', status: { sourceId: first, state: 'paused', position: 8, duration: 100 } });
        expect(backendMediaShim.paused).toBe(true);
        expect(backendMediaShim.currentTime).toBe(8);
        await backendPlayback.open('https://test.invalid/two');
        report({ type: 'ended', sourceId: first });
        expect(backendMediaShim.ended).toBe(false);
        expect(backendMediaShim.currentSrc).toBe(`backend:${source.sourceId}`);
        backendMediaShim.removeEventListener('playing', playing);
    });
});
