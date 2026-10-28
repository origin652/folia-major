'use strict';

// A lost renderer closes its output; heartbeats alone never reopen or resume it.
const createRendererLease = (api, engine) => {
    let heartbeat = 0;
    let source = null;
    let cleanup = Promise.resolve();
    const observe = event => {
        if (event.type === 'status' && event.status.sourceId === source?.sourceId) {
            source = { ...event.status };
        }
    };
    api.rpc.handle('hqplayer.heartbeat', () => { heartbeat = source ? Date.now() : 0; });
    for (const method of ['configure', 'open', 'play', 'pause', 'seek', 'setVolume', 'dispose', 'readDsp', 'applyDsp']) {
        api.rpc.handle(`hqplayer.${method}`, async (...args) => {
            await cleanup;
            if (method === 'open') {
                source = { sourceId: args[0].sourceId, position: 0, duration: 0 };
                heartbeat = Date.now();
            }
            if (method === 'dispose') {
                heartbeat = 0;
                source = null;
                cleanup = engine.dispose();
                return cleanup;
            }
            return engine[method](...args);
        });
    }
    const timer = setInterval(() => {
        if (!source || !heartbeat || Date.now() - heartbeat <= 15000) return;
        const expired = source;
        heartbeat = 0;
        source = null;
        cleanup = engine.dispose();
        void cleanup.catch(error => api.log.error('HQPlayer renderer lease cleanup failed; confirm HQPlayer stopped before reloading the mod', error));
        api.rpc.send('hqplayer.event', {
            type: 'lease-expired', sourceId: expired.sourceId,
            position: expired.position, duration: expired.duration,
            message: 'HQPlayer renderer heartbeat expired; output is being closed. Press Play to reload the track after cleanup.',
        });
    }, 2000);
    timer.unref();
    return {
        observe,
        dispose: async () => {
            clearInterval(timer);
            await cleanup;
            await engine.dispose();
        },
    };
};

module.exports = { createRendererLease };
