import { backendPlayback, usesPlaybackBackend } from './controller';
import { getHifiPosition, hifiTransport, isHifiRoute } from '../hifi/hifiPlayback';

// Small transport seams keep existing HTML media behavior intact when no backend is selected.

export const playbackPosition = (element: Pick<HTMLMediaElement, 'currentTime'> | null) => usesPlaybackBackend()
    ? backendPlayback.getPosition() : isHifiRoute() ? getHifiPosition() : element?.currentTime ?? 0;

export const seekPlayback = (element: HTMLMediaElement | null, seconds: number) => {
    if (usesPlaybackBackend()) return backendPlayback.seek(seconds);
    if (isHifiRoute()) return hifiTransport.seek(seconds);
    if (element) element.currentTime = seconds;
    return Promise.resolve();
};

export const pausePlaybackOutput = (element: HTMLMediaElement | null) => {
    element?.pause();
    if (usesPlaybackBackend()) return backendPlayback.pause();
    if (isHifiRoute()) return hifiTransport.pause();
    return Promise.resolve();
};
