'use strict';

const path = require('node:path');
const { createHqpEngine } = require('./engine.cjs');
const { inspectHqplayer } = require('./diagnostics.cjs');
const { ensureHqplayer } = require('./launcher.cjs');

// Uses public Folium RPC/storage only; enabling the mod does not start or take over HQPlayer.

module.exports = function activate(api) {
    const engine = createHqpEngine(event => api.rpc.send('hqplayer.event', event), path.join(api.storage.paths.cache, 'sources'));
    let heartbeat = 0;
    api.rpc.handle('hqplayer.inspect', inspectHqplayer);
    api.rpc.handle('hqplayer.ensureRunning', ensureHqplayer);
    api.rpc.handle('hqplayer.heartbeat', () => { heartbeat = Date.now(); });
    for (const method of ['configure', 'open', 'play', 'pause', 'seek', 'setVolume', 'dispose', 'readDsp', 'applyDsp']) {
        api.rpc.handle(`hqplayer.${method}`, (...args) => {
            if (method === 'open') heartbeat = Date.now();
            if (method === 'dispose') heartbeat = 0;
            return engine[method](...args);
        });
    }
    const lease = setInterval(() => {
        if (heartbeat && Date.now() - heartbeat > 15000) {
            heartbeat = 0;
            void engine.dispose().catch(error => api.log.error('HQPlayer renderer lease cleanup failed; confirm HQPlayer stopped', error));
        }
    }, 2000);
    lease.unref();
    api.onDispose(async () => {
        clearInterval(lease);
        await engine.dispose();
    });
};
