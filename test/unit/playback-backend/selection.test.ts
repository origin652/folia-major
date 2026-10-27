// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerState, type SongResult } from '../../../src/types';
import { currentTime } from '../../../src/stores/motionSignals';
import { useHifiSettingsStore } from '../../../src/stores/useHifiSettingsStore';
import { bindPlaybackEngineReload, selectPlaybackEngine } from '../../../src/services/playbackBackend/selection';
import { isPlaybackEngineSwitching, registerPlaybackBackend, selectPlaybackBackend,
    selectedPlaybackBackend } from '../../../src/services/playbackBackend/registry';

// Real selection registry with fake output ports: no device, network or player process is touched.
const ports = vi.hoisted(() => ({
    dispose: vi.fn(async () => {}), release: vi.fn(async () => {}), connect: vi.fn(async () => {}),
    leave: vi.fn(), native: false,
    playback: { currentSong: null as SongResult | null, activePlaybackContext: 'main', playerState: 'PAUSED' },
}));
vi.mock('../../../src/services/playbackBackend/controller', () => ({
    backendPlayback: { setBackend: (next: unknown) => next ? ports.connect() : ports.dispose(), getPosition: () => 17,
        getStatus: () => ({ sourceId: 'test-source' }) },
}));
vi.mock('../../../src/services/hifi/hifiPlayback', () => ({
    getHifiPosition: () => 42, isHifiRoute: () => ports.native, leaveHifiRoute: () => ports.leave(),
}));
vi.mock('../../../src/services/hifi/hifiRouteGuard', () => ({ whenHifiOutputReleased: () => ports.release() }));
vi.mock('../../../src/stores/usePlaybackStore', () => ({
    usePlaybackStore: { getState: () => ports.playback },
    setPlayerState: (state: string) => { ports.playback.playerState = state; },
}));

const song = (id: number) => ({ id, name: `song ${id}`, sourceRef: { kind: 'online', providerId: 'netease', mediaId: String(id) } } as SongResult);
const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
};
let off: () => void;
let unbind: () => void;
let reload: ReturnType<typeof vi.fn<(song: SongResult | null, position: number) => Promise<void>>>;
let releaseWeb: ReturnType<typeof vi.fn<() => Promise<void>>>;

beforeEach(() => {
    vi.clearAllMocks();
    ports.dispose.mockImplementation(async () => {});
    ports.release.mockImplementation(async () => {});
    ports.connect.mockImplementation(async () => {});
    ports.native = false;
    ports.playback.currentSong = song(1);
    ports.playback.activePlaybackContext = 'main';
    ports.playback.playerState = PlayerState.PLAYING;
    useHifiSettingsStore.getState().setEnabled(false);
    selectPlaybackBackend(null);
    off = registerPlaybackBackend('test:output', {
        name: 'Test output', capabilities: { seek: true, volume: true, http: true }, create: vi.fn(),
    });
    reload = vi.fn(async () => {});
    releaseWeb = vi.fn(async () => {});
    unbind = bindPlaybackEngineReload(reload, releaseWeb);
    currentTime.set(9);
});
afterEach(() => { unbind(); selectPlaybackBackend(null); off(); });

describe('explicit engine selection', () => {
    it('releases Web Audio and mpv before selecting a mod, preserving the native position without playing', async () => {
        ports.native = true;
        useHifiSettingsStore.getState().setEnabled(true);
        const pending = gate();
        ports.release.mockReturnValue(pending.promise);
        const changing = selectPlaybackEngine('mod:test:output');
        await vi.waitFor(() => expect(ports.release).toHaveBeenCalledOnce());
        expect(releaseWeb).not.toHaveBeenCalled();
        expect(ports.dispose).toHaveBeenCalledOnce();
        expect(ports.leave).toHaveBeenCalledOnce();
        expect(selectedPlaybackBackend()).toBeNull();
        expect(isPlaybackEngineSwitching()).toBe(true);
        expect(reload).not.toHaveBeenCalled();
        pending.resolve();
        await changing;
        expect(releaseWeb).toHaveBeenCalledOnce();
        expect(ports.connect).toHaveBeenCalledOnce();
        expect(selectedPlaybackBackend()).toBe('test:output');
        expect(useHifiSettingsStore.getState().enabled).toBe(false);
        expect(reload).toHaveBeenCalledWith(ports.playback.currentSong, 42);
        expect(ports.playback.playerState).toBe(PlayerState.PAUSED);
        expect(isPlaybackEngineSwitching()).toBe(false);
    });

    it.each(['web', 'mpv'])('disposes a mod before choosing %s and retains its position', async value => {
        selectPlaybackBackend('test:output');
        await selectPlaybackEngine(value);
        expect(ports.dispose).toHaveBeenCalledOnce();
        expect(selectedPlaybackBackend()).toBeNull();
        expect(useHifiSettingsStore.getState().enabled).toBe(value === 'mpv');
        expect(reload).toHaveBeenCalledWith(ports.playback.currentSong, 17);
    });

    it('keeps a failed mod selection instead of falling back when its output cannot be released', async () => {
        selectPlaybackBackend('test:output');
        ports.dispose.mockRejectedValueOnce(new Error('device still active'));
        await expect(selectPlaybackEngine('web')).rejects.toThrow('device still active');
        expect(selectedPlaybackBackend()).toBe('test:output');
        expect(reload).not.toHaveBeenCalled();
        expect(isPlaybackEngineSwitching()).toBe(false);
    });

    it('does not select or initialize a mod when suspending Web Audio fails', async () => {
        releaseWeb.mockRejectedValueOnce(new Error('cannot release browser output'));
        await expect(selectPlaybackEngine('mod:test:output')).rejects.toThrow('cannot release browser output');
        expect(selectedPlaybackBackend()).toBeNull();
        expect(ports.connect).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        expect(ports.playback.playerState).toBe(PlayerState.PAUSED);
    });

    it('does not reload an old song after a newer selection during release', async () => {
        const pending = gate();
        ports.release.mockReturnValue(pending.promise);
        const changing = selectPlaybackEngine('mod:test:output');
        await vi.waitFor(() => expect(ports.release).toHaveBeenCalledOnce());
        ports.playback.currentSong = song(2);
        pending.resolve();
        await changing;
        expect(reload).not.toHaveBeenCalled();
    });

    it('rejects concurrent handoffs and Stage changes without starting another output', async () => {
        const pending = gate();
        ports.release.mockReturnValue(pending.promise);
        const changing = selectPlaybackEngine('mod:test:output');
        await vi.waitFor(() => expect(ports.release).toHaveBeenCalledOnce());
        await expect(selectPlaybackEngine('mpv')).rejects.toThrow('in-progress');
        pending.resolve();
        await changing;
        ports.playback.activePlaybackContext = 'stage';
        await expect(selectPlaybackEngine('web')).rejects.toThrow('unavailable-in-stage');
    });
});
