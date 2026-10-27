'use strict';

const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { connectMpv } = require('./mpvIpc.cjs');
const { resolveExecutable } = require('./devices.cjs');
const { normalizeConfig, buildMpvArgs, validateOutput } = require('./dsp.cjs');

// Native output is owned by this mod. The host receives only tagged transport/output telemetry.

const createNativeEngine = (report) => {
    let config = normalizeConfig();
    let child = null;
    let ipc = null;
    let sourceId = '';
    let generation = 0;
    let state = {};
    let exclusive = null;
    let outputReady = false;
    let lastReport = 0;
    let volume = 0;
    let rejectOpen = null;
    let finished = false;

    const status = (force = false) => {
        if (!sourceId || (!force && Date.now() - lastReport < 250)) return;
        lastReport = Date.now();
        report({ type: 'status', status: {
            sourceId, state: outputReady ? (state.pause ? 'paused' : 'playing') : 'loading',
            position: Number.isFinite(state['time-pos']) ? Math.max(0, state['time-pos']) : 0,
            duration: Number.isFinite(state.duration) ? Math.max(0, state.duration) : 0,
            output: {
                exclusiveRequested: config.exclusive, exclusiveActive: exclusive,
                sampleRate: state['audio-out-params']?.samplerate,
                format: state['audio-out-params']?.format,
                dspActive: config.dspEnabled,
            },
        } });
    };
    const dispose = async () => {
        generation++;
        outputReady = false;
        rejectOpen?.(new Error('Native source retired'));
        rejectOpen = null;
        const previous = child;
        const previousIpc = ipc;
        child = null;
        ipc = null;
        sourceId = '';
        if (previous && previous.exitCode === null) {
            await new Promise(resolve => {
                const timeout = setTimeout(() => { previous.kill(); resolve(); }, 1500);
                previous.once('close', () => { clearTimeout(timeout); resolve(); });
                if (previousIpc) void previousIpc.command(['quit']).catch(() => previous.kill());
                else previous.kill();
            });
        }
        previousIpc?.close();
    };

    const open = async (source) => {
        if (process.platform !== 'win32') throw new Error('This native-audio release supports Windows WASAPI only');
        if (!source || typeof source.sourceId !== 'string' || (!source.filePath && !/^https?:\/\//i.test(source.url ?? ''))) {
            throw new TypeError('Invalid backend source');
        }
        const executable = resolveExecutable(config.executable);
        await dispose();
        const token = generation;
        sourceId = source.sourceId;
        state = { pause: true };
        exclusive = config.exclusive ? null : false;
        let loaded = false;
        finished = false;
        let failed = false;
        let acceptedExclusive = false;
        let resolveOpen;
        const ready = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
        // Observe rejection immediately, including failures before the IPC connection exists.
        ready.catch(() => {});
        const timeout = setTimeout(() => rejectOpen?.(new Error('Native output initialization timed out')), 20000);
        const fail = (error) => {
            if (token !== generation || failed) return;
            failed = true;
            const id = sourceId;
            rejectOpen?.(error);
            if (outputReady) report({ type: 'error', sourceId: id, message: error.message });
            outputReady = false;
            child?.kill();
        };
        const pipe = `\\\\.\\pipe\\folia-native-${process.pid}-${randomUUID()}`;
        child = spawn(executable, buildMpvArgs(config, pipe), {
            shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.on('error', fail);
        child.stderr.resume();
        child.on('close', code => {
            if (token === generation && child) fail(new Error(`Native player exited (${code}); check device, format and mpv build`));
        });
        const maybeReady = () => {
            if (failed || !loaded || !state['audio-out-params'] || !state['audio-params'] || !state['current-ao'] || token !== generation) return;
            try {
                validateOutput(config, state['audio-out-params'], acceptedExclusive, state['audio-params']?.samplerate);
                if (state['current-ao'] !== 'wasapi') throw new Error('WASAPI output was not confirmed');
                exclusive = config.exclusive ? true : false;
                if (outputReady) return;
                outputReady = true;
                rejectOpen = null;
                resolveOpen();
                status(true);
            } catch (error) { fail(error); }
        };
        try {
            ipc = await connectMpv(pipe, () => token === generation && child !== null && child.exitCode === null);
            ipc.on('failure', fail);
            ipc.on('closed', () => fail(new Error('Native player IPC disconnected')));
            ipc.on('message', message => {
                if (token !== generation || failed) return;
                if (message.event === 'log-message' && message.prefix === 'ao/wasapi') {
                    if (/Accepted as .*\(exclusive\)/.test(message.text)) acceptedExclusive = true;
                    if (/Accepted as .*\(shared\)/.test(message.text) && config.exclusive) fail(new Error('Shared output refused: exclusive was requested'));
                }
                if (message.event === 'log-message' && /Requested resampling engine is unavailable|Disabling filter .*failed|failed to configure the filter graph/i.test(message.text)) {
                    fail(new Error('Native DSP initialization failed; install an mpv build with libsoxr. DSP bypass is forbidden'));
                }
                if (message.event === 'property-change') {
                    if (outputReady && ((message.name === 'current-ao' && message.data !== 'wasapi')
                        || (message.name === 'audio-out-params' && !message.data))) {
                        fail(new Error('Native output device was lost; playback stopped without fallback'));
                        return;
                    }
                    state[message.name] = message.data;
                    if (message.name === 'eof-reached' && message.data && !finished) {
                        finished = true;
                        report({ type: 'ended', sourceId });
                        return;
                    }
                    if (finished) return;
                    maybeReady();
                    status(message.name === 'pause');
                }
                if (message.event === 'file-loaded') {
                    loaded = true;
                    maybeReady();
                }
                if (message.event === 'end-file') {
                    if (message.reason === 'eof' && !finished) { finished = true; report({ type: 'ended', sourceId }); }
                    else if (message.reason === 'error') fail(new Error('Native decoding/output failed; no shared fallback was started'));
                }
            });
            await ipc.command(['request_log_messages', 'v']);
            const properties = ['time-pos', 'duration', 'pause', 'audio-params', 'audio-out-params', 'current-ao', 'eof-reached'];
            for (let index = 0; index < properties.length; index++) {
                await ipc.command(['observe_property', index + 1, properties[index]]);
            }
            await ipc.command(['loadfile', source.filePath || source.url, 'replace']);
            await ready;
            await ipc.command(['set_property', 'volume', volume * 100]);
        } catch (error) {
            await dispose();
            throw error;
        } finally { clearTimeout(timeout); }
    };

    return {
        configure: async (input) => { const next = normalizeConfig(input); await dispose(); config = next; return config; },
        open,
        play: async () => {
            if (!outputReady || !ipc) throw new Error('Native output is not ready');
            await ipc.command(['set_property', 'pause', false]);
        },
        pause: async () => { if (ipc) await ipc.command(['set_property', 'pause', true]); },
        seek: async (seconds) => {
            if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('Invalid seek');
            if (ipc) { finished = false; await ipc.command(['seek', seconds, 'absolute+exact']); }
        },
        setVolume: async (value) => {
            if (!Number.isFinite(value) || value < 0 || value > 1) throw new TypeError('Invalid volume');
            volume = value;
            if (ipc) await ipc.command(['set_property', 'volume', value * 100]);
        },
        dispose,
        // Node's exit event cannot await a graceful quit. The directly spawned .exe can be killed synchronously.
        disposeSync: () => {
            generation++;
            rejectOpen?.(new Error('Native host exited'));
            rejectOpen = null;
            child?.kill();
            child = null;
            ipc?.close();
            ipc = null;
            sourceId = '';
            outputReady = false;
        },
    };
};

module.exports = { createNativeEngine };
