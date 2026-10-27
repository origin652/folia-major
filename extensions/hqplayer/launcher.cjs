'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { HqConnection } = require('./connection.cjs');
const { normalizeConfig } = require('./protocol.cjs');

// Starts a locally installed Desktop only on backend selection/open, never on mod activation.

const inspectWindows = async () => {
    if (process.platform !== 'win32') throw new Error('Automatic HQPlayer launch currently supports Windows; start HQPlayer manually or disable automatic launch');
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$running = @(Get-Process -Name HQPlayer6Desktop,HQPlayer5Desktop -ErrorAction SilentlyContinue).Count -gt 0",
        "$keys = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
        "$apps = @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^HQPlayer [56] Desktop' } | Sort-Object DisplayVersion -Descending)",
        "$candidates = @($apps | ForEach-Object { if ($_.DisplayIcon -match '^\"([^\"]+\\.exe)\"') { $Matches[1] } elseif ($_.InstallLocation) { Join-Path $_.InstallLocation ('HQPlayer' + ([regex]::Match($_.DisplayName, '[56]').Value) + 'Desktop.exe') } })",
        '[pscustomobject]@{ running = $running; candidates = $candidates } | ConvertTo-Json -Compress',
    ].join('; ');
    const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024,
    });
    return JSON.parse(stdout.trim());
};

const probeControl = async config => {
    // Desktop may wait about two seconds before answering the first command on a new socket.
    const connection = new HqConnection(config, { timeoutMs: 5000 });
    try {
        const info = await connection.request('GetInfo');
        if (!/HQPlayer/.test(info.getAttribute('product') || '')) throw new Error('The selected service is not HQPlayer');
        return true;
    } catch (error) {
        if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(error.cause?.code)
            || /timed out|^HQPlayer connection closed/.test(error.message)) return false;
        throw error;
    } finally { connection.close(); }
};

const launchDesktop = (executable, spawnProcess = spawn) => new Promise((resolve, reject) => {
    // Hide discovery helpers, not the Desktop window users need to configure playback.
    const child = spawnProcess(executable, [], {
        shell: false, detached: true, windowsHide: false, stdio: 'ignore', cwd: path.dirname(executable),
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
});

const createHqpLauncher = ({ probe = probeControl, inspect = inspectWindows, launch = launchDesktop,
    exists = async file => { try { return (await fs.stat(file)).isFile(); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } },
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, timeoutMs = 30000,
} = {}) => {
    let work = Promise.resolve();
    const ensure = async config => {
        if (!config.autoStart || await probe(config)) return;
        const installed = await inspect();
        if (!installed.running) {
            const defaults = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
                .flatMap(directory => [6, 5].map(version => path.join(directory, `HQPlayer${version}`, `HQPlayer${version}Desktop.exe`)));
            const candidates = config.executable ? [config.executable] : [...installed.candidates, ...defaults];
            let executable;
            for (const candidate of candidates) {
                if (path.isAbsolute(candidate) && /^HQPlayer[56]Desktop\.exe$/i.test(path.basename(candidate)) && await exists(candidate)) {
                    executable = candidate;
                    break;
                }
            }
            if (!executable) throw new Error('HQPlayer Desktop installation not found; set its executable path in the mod settings or start it manually');
            // A user may have started Desktop while installation discovery was in progress.
            if (!(await inspect()).running) await launch(executable);
        }
        const deadline = now() + timeoutMs;
        while (now() < deadline) {
            if (await probe(config)) return;
            await delay(500);
        }
        throw new Error('HQPlayer is running or was started, but network control is not ready; enable network control, check the port and close its Settings dialog. No second instance was started.');
    };
    return values => {
        const config = normalizeConfig(values);
        const result = work.then(() => ensure(config));
        work = result.catch(() => {});
        return result;
    };
};

const ensureHqplayer = createHqpLauncher();
module.exports = { createHqpLauncher, ensureHqplayer, inspectWindows, launchDesktop };
