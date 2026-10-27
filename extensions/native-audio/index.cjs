'use strict';

const { createNativeEngine } = require('./engine.cjs');
const { createDeviceDiscovery } = require('./devices.cjs');

// This entry uses only the public Folium API, never host source paths or internal stores.

module.exports = function activate(api) {
    const engine = createNativeEngine(event => api.rpc.send('native.event', event));
    const discovery = createDeviceDiscovery();
    api.rpc.handle('native.listDevices', executable => discovery.list(executable));
    let lastHeartbeat = 0;
    api.rpc.handle('native.heartbeat', () => { lastHeartbeat = Date.now(); });
    const lease = setInterval(() => {
        if (lastHeartbeat && Date.now() - lastHeartbeat > 30000) {
            lastHeartbeat = 0;
            void engine.dispose().catch(error => api.log.error('Native audio renderer lease cleanup failed', error));
        }
    }, 3000);
    lease.unref();
    const onExit = () => { discovery.disposeSync(); engine.disposeSync(); };
    process.once('exit', onExit);
    for (const method of ['configure', 'open', 'play', 'pause', 'seek', 'setVolume', 'dispose']) {
        api.rpc.handle(`native.${method}`, (...args) => {
            if (method === 'open') lastHeartbeat = Date.now();
            if (method === 'dispose') lastHeartbeat = 0;
            return engine[method](...args);
        });
    }
    api.onDispose(async () => {
        clearInterval(lease);
        discovery.disposeSync();
        try { await engine.dispose(); }
        catch (error) { api.log.error('Native audio cleanup failed', error); }
        finally { process.removeListener('exit', onExit); }
    });
};
