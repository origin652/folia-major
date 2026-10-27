import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Exercises the production updater wiring with an in-memory updater; never starts Electron or a real download.
const channels = require('../../../electron/updateChannels.cjs');
const personal = require('../../../shared/personalUpdates.cjs');
const { createUpdateActions } = require('../../../electron/updateActions.cjs');
const { stampPersonalPackage } = require('../../../packaging/personal/stamp.cjs');
const { planPersonalRelease } = require('../../../packaging/personal/publish.cjs');
const currentVersion = '0.7.22-personal.1.1';
const nextVersion = '0.7.22-personal.2.1';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

function updaterHarness({ platform = 'win32', auto = false, enabled = true, version = nextVersion } = {}) {
    const updater = Object.assign(new EventEmitter(), {
        autoDownload: false,
        allowDowngrade: true,
        autoInstallOnAppQuit: true,
        setFeedURL: vi.fn(),
        downloadUpdate: vi.fn(async () => {
            updater.emit('download-progress', { percent: 50 });
            updater.emit('update-downloaded', { version });
        }),
        checkForUpdates: vi.fn(async () => {
            updater.emit('checking-for-update');
            updater.emit(channels.compareVersions(version, currentVersion) > 0 ? 'update-available' : 'update-not-available', { version });
            return { updateInfo: { version } };
        }),
    });
    const values = new Map<string, unknown>([
        ['ENABLE_UPDATE_CHECK', enabled], ['ENABLE_AUTO_UPDATE', auto], ['UPDATE_CHANNEL', 'realeco'],
    ]);
    const fetch = vi.fn(async (_url: string, _options: unknown) => ({ ok: true, text: async () => `version: ${version}\n` }));
    const source = readFileSync(new URL('../../../electron/main.cjs', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('function getUpdateCheckEnabled()'), source.indexOf('// External links are restricted'));
    const preferenceStart = source.indexOf('  if (key === ENABLE_UPDATE_CHECK_SETTING_KEY)');
    const preferenceHandler = source.slice(preferenceStart, source.indexOf('  if (key === ENABLE_AUTO_UPDATE_SETTING_KEY)', preferenceStart));
    const context = vm.createContext({
        ...channels, ...personal, createUpdateActions,
        app: { getVersion: () => currentVersion, isPackaged: true },
        process: { platform, env: {} },
        store: { get: (key: string) => values.get(key), set: (key: string, value: unknown) => values.set(key, value) },
        autoUpdater: null, mainWindow: null,
        require: () => ({ autoUpdater: updater }),
        ENABLE_UPDATE_CHECK_SETTING_KEY: 'ENABLE_UPDATE_CHECK',
        ENABLE_AUTO_UPDATE_SETTING_KEY: 'ENABLE_AUTO_UPDATE',
        LAST_SEEN_UPDATE_VERSION_SETTING_KEY: 'LAST_SEEN_UPDATE_VERSION',
        FOLIA_RELEASES_URL: 'https://github.com/origin652/folia-major/releases',
        FOLIA_GITHUB_REPOSITORY: personal.PERSONAL_UPDATES,
        console: { warn: vi.fn(), error: vi.fn() },
        AbortController, setTimeout, clearTimeout,
        session: { fromPartition: () => ({ setProxy: vi.fn(), forceReloadProxyConfig: vi.fn(), fetch }) },
    });
    const actions = vm.runInContext(`${block}\nsetupAutoUpdater();
        function applyCheckPreference(nextValue) {
            store.set(ENABLE_UPDATE_CHECK_SETTING_KEY, nextValue);
            const key = ENABLE_UPDATE_CHECK_SETTING_KEY;
            ${preferenceHandler}
        }
        ({checkForUpdates, downloadAvailableUpdate, getUpdateStatus, getCurrentReleaseChannel, applyCheckPreference});`, context);
    return { actions, updater, values, fetch };
}

describe('personal updater production wiring', () => {
    it('pins the fork feed despite an old official-channel preference and forbids downgrades', async () => {
        const { actions, updater } = updaterHarness();
        expect(actions.getCurrentReleaseChannel().id).toBe('personal');
        expect(updater.setFeedURL).toHaveBeenCalledWith({
            provider: 'generic',
            url: 'https://github.com/origin652/folia-major/releases/download/personal-playback-backends/',
            channel: 'personal', useMultipleRangeRequest: false,
        });
        expect(updater.allowDowngrade).toBe(false);
        expect(updater.autoInstallOnAppQuit).toBe(false);
        const status = await actions.checkForUpdates({ manual: true });
        expect(status.status).toBe('available');
        expect(status.updateUrl).toBe('https://github.com/origin652/folia-major/releases/tag/personal-playback-backends');
        expect(updater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('checks and downloads manually even with startup checks disabled, without installing', async () => {
        const { actions, updater } = updaterHarness({ enabled: false });
        expect((await actions.checkForUpdates()).status).toBe('disabled');
        expect((await actions.downloadAvailableUpdate()).status).toBe('downloaded');
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
        expect((await actions.checkForUpdates({ manual: true })).status).toBe('downloaded');
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    });

    it('only auto-downloads after a validated personal version', async () => {
        const { actions, updater } = updaterHarness({ auto: true });
        expect((await actions.checkForUpdates()).status).toBe('downloaded');
        expect(updater.autoDownload).toBe(false);
        expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it('keeps an installer ready when startup checking is switched off', async () => {
        const { actions } = updaterHarness();
        await actions.downloadAvailableUpdate();
        actions.applyCheckPreference(false);
        expect(actions.getUpdateStatus()).toMatchObject({ status: 'downloaded', updateCheckEnabled: false });
    });

    it('honors a manual download that overlaps a disabled startup check', async () => {
        const { actions, updater } = updaterHarness({ enabled: false });
        const checking = actions.checkForUpdates();
        const downloading = actions.downloadAvailableUpdate();
        await checking;
        expect((await downloading).status).toBe('downloaded');
        expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    });

    it.each(['0.7.23', '0.7.23-beta.1', 'garbage'])('rejects foreign metadata %s without downloading', async version => {
        const { actions, updater } = updaterHarness({ auto: true, version });
        expect((await actions.checkForUpdates({ manual: true })).status).toBe('error');
        expect(updater.downloadUpdate).not.toHaveBeenCalled();
        expect(actions.getUpdateStatus().availableVersion).toBeNull();
    });

    it('does not offer equal or older personal builds', async () => {
        for (const version of [currentVersion, '0.7.22-personal.0']) {
            const { actions, updater } = updaterHarness({ auto: true, version });
            expect((await actions.checkForUpdates({ manual: true })).status).toBe('latest');
            expect(updater.downloadUpdate).not.toHaveBeenCalled();
        }
    });

    it('reports a missing branch release without trying an official feed', async () => {
        const { actions, updater } = updaterHarness();
        updater.checkForUpdates.mockRejectedValueOnce(Object.assign(new Error('404'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }));
        expect((await actions.checkForUpdates({ manual: true })).status).toBe('unpublished');
        expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
        expect(updater.downloadUpdate).not.toHaveBeenCalled();
    });

    it('allows a clean retry after a download error', async () => {
        const { actions, updater } = updaterHarness();
        updater.downloadUpdate.mockRejectedValueOnce(new Error('network disconnected'));
        expect((await actions.downloadAvailableUpdate()).status).toBe('error');
        expect((await actions.downloadAvailableUpdate()).status).toBe('downloaded');
        expect(updater.downloadUpdate).toHaveBeenCalledTimes(2);
    });

    it('joins concurrent requests and keeps the downloaded state across checks', async () => {
        const { actions, updater } = updaterHarness();
        const pending = deferred();
        const check = updater.checkForUpdates.getMockImplementation()!;
        updater.checkForUpdates.mockImplementationOnce(async () => { await pending.promise; return check(); });
        const checking = actions.checkForUpdates({ manual: true });
        const downloads = [actions.downloadAvailableUpdate(), actions.downloadAvailableUpdate()];
        pending.resolve();
        await Promise.all([checking, ...downloads]);
        expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
        expect((await actions.checkForUpdates({ manual: true })).status).toBe('downloaded');
    });

    it('supports manual discovery on non-Windows and clearly reports missing metadata', async () => {
        const { actions, fetch, updater } = updaterHarness({ platform: 'linux' });
        expect((await actions.checkForUpdates({ manual: true })).status).toBe('available');
        expect(fetch.mock.calls[0]?.[0]).toBe('https://github.com/origin652/folia-major/releases/download/personal-playback-backends/personal.yml');
        expect(updater.checkForUpdates).not.toHaveBeenCalled();
        fetch.mockResolvedValueOnce({ ok: false, status: 404 } as never);
        expect((await actions.checkForUpdates({ manual: true })).status).toBe('unpublished');
    });
});

describe('personal release packaging', () => {
    const env = {
        GITHUB_REPOSITORY: 'origin652/folia-major', GITHUB_REF: 'refs/heads/personal/playback-backends',
        GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_NUMBER: '42', GITHUB_RUN_ATTEMPT: '1',
    };

    it('stamps a higher version on a rerun of the same upstream version', () => {
        const first = stampPersonalPackage({ version: '0.7.22', build: {} }, env);
        const next = stampPersonalPackage(first, { ...env, GITHUB_RUN_ATTEMPT: '2' });
        expect(first.version).toBe('0.7.22-personal.42.1');
        expect(channels.compareVersions(next.version, first.version)).toBe(1);
        expect(first.foliaUpdateSource.commit).toBe(env.GITHUB_SHA);
    });

    it.each([
        { GITHUB_REPOSITORY: 'chthollyphile/folia-major' },
        { GITHUB_REF: 'refs/heads/main' }, { GITHUB_SHA: '' }, { GITHUB_RUN_NUMBER: '0' },
    ])('refuses a build with incorrect source identity %o', override => {
        expect(() => stampPersonalPackage({ version: '0.7.22' }, { ...env, ...override })).toThrow();
    });

    it('never uses the supplied official repo for a personal channel feed or release link', () => {
        const channel = channels.resolveReleaseChannel(currentVersion, 'personal');
        const official = { owner: 'chthollyphile', repo: 'folia-major' };
        expect(channels.getUpdateDiscoveryConfig(channel, official).url).toContain('/origin652/');
        expect(channels.getUpdateProviderConfig(channel, official).url).toContain('/origin652/');
        expect(channels.getReleaseUrl('personal', nextVersion, 'https://example.invalid')).toContain('/origin652/');
    });

    it('validates metadata versions and versioned payloads before publication', () => {
        const files = ['personal.yml', 'personal-mac.yml', `Folia-Setup-${nextVersion}.exe`, `Folia-${nextVersion}-arm64.zip`];
        const read = () => `version: ${nextVersion}\n`;
        const plan = planPersonalRelease(files, read);
        expect(plan.payloads).toHaveLength(2);
        expect(plan.metadata).toHaveLength(2);
        expect(() => planPersonalRelease(files, () => 'version: 0.7.23\n')).toThrow();
        expect(() => planPersonalRelease(['personal.yml', 'Folia.exe'], read)).toThrow();
        expect(() => planPersonalRelease(['personal.yml'], read)).toThrow();
    });
});
