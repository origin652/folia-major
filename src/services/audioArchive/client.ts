import type { SongResult } from '../../types';
import type { AudioQualityPreference } from '../../types/onlineMusic';
import { getPlaybackSongKey, getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { omni } from '../onlineMusic/omni';
import { getProviderSongMetadata } from '../onlineMusic/songMetadata';
import type { ArchiveContext } from './types';

// Archive lookups precede provider URL requests; identity and actual quality remain attached to local sources.
const localQualities = new Map<string, string>();
export const archiveSourceContext = (song: SongResult | null, url: string, collection: { id: string; name: string } | null): ArchiveContext | undefined => {
    if (!song || getPlaybackSourceRef(song).kind !== 'online' || omni.isPreviewAudioSource(url)) return;
    const quality = localQualities.get(url) ?? omni.levelOfAudioSource(url);
    if (!quality) return;
    const metadata = getProviderSongMetadata(song);
    return { songKey: getPlaybackSongKey(song), quality, title: song.name,
        artist: metadata.artists.map(artist => artist.name).join(', '), durationMs: metadata.durationMs,
        preview: false, collection };
};

export const findArchivedSong = async (song: SongResult, quality: AudioQualityPreference): Promise<string | null> => {
    const source = getPlaybackSourceRef(song), bridge = typeof window !== 'undefined' ? window.electron?.audioArchive : undefined;
    if (source.kind !== 'online' || !bridge) return null;
    try {
        const found = await bridge.find({ songKey: getPlaybackSongKey(song), quality: omni.resolveAudioQuality(source.providerId, quality) });
        if (!found || !/^folia-archive:\/\/audio\/[a-f0-9]{32}\/audio\.(flac|wav|aif|mp3|m4a|mp4|ogg|opus|wv|dsf|dff|ape|caf)$/.test(found.url)) return null;
        if (localQualities.size >= 256) localQualities.delete(localQualities.keys().next().value!);
        localQualities.set(found.url, found.quality);
        console.info('[AudioArchive] Playing verified local audio', { songKey: getPlaybackSongKey(song), quality: found.quality });
        return found.url;
    } catch (error) {
        console.warn('[AudioArchive] Local lookup failed; using normal source resolution', error);
        return null;
    }
};
