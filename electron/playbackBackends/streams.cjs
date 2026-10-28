'use strict';

const { createSourceBridge } = require('../hifi/sourceBridge.cjs');

// Reuses the HiFi byte transport; provider authentication stays in Omni and Electron's media protocols.

const createPlaybackStreams = ({ fetchFn, protocol, protocols = [], logInfo, logWarn, archive } = {}) => {
    const captures = new Map();
    const allowed = new Set(['http:', 'https:', ...protocols]);
    const allowedProtocols = [...allowed];
    const bridge = createSourceBridge({ fetchFn, allowedRemoteProtocols: allowedProtocols,
        logPrefix: '[PlaybackBackend]', logInfo, logWarn,
        observeRemoteResponse: (token, response) => captures.get(token)?.response(response) });
    const tickets = new Map();
    const generations = new Map();
    let disposed = false;
    const registerProtocol = (scheme, handler) => {
        if (typeof scheme !== 'string' || !/^folia-[a-z][a-z0-9-]*$/.test(scheme)) throw new Error('invalid-media-protocol');
        protocol.handle(scheme, handler);
        const name = `${scheme}:`;
        if (!allowed.has(name)) { allowed.add(name); allowedProtocols.push(name); }
    };
    const create = async (url, ownerId, context) => {
        if (disposed) throw new Error('playback-stream-retired');
        let parsed;
        try { parsed = typeof url === 'string' && url.length <= 16384 ? new URL(url) : null; }
        catch { parsed = null; }
        if (!parsed || !allowed.has(parsed.protocol) || parsed.username || parsed.password) {
            throw new Error('unsupported-playback-stream');
        }
        if (!Number.isInteger(ownerId)) throw new Error('invalid-playback-stream-owner');
        const generation = generations.get(ownerId) ?? 0;
        await bridge.start();
        if (disposed || generation !== (generations.get(ownerId) ?? 0)) throw new Error('playback-stream-retired');
        if (tickets.size >= 32 || [...tickets.values()].filter(owner => owner === ownerId).length >= 8) {
            throw new Error('too-many-playback-streams');
        }
        const extension = /\.(flac|wav|aiff?|mp3|m4a|mp4|ogg|opus|wv|dsf|dff|ape|caf)$/i.exec(parsed.pathname)?.[0]?.toLowerCase() ?? '';
        const { token, url: playbackUrl } = bridge.registerRemote({ url, fileName: `audio${extension}` });
        tickets.set(token, ownerId);
        if (!parsed.protocol.startsWith('folia-')) {
            const capture = archive?.capture(context);
            if (capture) captures.set(token, capture);
        }
        return { id: token, url: playbackUrl };
    };
    const release = (id, ownerId) => {
        if (tickets.get(id) !== ownerId) return;
        tickets.delete(id);
        captures.get(id)?.retire();
        captures.delete(id);
        bridge.revoke(id);
    };
    const releaseOwner = ownerId => {
        generations.set(ownerId, (generations.get(ownerId) ?? 0) + 1);
        for (const [id, owner] of tickets) if (owner === ownerId) release(id, ownerId);
    };
    const getError = (id, ownerId) => tickets.get(id) === ownerId
        ? bridge.getSourceError(id)
        : 'SOURCE_UNREACHABLE';
    const dispose = async () => {
        disposed = true;
        for (const capture of captures.values()) capture.retire();
        captures.clear();
        tickets.clear();
        await bridge.stop();
    };
    const markPlayed = (id, ownerId) => { if (tickets.get(id) === ownerId) captures.get(id)?.played(); };
    return { create, release, releaseOwner, getError, registerProtocol, dispose, markPlayed };
};

module.exports = { createPlaybackStreams };
