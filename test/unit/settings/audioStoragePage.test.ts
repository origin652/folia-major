// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import StoragePage, { OPTIONS } from '../../../src/components/modal/settings/pages/StoragePage';
import { useAudioArchiveStore } from '../../../src/services/audioArchive/useAudioArchiveStore';
import { useAudioSettingsStore } from '../../../src/stores/useAudioSettingsStore';
import { audioArchiveCommands } from '../../../src/components/command-palette/commands/audioArchiveCommands';
import { isDrawnHere } from '../../../src/components/modal/settings/kit/options';

// One settings card, two independent storage policies; merging headings must not change either switch.
const page = vi.hoisted(() => ({
    isElectron: true,
    viewProps: { storage: { cacheDirectory: 'C:\\cache', cacheDirectoryIsDefault: false, cacheDirectoryStatus: 'idle',
        cacheSizes: { media: '1 MB' }, mediaCount: 1, isCleaning: null, onChooseCacheDirectory() {}, onClear() {} } },
}));
vi.mock('react-i18next', async importOriginal => ({
    ...await importOriginal<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../src/components/modal/settings/pages/settingsPageContext', () => ({ useSettingsPage: () => page }));
vi.mock('../../../src/components/modal/settings/pages/storage/ConfigTransferRows', () => ({ default: () => null }));
vi.mock('../../../src/components/modal/settings/pages/storage/FolderWatchGroup', () => ({ default: () => null }));
vi.mock('../../../src/components/shared/ConfirmDialog', () => ({ default: () => null }));
vi.mock('../../../src/services/db', () => ({ clearAllData: vi.fn() }));
let root: Root;
let host: HTMLDivElement;
const archive = { enabled: true, preferLocal: true, directory: 'C:\\music', savedCount: 2, lastSaved: null };
beforeAll(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); delete (window as any).electron; });
const render = async (desktop = true) => {
    page.isElectron = desktop;
    const api = {
        settings: vi.fn(async () => ({ ...archive })),
        configure: vi.fn(async patch => ({ ...archive, ...patch })), choose: vi.fn(async () => ({ ...archive })),
    };
    (window as any).electron = desktop ? { audioArchive: api } : undefined;
    useAudioArchiveStore.setState({ settings: { ...archive }, busy: false, error: null });
    useAudioSettingsStore.setState({ enableMediaCache: true });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    await act(async () => root.render(React.createElement(StoragePage)));
    return api;
};
const row = (id: string) => host.querySelector(`[data-settings-row="${id}"]`);
const click = async (element: Element) => { await act(async () => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))); };

describe('audio cache and archive settings', () => {
    it('draws cache and archive controls under one heading, with no independent archive tab', async () => {
        await render();
        const card = host.querySelector('[data-settings-anchor="mediaCache"]')!;
        expect(host.querySelector('[data-settings-anchor="audioArchive"]')).toBeNull();
        expect(card.querySelector('h3')?.textContent).toBe('options.audioStorage');
        for (const id of ['enableMediaCache', 'cacheDirectory', 'mediaCacheLimit', 'audioArchiveEnabled', 'audioArchiveDirectory', 'audioArchivePreferLocal']) {
            expect(card.contains(row(id)), id).toBe(true);
        }
        expect(card.textContent).toContain('options.audioStorageHint');
    });
    it('keeps the two switches independent without migrating or deleting saved files/settings', async () => {
        const api = await render();
        await click(row('enableMediaCache')!.querySelector('[role="switch"]')!);
        expect(useAudioSettingsStore.getState().enableMediaCache).toBe(false);
        expect(useAudioArchiveStore.getState().settings.enabled).toBe(true);
        expect(api.configure).not.toHaveBeenCalled();
        await click(row('audioArchiveEnabled')!.querySelector('[role="switch"]')!);
        expect(api.configure).toHaveBeenCalledExactlyOnceWith({ enabled: false });
        expect(useAudioArchiveStore.getState().settings.directory).toBe(archive.directory);
        expect(useAudioSettingsStore.getState().enableMediaCache).toBe(false);
    });
    it('keeps archive rows out of the web UI and search while retaining the ordinary cache', async () => {
        await render(false);
        expect(row('enableMediaCache')).not.toBeNull();
        for (const def of OPTIONS.filter(option => option.id.startsWith('audioArchive'))) {
            expect(row(def.id)).toBeNull();
            expect(isDrawnHere(def, { isElectron: false })).toBe(false);
            expect(def.group.id).toBe('mediaCache');
        }
    });
    it('routes the existing archive command to the merged card', async () => {
        await render();
        const openSettings = vi.fn();
        const command = audioArchiveCommands.find(command => command.id === 'settings-audio-archive')!;
        await command.execute('', { settings: { openSettings } } as any);
        expect(openSettings).toHaveBeenCalledExactlyOnceWith('options', 'storage', null, 'mediaCache');
    });
});
