'use strict';

// Only the trusted main frame can mint media leases; navigation and crashes revoke its streams.

const registerPlaybackSourceIpc = ({ ipcMain, files, streams, isTrusted }) => {
    const observed = new WeakSet();
    const owner = event => {
        const contents = event.sender;
        if (!isTrusted(contents) || event.senderFrame !== contents.mainFrame) {
            throw new Error('Untrusted playback source request');
        }
        if (!observed.has(contents)) {
            observed.add(contents);
            const id = contents.id;
            const release = () => streams.releaseOwner(id);
            contents.once('destroyed', release);
            contents.on('render-process-gone', release);
            contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
                if (mainFrame && !inPlace) release();
            });
        }
        return contents.id;
    };
    ipcMain.handle('playback-source-stage', (event, data) => { owner(event); return files.stage(data); });
    ipcMain.handle('playback-source-stream', (event, url, context) => context === undefined
        ? streams.create(url, owner(event)) : streams.create(url, owner(event), context));
    ipcMain.handle('playback-source-played', (event, id) => streams.markPlayed(id, owner(event)));
    ipcMain.handle('playback-source-stream-error', (event, id) => streams.getError(id, owner(event)));
    ipcMain.handle('playback-source-release', async (event, id) => {
        streams.release(id, owner(event));
        await files.release(id);
    });
};

module.exports = { registerPlaybackSourceIpc };
