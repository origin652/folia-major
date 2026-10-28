'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

// Only the trusted main frame can configure the archive; the root comes exclusively from the native directory picker.
const registerAudioArchiveIpc = ({ ipcMain, archive, dialog, getWindow, isTrusted, forbiddenRoots = [] }) => {
    const observed = new WeakSet();
    const owner = event => {
        const contents = event.sender;
        if (!isTrusted(contents) || event.senderFrame !== contents.mainFrame) throw new Error('Untrusted archive request');
        if (!observed.has(contents)) {
            observed.add(contents);
            const release = () => archive.releaseOwner(contents.id);
            contents.once('destroyed', release);
            contents.on('render-process-gone', release);
            contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) release(); });
        }
        return contents.id;
    };
    ipcMain.handle('audio-archive-settings', event => { owner(event); return archive.settings(); });
    ipcMain.handle('audio-archive-configure', (event, patch) => { owner(event); return archive.configure(patch); });
    ipcMain.handle('audio-archive-find', (event, query) => archive.find(query, owner(event)));
    ipcMain.handle('audio-archive-choose', async event => {
        owner(event);
        const result = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] });
        if (result.canceled || !result.filePaths[0]) return archive.settings();
        const selected = await fs.realpath(result.filePaths[0]);
        const roots = typeof forbiddenRoots === 'function' ? forbiddenRoots() : forbiddenRoots;
        const resolvedRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => path.resolve(root))));
        if (resolvedRoots.some(root => {
            const relative = path.relative(root, selected);
            return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
        })) throw new Error('Choose an archive directory outside the application and its cache');
        return archive.choose(selected);
    });
};

module.exports = { registerAudioArchiveIpc };
