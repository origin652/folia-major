'use strict';

const path = require('node:path');
const { createHqpEngine } = require('./engine.cjs');
const { inspectHqplayer } = require('./diagnostics.cjs');
const { ensureHqplayer } = require('./launcher.cjs');
const { createRendererLease } = require('./rendererLease.cjs');

// Uses public Folium RPC/storage only; enabling the mod does not start or take over HQPlayer.

module.exports = function activate(api) {
    let lease;
    const engine = createHqpEngine(event => {
        lease?.observe(event);
        api.rpc.send('hqplayer.event', event);
    }, path.join(api.storage.paths.cache, 'sources'));
    api.rpc.handle('hqplayer.inspect', inspectHqplayer);
    api.rpc.handle('hqplayer.ensureRunning', ensureHqplayer);
    lease = createRendererLease(api, engine);
    api.onDispose(() => lease.dispose());
};
