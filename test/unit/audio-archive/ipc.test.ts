import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// Trust and owner assignment are enforced in native code, before settings or any archive path is accessed.
const require = createRequire(import.meta.url);
const { registerAudioArchiveIpc } = require('../../../electron/audioArchive/ipc.cjs');
describe('archive IPC', () => {
    it('refuses remote windows and iframes, and ignores renderer-provided paths', async () => {
        const handlers = new Map<string, (...args: any[]) => any>();
        const contents = Object.assign(new EventEmitter(), { id: 7, mainFrame: {} });
        const archive = { settings: vi.fn(), configure: vi.fn(), find: vi.fn(), choose: vi.fn(), releaseOwner: vi.fn() };
        const dialog = { showOpenDialog: vi.fn(async () => ({ canceled: true })) };
        registerAudioArchiveIpc({ ipcMain: { handle: (name: string, action: any) => handlers.set(name, action) }, archive, dialog,
            getWindow: vi.fn(), isTrusted: (sender: unknown) => sender === contents });
        const event = { sender: contents, senderFrame: contents.mainFrame };
        for (const handler of handlers.values()) {
            await expect(Promise.resolve().then(() => handler({ ...event, senderFrame: {} }, {}))).rejects.toThrow('Untrusted');
            await expect(Promise.resolve().then(() => handler({ ...event, sender: { mainFrame: contents.mainFrame } }, {}))).rejects.toThrow('Untrusted');
        }
        handlers.get('audio-archive-find')!(event, { songKey: 'test', quality: 'high', ownerId: 99 });
        expect(archive.find).toHaveBeenCalledWith(expect.anything(), 7);
        await handlers.get('audio-archive-choose')!(event, 'C:/renderer-chosen');
        expect(archive.choose).not.toHaveBeenCalled();
        contents.emit('did-start-navigation', {}, 'page', false, true);
        expect(archive.releaseOwner).toHaveBeenCalledWith(7);
    });
});
