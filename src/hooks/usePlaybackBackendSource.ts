import { useSyncExternalStore } from 'react';
import { backendPlayback } from '../services/playbackBackend/controller';
import { selectedPlaybackBackend, subscribePlaybackBackends } from '../services/playbackBackend/registry';

// Rebind media observers only when the selected mod or its source changes, not on every clock tick.

const subscribe = (listener: () => void) => {
    const offBackend = subscribePlaybackBackends(listener);
    const offSource = backendPlayback.subscribe(listener);
    return () => { offBackend(); offSource(); };
};
const snapshot = () => selectedPlaybackBackend() === null ? ''
    : `${selectedPlaybackBackend()}:${backendPlayback.getStatus().sourceId}`;

export const usePlaybackBackendSource = () => useSyncExternalStore(subscribe, snapshot);
