import { createSettingsAnchorCommand, defineCommand } from '../commandFactories';
import { isAudioArchiveSupported, useAudioArchiveStore } from '../../../services/audioArchive/useAudioArchiveStore';

// Archive actions use the same capability gate and native settings as the storage page; no execution shortcut.
export const audioArchiveCommands = [
    createSettingsAnchorCommand('settings-audio-archive', 'Audio archive', 'Open played audio archive settings',
        ['offline files', 'played music files', '播放保存'], 'mediaCache', { platform: ['electron'], isAvailable: isAudioArchiveSupported }),
    defineCommand({
        id: 'toggle-audio-archive', group: 'settings', title: 'Toggle audio archiving',
        description: 'Enable or disable archiving complete played audio',
        keywords: ['archive switch', 'save played music', '归档开关', '保存播放音频'],
        platform: ['electron'], isAvailable: isAudioArchiveSupported,
        execute: async (_input, context) => {
            await useAudioArchiveStore.getState().refresh();
            const state = useAudioArchiveStore.getState();
            if (!state.settings.directory) {
                context.shared.setStatusMsg({ type: 'info', text: context.shared.t('audioArchive.chooseFirst') });
                return false;
            }
            await state.configure({ enabled: !state.settings.enabled });
            return !useAudioArchiveStore.getState().error;
        },
    }),
];
