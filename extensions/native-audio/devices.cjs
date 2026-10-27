'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { connectMpv } = require('./mpvIpc.cjs');
const { normalizeConfig } = require('./dsp.cjs');

// Enumerates the engine's WASAPI endpoints without loading media or opening an audio stream.
const resolveExecutable = (value) => {
    const { executable } = normalizeConfig({ executable: value });
    const file = executable === 'bundled' ? path.join(__dirname, 'runtime', 'win32-x64', 'mpv.exe') : executable;
    if (executable === 'bundled' && !fs.existsSync(file)) {
        throw new Error('Bundled engine is missing; install the complete native-audio zip, not the source folder');
    }
    return file;
};

const parseDevices = (input) => {
    if (!Array.isArray(input)) throw new Error('Engine returned an invalid audio device list');
    const devices = new Map();
    for (const item of input) {
        if (typeof item?.name !== 'string' || !item.name.startsWith('wasapi/')) continue;
        if (/[\r\n\0]/.test(item.name)) continue;
        devices.set(item.name, { id: item.name, name: typeof item.description === 'string' ? item.description : item.name });
        if (devices.size > 256) throw new Error('Engine returned too many audio devices');
    }
    return [...devices.values()];
};

const createDeviceDiscovery = () => {
    const children = new Set();
    let disposed = false;
    return {
        async list(executable = 'bundled') {
            if (disposed) throw new Error('Native device discovery has stopped');
            if (process.platform !== 'win32') throw new Error('This native-audio release supports Windows WASAPI only');
            if (children.size >= 2) throw new Error('Device discovery is already busy; try again shortly');
            const pipe = `\\\\.\\pipe\\folia-devices-${process.pid}-${randomUUID()}`;
            const child = spawn(resolveExecutable(executable), [
                '--no-config', '--no-video', '--no-terminal', '--load-scripts=no', '--idle=yes',
                '--pause=yes', '--volume=0', '--ao=wasapi', '--audio-fallback-to-null=no', `--input-ipc-server=${pipe}`,
            ], { shell: false, windowsHide: true, stdio: 'ignore' });
            children.add(child);
            let failure;
            let closed = false;
            let ipc;
            child.on('error', error => { failure = error; });
            child.once('close', () => { closed = true; children.delete(child); });
            try {
                ipc = await connectMpv(pipe, () => !disposed && !failure && !closed && child.exitCode === null);
                ipc.on('failure', error => { failure = error; });
                return parseDevices(await ipc.command(['get_property', 'audio-device-list']));
            } catch (error) {
                throw failure || error;
            } finally {
                if (!closed) {
                    await new Promise(resolve => {
                        const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
                        child.once('close', () => { clearTimeout(timer); resolve(); });
                        if (ipc) void ipc.command(['quit']).catch(() => child.kill());
                        else child.kill();
                    });
                }
                ipc?.close();
            }
        },
        disposeSync() {
            disposed = true;
            for (const child of children) child.kill();
        },
    };
};

module.exports = { resolveExecutable, parseDevices, createDeviceDiscovery };
