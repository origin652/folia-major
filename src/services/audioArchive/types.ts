// Shared archive DTOs: native code owns paths and bytes; renderers only send bounded song metadata.
export interface ArchiveContext {
    songKey: string;
    quality: string;
    title: string;
    artist: string;
    durationMs: number;
    preview: false;
    collection: { id: string; name: string } | null;
}

export interface AudioArchiveSettings {
    enabled: boolean;
    preferLocal: boolean;
    directory: string;
    savedCount: number;
    lastSaved: string | null;
}

export interface AudioArchiveBridge {
    settings(): Promise<AudioArchiveSettings>;
    configure(patch: { enabled?: boolean; preferLocal?: boolean }): Promise<AudioArchiveSettings>;
    choose(): Promise<AudioArchiveSettings>;
    find(query: { songKey: string; quality: string }): Promise<{ url: string; quality: string } | null>;
}
