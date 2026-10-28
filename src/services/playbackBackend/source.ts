import type { PlaybackBackendSource } from './types';
import type { ArchiveContext } from '../audioArchive/types';

// Prepare revocable host streams or opaque staged files without decoding in the browser.

export interface PlaybackSourceBridge {
    stage(data: ArrayBuffer): Promise<{ id: string; filePath: string }>;
    stream?(url: string, context?: ArchiveContext): Promise<{ id: string; url: string }>;
    markPlayed?(id: string): Promise<void>;
    progress?(id: string, seconds: number): Promise<void>;
    streamError?(id: string): Promise<string | null>;
    release(id: string): Promise<void>;
}

export interface PreparedBackendSource {
    source: PlaybackBackendSource;
    release(): Promise<void>;
    getError?(): Promise<string | null>;
    markPlayed?(): void;
    progress?(seconds: number): void;
}

export const prepareBackendSource = async (url: string, sourceId: string, allowHttp: boolean, context?: ArchiveContext): Promise<PreparedBackendSource> => {
    if (!/^(blob:|https?:|folia-)/i.test(url)) throw new Error('unsupported-playback-source');
    const bridge = window.electron?.playbackSources;
    if (!bridge) throw new Error('playback-source-bridge-unavailable');
    if (allowHttp && !/^blob:/i.test(url)) {
        if (!bridge.stream) throw new Error('playback-stream-bridge-unavailable');
        const leased = context ? await bridge.stream(url, context) : await bridge.stream(url);
        let played = false, retained = false;
        return {
            source: { sourceId, url: leased.url },
            release: () => bridge.release(leased.id),
            getError: () => bridge.streamError?.(leased.id) ?? Promise.resolve(null),
            markPlayed: () => {
                if (played) return;
                played = true;
                void bridge.markPlayed?.(leased.id).catch(error => console.warn('[AudioArchive] Could not mark playing source', error));
            },
            progress: seconds => {
                if (!played || retained || !context || !Number.isFinite(seconds) || seconds * 1000 < context.durationMs * 0.8) return;
                retained = true;
                void bridge.progress?.(leased.id, seconds).catch(error => console.warn('[AudioArchive] Could not retain playing source', error));
            },
        };
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error(`playback-source-http:${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (length > 512 * 1024 * 1024) throw new Error('playback-source-too-large');
    if (!response.body) throw new Error('playback-source-empty');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 512 * 1024 * 1024) {
                await reader.cancel();
                throw new Error('playback-source-too-large');
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const data = new ArrayBuffer(size);
    const bytes = new Uint8Array(data);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const staged = await bridge.stage(data);
    return {
        source: { sourceId, filePath: staged.filePath },
        release: () => bridge.release(staged.id),
    };
};
