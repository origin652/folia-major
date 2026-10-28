import type { WindowPlaybackHandoff } from '../../types/appPlayback';
import { PlayerState } from '../../types';
import { currentTime } from '../../stores/motionSignals';
import { setPlayerState, usePlaybackStore } from '../../stores/usePlaybackStore';
import { useHifiSettingsStore } from '../../stores/useHifiSettingsStore';
import { backendPlayback } from './controller';
import { restorePlaybackBackendSelection, selectedPlaybackBackend } from './registry';

// Window rebuilds transfer the user's explicit choice only after the old mod output has closed.

export const readBackendHandoffPosition = () => selectedPlaybackBackend() && usePlaybackStore.getState().activePlaybackContext !== 'stage'
    ? backendPlayback.getStatus().sourceId ? backendPlayback.getPosition() : currentTime.get()
    : null;

export const releaseBackendForWindowHandoff = async (handoff: WindowPlaybackHandoff) => {
    if (!handoff.playbackBackendId) return handoff;
    const pause = (snapshot: WindowPlaybackHandoff['mainPlayback']) => snapshot
        ? { ...snapshot, playerState: PlayerState.PAUSED } : null;
    const prepared = {
        ...handoff,
        mainPlayback: pause(handoff.mainPlayback),
        activePlayback: handoff.activePlaybackContext === 'main' ? pause(handoff.activePlayback) : handoff.activePlayback,
    };
    if (handoff.activePlaybackContext === 'main') setPlayerState(PlayerState.PAUSED);
    await backendPlayback.setBackend(null);
    if (handoff.activePlaybackContext === 'main') {
        currentTime.set(handoff.activePlayback?.currentTime ?? 0);
        usePlaybackStore.getState().setDuration(handoff.activePlayback?.duration ?? 0);
    }
    return prepared;
};

export const restoreBackendFromWindowHandoff = (handoff: WindowPlaybackHandoff) => {
    if (!handoff.playbackBackendId) return;
    useHifiSettingsStore.getState().setEnabled(false);
    // Reserve the choice even for a missing/late mod: never sound Web Audio as a fallback.
    restorePlaybackBackendSelection(handoff.playbackBackendId);
};
