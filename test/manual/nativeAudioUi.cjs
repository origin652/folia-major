const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron } = require('playwright-core');

// Tests the new mod ZIP against the previously shipped host, never against a real user profile.
const root = path.resolve(__dirname, '../..');
const run = async () => {
    const profile = fs.mkdtempSync(path.join(root, 'test-results/native-ui-userdata-'));
    const zip = path.resolve(process.argv[2] || 'test-results/native-audio-package/native-audio-0.1.1-win32-x64.zip');
    const app = await _electron.launch({ executablePath: path.join(root, 'release/win-unpacked/Folia.exe'),
        args: [`--user-data-dir=${profile}`], cwd: root, env: { ...process.env, ELECTRON_DEV: 'false' } });
    let page;
    try {
        assert.equal((await app.evaluate(({ app }) => app.getPath('userData'))).toLowerCase(), profile.toLowerCase());
        page = await app.firstWindow();
        await page.waitForSelector('#root > *');
        await page.evaluate(async () => {
            localStorage.setItem('folia_last_seen_ponder_onboarding_version', '0.7.21');
            localStorage.setItem('library_suite_prompt_seen', 'true');
            localStorage.setItem('folia_app_language', 'en');
            localStorage.setItem('mod_system_enabled', 'true');
            await window.electron.saveSettings('MOD_SYSTEM_ENABLED', true);
        });
        const installed = await page.evaluate(zip => window.electron.mods.installModFromZip(zip), zip);
        assert.equal(installed.ok, true, JSON.stringify(installed));
        // Only the isolated profile's own native-audio consent is simulated; restore the real dialog immediately.
        await app.evaluate(({ app, dialog }, expectedProfile) => {
            if (app.getPath('userData') !== expectedProfile) throw new Error('Unsafe profile');
            const original = dialog.showMessageBox;
            globalThis.__nativeUiRestoreDialog = () => { dialog.showMessageBox = original; delete globalThis.__nativeUiRestoreDialog; };
            dialog.showMessageBox = (...args) => {
                const options = args[args.length - 1];
                if (options.message?.includes('native-audio') && options.detail?.includes(expectedProfile)) {
                    return Promise.resolve({ response: 1, checkboxChecked: false });
                }
                return original.apply(dialog, args);
            };
        }, profile);
        try {
            const enabled = await page.evaluate(() => window.electron.mods.setModEnabled('native-audio', true));
            assert.equal(enabled.ok, true, JSON.stringify(enabled));
        } finally { await app.evaluate(() => globalThis.__nativeUiRestoreDialog?.()); }
        await page.reload();
        await page.waitForSelector('#root > *');
        await page.keyboard.press('Control+k');
        await page.getByRole('combobox').fill('Mod settings');
        await page.getByText('Mod settings', { exact: true }).click();
        const modRow = page.getByRole('button', { name: /Native Audio \/ 原生音频/ }).first();
        await modRow.waitFor();
        if (await modRow.getAttribute('aria-expanded') !== 'true') await modRow.click();
        const device = page.getByRole('combobox', { name: /^Audio output device/ });
        await device.waitFor();
        await device.click();
        const dac = page.getByRole('option').filter({ hasText: 'YULONG' });
        await dac.waitFor();
        await page.screenshot({ path: path.join(root, 'test-results/native-device-picker.png') });
        await dac.click();
        const values = () => page.evaluate(() => JSON.parse(localStorage.getItem('folia_folium_params_v1') || '{}')['settings:native-audio:output']);
        await page.waitForFunction(() => JSON.parse(localStorage.getItem('folia_folium_params_v1') || '{}')['settings:native-audio:output']?.device?.startsWith('wasapi/'), null, { polling: 100 });
        const selected = (await values()).device;
        for (const [title, key] of [['Toggle strict exclusive output', 'exclusive'], ['Toggle native DSP chain', 'dspEnabled'], ['Toggle SoXR upsampling', 'resampleEnabled']]) {
            const row = page.getByText(title, { exact: true }).locator('..').locator('..');
            await row.getByRole('button', { name: 'Run', exact: true }).click();
            await page.getByText(/Saved; select Native Audio in Playback settings/).first().waitFor();
            await page.waitForFunction(key => JSON.parse(localStorage.getItem('folia_folium_params_v1') || '{}')['settings:native-audio:output']?.[key] === true, key);
        }
        await page.getByText('Toggle native DSP chain', { exact: true }).locator('..').locator('..').getByRole('button', { name: 'Run', exact: true }).click();
        await page.getByText(/DSP is off; SoXR is bypassed/).first().waitFor();
        await page.getByText('Refresh audio devices', { exact: true }).locator('..').locator('..').getByRole('button', { name: 'Run', exact: true }).click();
        await page.getByText(/WASAPI devices found/).waitFor();
        assert.equal((await values()).device, selected);
        await page.screenshot({ path: path.join(root, 'test-results/native-command-feedback.png') });
        console.log(JSON.stringify({ profile, installed, devices: 'actual WASAPI selector including YULONG DAC', selected,
            commands: 'three toggles, DSP bypass warning, device refresh and selection persistence passed', values: await values() }, null, 2));
    } catch (error) {
        if (page && !page.isClosed()) {
            console.error((await page.locator('body').innerText()).slice(-14000));
            console.error(await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(key => key.includes('folium_params')).map(key => [key, localStorage.getItem(key)]))));
            await page.screenshot({ path: path.join(root, 'test-results/native-ui-failure.png') });
        }
        throw error;
    } finally { await app.close(); }
};
run().catch(error => { console.error(error); process.exitCode = 1; });
