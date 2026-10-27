import React from 'react';
import { Route } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { QuickTile } from '../panelTab/controls/QuickTile';
import { openHifiSignalPath } from './hifiPanelStore';
import { playbackRouteSummary } from './playbackRouteSummary';
import { useHifiSignalPath } from './useHifiSignalPath';
import { useWebAudioSignal } from './useWebAudioSignal';
import { selectedPlaybackBackend, subscribePlaybackBackends } from '../../services/playbackBackend/registry';

// 音质页复用控制页的信号链路卡片样式；名字后面带上当前链路的一词概括，细节在打开的弹窗中展示。

export const PlaybackSignalPathButton: React.FC = () => {
    const { t } = useTranslation();
    const mod = React.useSyncExternalStore(subscribePlaybackBackends, selectedPlaybackBackend);
    const summary = playbackRouteSummary(useHifiSignalPath(), useWebAudioSignal());
    // This panel verifies only the host's Web/mpv paths, not an external player's device or DSP.
    if (mod !== null) return null;
    return (
        <div className="grid min-w-0 px-1 py-2">
            <QuickTile
                kind="open"
                lit={summary === 'nativePassthrough'}
                icon={<Route size={18} />}
                label={summary
                    ? t('hifi.player.signalPathTile', { verdict: t(`hifi.route.${summary}`) })
                    : t('hifi.web.openSignalPath')}
                aria-haspopup="dialog"
                onClick={openHifiSignalPath}
            />
        </div>
    );
};
