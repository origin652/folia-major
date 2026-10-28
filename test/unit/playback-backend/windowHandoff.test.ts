import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowPlaybackHandoff } from '../../../src/types/appPlayback';
import { PlayerState } from '../../../src/types';
import { readBackendHandoffPosition, releaseBackendForWindowHandoff, restoreBackendFromWindowHandoff } from '../../../src/services/playbackBackend/windowHandoff';
import { getPlaybackBackend, registerPlaybackBackend, selectPlaybackBackend, selectedPlaybackBackend } from '../../../src/services/playbackBackend/registry';

// Memory-only output ports verify that window modes retain a choice, never choose an enabled mod.
const ports = vi.hoisted(() => ({
    dispose: vi.fn(async () => {}), player: vi.fn(), duration: vi.fn(), mpv: vi.fn(),
    position: 83.5, signal: 81, sourceId: 'one', context: 'main',
}));
vi.mock('../../../src/services/playbackBackend/controller', () => ({ backendPlayback: {
    setBackend: (definition: unknown) => { expect(definition).toBeNull(); return ports.dispose(); },
    getStatus: () => ({ sourceId: ports.sourceId }), getPosition: () => ports.position,
} }));
vi.mock('../../../src/stores/usePlaybackStore', () => ({
    setPlayerState: (state: unknown) => ports.player(state),
    usePlaybackStore: { getState: () => ({ setDuration: ports.duration, activePlaybackContext: ports.context }) },
}));
vi.mock('../../../src/stores/motionSignals', () => ({ currentTime: {
    get: () => ports.signal, set: (value: number) => { ports.signal = value; },
} }));
vi.mock('../../../src/stores/useHifiSettingsStore', () => ({
    useHifiSettingsStore: { getState: () => ({ setEnabled: ports.mpv }) },
}));
const handoff = (backendId: string | null = 'another-mod:output'): WindowPlaybackHandoff => ({
    version: 1, playbackBackendId: backendId, activePlaybackContext: 'main',
    mainPlayback: { playerState: PlayerState.PLAYING, currentTime: 83.5, duration: 180 },
    activePlayback: { playerState: PlayerState.PLAYING, currentTime: 83.5, duration: 180 },
} as WindowPlaybackHandoff);

beforeEach(() => {
    vi.clearAllMocks();
    ports.dispose.mockResolvedValue(undefined);
    ports.position = 83.5;
    ports.signal = 81;
    ports.sourceId = 'one';
    ports.context = 'main';
    selectPlaybackBackend(null);
});
afterEach(() => selectPlaybackBackend(null));

describe('mod backend window handoff', () => {
    it('does not choose or release any mod for a legacy/Web handoff', async () => {
        await releaseBackendForWindowHandoff(handoff(null));
        restoreBackendFromWindowHandoff(handoff(null));
        expect(selectedPlaybackBackend()).toBeNull();
        expect(readBackendHandoffPosition()).toBeNull();
        expect(ports.dispose).not.toHaveBeenCalled();
        expect(ports.mpv).not.toHaveBeenCalled();
    });
    it('reads the selected backend clock, then retains the held clock after release', () => {
        restoreBackendFromWindowHandoff(handoff());
        expect(readBackendHandoffPosition()).toBe(83.5);
        ports.sourceId = '';
        expect(readBackendHandoffPosition()).toBe(81);
    });
    it('waits for old output cleanup and hands off the song paused at the original position', async () => {
        let release!: () => void;
        ports.dispose.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
        const original = handoff();
        let done = false;
        const pending = releaseBackendForWindowHandoff(original).then(value => { done = true; return value; });
        await Promise.resolve();
        expect(done).toBe(false);
        expect(ports.player).toHaveBeenCalledWith(PlayerState.PAUSED);
        release();
        const next = await pending;
        expect(next.playbackBackendId).toBe('another-mod:output');
        expect(next.activePlayback).toMatchObject({ playerState: PlayerState.PAUSED, currentTime: 83.5 });
        expect(original.activePlayback?.playerState).toBe(PlayerState.PLAYING);
        expect(ports.signal).toBe(83.5);
    });
    it('rejects the handoff on cleanup failure, retaining the selected unavailable output', async () => {
        restoreBackendFromWindowHandoff(handoff());
        ports.dispose.mockRejectedValueOnce(new Error('output still active'));
        await expect(releaseBackendForWindowHandoff(handoff())).rejects.toThrow('output still active');
        expect(selectedPlaybackBackend()).toBe('another-mod:output');
        expect(getPlaybackBackend()).toBeNull();
    });
    it('reserves a late mod and does not replace it when another mod registers', () => {
        restoreBackendFromWindowHandoff(handoff());
        const definition = { name: 'Fake', capabilities: { seek: true, volume: true, http: true }, create: vi.fn() };
        const offOther = registerPlaybackBackend('other:output', definition);
        expect(selectedPlaybackBackend()).toBe('another-mod:output');
        const offSelected = registerPlaybackBackend('another-mod:output', definition);
        expect(getPlaybackBackend()?.definition).toBe(definition);
        expect(ports.mpv).toHaveBeenCalledWith(false);
        offSelected();
        offOther();
        expect(selectedPlaybackBackend()).toBe('another-mod:output');
    });
    it('does not pause Stage transport when releasing an inactive mod selection', async () => {
        const value = handoff();
        value.activePlaybackContext = 'stage';
        const next = await releaseBackendForWindowHandoff(value);
        expect(ports.player).not.toHaveBeenCalled();
        expect(next.activePlayback?.playerState).toBe(PlayerState.PLAYING);
        expect(next.mainPlayback?.playerState).toBe(PlayerState.PAUSED);
    });
    it('does not substitute an inactive backend clock for the Stage clock', () => {
        restoreBackendFromWindowHandoff(handoff());
        ports.context = 'stage';
        expect(readBackendHandoffPosition()).toBeNull();
    });
});
