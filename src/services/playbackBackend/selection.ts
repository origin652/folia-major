import type { SongResult } from '../../types';
import { PlayerState } from '../../types';
import { currentTime } from '../../stores/motionSignals';
import { setPlayerState, usePlaybackStore } from '../../stores/usePlaybackStore';
import { useHifiSettingsStore } from '../../stores/useHifiSettingsStore';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { getHifiPosition, isHifiRoute, leaveHifiRoute } from '../hifi/hifiPlayback';
import { whenHifiOutputReleased } from '../hifi/hifiRouteGuard';
import { backendPlayback } from './controller';
import { getPlaybackBackend, isPlaybackEngineSwitching, listPlaybackBackends, selectPlaybackBackend,
    selectedPlaybackBackend, setPlaybackEngineSwitching } from './registry';

// Explicit engine handoff: release the old output before selecting and preparing the new one.

type Reload = (song: SongResult | null, position: number) => Promise<void>;
const listeners = new Set<() => void>();
let reload: Reload | null = null;
let releaseWeb: (() => Promise<void>) | null = null;

export const subscribePlaybackEngineSwitch = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
};

export const bindPlaybackEngineReload = (handler: Reload, release: () => Promise<void>) => {
    reload = handler;
    releaseWeb = release;
    return () => { if (reload === handler) { reload = null; releaseWeb = null; } };
};

export const selectedPlaybackEngine = () => {
    const mod = selectedPlaybackBackend();
    return mod ? `mod:${mod}` : useHifiSettingsStore.getState().enabled ? 'mpv' : 'web';
};

export const selectPlaybackEngine = async (value: string) => {
    const modId = value.startsWith('mod:') ? value.slice(4) : null;
    if (modId ? !listPlaybackBackends().some(entry => entry.id === modId) : !['web', 'mpv'].includes(value)) {
        throw new Error('playback-backend-not-found');
    }
    if (isPlaybackEngineSwitching()) throw new Error('playback-engine-switch-in-progress');
    if (value === selectedPlaybackEngine() && (!modId || (getPlaybackBackend() && backendPlayback.getStatus().sourceId))) return;
    const before = usePlaybackStore.getState();
    if (before.activePlaybackContext === 'stage') throw new Error('playback-engine-switch-unavailable-in-stage');
    const songKey = before.currentSong ? getPlaybackSongKey(before.currentSong) : null;
    const position = selectedPlaybackBackend() ? backendPlayback.getPosition()
        : isHifiRoute() ? getHifiPosition() : currentTime.get();
    setPlaybackEngineSwitching(true);
    listeners.forEach(listener => listener());
    setPlayerState(PlayerState.PAUSED);
    try {
        // Keep the old selection until dispose succeeds: failure must not silently enable Web Audio.
        await backendPlayback.setBackend(null);
        leaveHifiRoute('playback engine selection');
        useHifiSettingsStore.getState().setEnabled(false);
        await whenHifiOutputReleased();
        await releaseWeb?.();
        selectPlaybackBackend(modId);
        if (modId) await backendPlayback.setBackend(getPlaybackBackend()!.definition);
        if (!modId) useHifiSettingsStore.getState().setEnabled(value === 'mpv');
        const current = usePlaybackStore.getState().currentSong;
        if ((current ? getPlaybackSongKey(current) : null) === songKey) await reload?.(current, position);
    } finally {
        setPlaybackEngineSwitching(false);
        listeners.forEach(listener => listener());
    }
};
