import { create } from 'zustand';
import type { AudioArchiveSettings } from './types';

// Native storage is the single source of truth for this device's chosen directory and archive switches.
interface ArchiveState {
    settings: AudioArchiveSettings;
    busy: boolean;
    error: string | null;
    refresh(): Promise<void>;
    choose(): Promise<void>;
    configure(patch: { enabled?: boolean; preferLocal?: boolean }): Promise<void>;
}
const defaults: AudioArchiveSettings = { enabled: false, preferLocal: true, directory: '', savedCount: 0, lastSaved: null };
export const isAudioArchiveSupported = () => typeof window !== 'undefined' && Boolean(window.electron?.audioArchive);
export const useAudioArchiveStore = create<ArchiveState>((set) => {
    const run = async (action: () => Promise<AudioArchiveSettings>) => {
        set({ busy: true, error: null });
        try { set({ settings: await action() }); }
        catch (error) {
            console.error('[AudioArchive] Settings action failed', error);
            set({ error: error instanceof Error ? error.message : String(error) });
        } finally { set({ busy: false }); }
    };
    return { settings: defaults, busy: false, error: null,
        refresh: () => isAudioArchiveSupported() ? run(() => window.electron!.audioArchive!.settings()) : Promise.resolve(),
        choose: () => run(() => window.electron!.audioArchive!.choose()),
        configure: patch => run(() => window.electron!.audioArchive!.configure(patch)),
    };
});
