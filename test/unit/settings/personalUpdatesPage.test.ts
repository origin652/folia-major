// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SettingsPageContextValue } from '../../../src/components/modal/settings/pages/settingsPageContext';
import GeneralPage from '../../../src/components/modal/settings/pages/GeneralPage';

// Checks update actions in the existing settings UI, without a real Electron bridge or network.
const fixture = vi.hoisted(() => ({ value: null as unknown as SettingsPageContextValue }));
vi.mock('../../../src/components/modal/settings/pages/settingsPageContext', () => ({
    useSettingsPage: () => fixture.value,
}));
vi.mock('react-i18next', async importOriginal => ({
    ...await importOriginal<typeof import('react-i18next')>(),
    useTranslation: () => ({ t: (key: string) => key, i18n: { resolvedLanguage: 'en' } }),
}));

let root: Root | null = null;
let host: HTMLDivElement;

beforeAll(() => { (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true; });
afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    vi.unstubAllGlobals();
});

async function render(status = 'available', { auto = false, enabled = false } = {}) {
    vi.stubGlobal('__APP_VERSION__', '0.7.22-personal.0');
    const check = vi.fn();
    const download = vi.fn();
    const install = vi.fn();
    const model = {
        electronSettings: { UPDATE_CHANNEL: 'personal', ENABLE_UPDATE_CHECK: enabled, ENABLE_AUTO_UPDATE: auto },
        updateStatus: {
            status, updateCheckSupported: true, autoUpdateSupported: true, platform: 'win32',
            currentVersion: '0.7.22-personal.0', availableVersion: '0.7.22-personal.2.1',
        },
        updateBadgeLabel: status,
        canEnableAutoUpdate: enabled,
        canDownloadUpdate: status === 'available',
        onCheckForUpdates: check, onDownloadUpdate: download, onInstallUpdate: install,
    };
    fixture.value = {
        isElectron: true,
        viewProps: { desktop: { model, preferences: { openPlayerOnLaunch: false, onToggleOpenPlayerOnLaunch: vi.fn() } } },
    } as unknown as SettingsPageContextValue;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(React.createElement(GeneralPage)));
    return { check, download, install };
}

function button(key: string) {
    return [...host.querySelectorAll('button')].find(node => node.textContent === key)!;
}

describe('personal update controls', () => {
    it('keeps manual check and update actionable with startup checks disabled', async () => {
        const { check, download, install } = await render();
        expect(button('options.checkForUpdates').disabled).toBe(false);
        expect(button('options.updateNow').disabled).toBe(false);
        await act(async () => button('options.checkForUpdates').click());
        await act(async () => button('options.updateNow').click());
        expect(check).toHaveBeenCalledOnce();
        expect(download).toHaveBeenCalledOnce();
        expect(install).not.toHaveBeenCalled();
        expect(host.textContent).toContain('options.personalUpdateSource');
        expect(host.textContent).not.toContain('options.updateChannelRealeco');
    });

    it('offers manual download even when automatic downloading is enabled', async () => {
        await render('available', { auto: true, enabled: true });
        expect(button('options.updateNow').disabled).toBe(false);
    });

    it('requires the explicit restart action after download', async () => {
        const { install } = await render('downloaded');
        expect(button('options.updateNow')).toBeUndefined();
        expect(install).not.toHaveBeenCalled();
        await act(async () => button('options.restartToInstallUpdate').click());
        expect(install).toHaveBeenCalledOnce();
    });

    it('prevents another check while downloading', async () => {
        await render('downloading');
        expect(button('options.checkForUpdates').disabled).toBe(true);
        expect(button('options.updateNow')).toBeUndefined();
    });
});
