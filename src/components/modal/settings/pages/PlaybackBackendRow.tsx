import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { isPlaybackEngineSwitching, listPlaybackBackends, selectedPlaybackBackend, subscribePlaybackBackends } from '../../../../services/playbackBackend/registry';
import { selectedPlaybackEngine, selectPlaybackEngine, subscribePlaybackEngineSwitch } from '../../../../services/playbackBackend/selection';
import { backendPlayback } from '../../../../services/playbackBackend/controller';
import { usePlaybackStore } from '../../../../stores/usePlaybackStore';
import { useHifiSettingsStore } from '../../../../stores/useHifiSettingsStore';
import { setStatusMessage } from '../../../../stores/useStatusMessageStore';
import { useHifiEngineStore } from '../../../../services/hifi/hifiEngine';
import { Row, Select, Status, type SettingsOptionDef } from '../kit';

// Only backend choice and reported state; device, DSP and engine settings belong to each mod.

const subscribeStatus = (listener: () => void) => backendPlayback.subscribe(() => listener());

export const PlaybackBackendRow = ({ option, onSelectMpv }: { option: SettingsOptionDef; onSelectMpv: () => void }) => {
    const { t } = useTranslation();
    const entries = useSyncExternalStore(subscribePlaybackBackends, listPlaybackBackends);
    const selected = useSyncExternalStore(subscribePlaybackBackends, selectedPlaybackBackend);
    const status = useSyncExternalStore(subscribeStatus, backendPlayback.getStatus);
    const switching = useSyncExternalStore(subscribePlaybackEngineSwitch, isPlaybackEngineSwitching);
    useHifiSettingsStore(state => state.enabled);
    const stage = usePlaybackStore(state => state.activePlaybackContext === 'stage');
    const supportsMpv = useHifiEngineStore(state => state.supported);
    const options = [
        { value: 'web', label: t('hifi.settings.engineWeb') },
        ...(supportsMpv ? [{ value: 'mpv', label: t('hifi.settings.engineMpv') }] : []),
        ...entries.map(entry => ({ value: `mod:${entry.id}`, label: entry.definition.name })),
    ];
    if (selected && !entries.some(entry => entry.id === selected)) {
        options.push({ value: `mod:${selected}`, label: t('options.playbackBackendMissing') });
    }
    const output = selected ? status.output : undefined;
    const unavailable = !supportsMpv && entries.length === 0;
    return (
        <Row option={option} hint={t(unavailable ? 'hifi.settings.unsupported' : 'options.playbackBackendHint')} disabled={unavailable}>
            {output && <Status tone={output.exclusiveRequested && output.exclusiveActive !== true ? 'warn' : undefined}>
                {t(output.exclusiveActive === true ? 'options.playbackExclusiveActive'
                    : output.exclusiveRequested ? 'options.playbackExclusiveUnknown' : 'options.playbackShared')}
                {output.sampleRate ? ` · ${output.sampleRate} Hz` : ''}
                {output.format ? ` · ${output.format}` : ''}
            </Status>}
            <Select value={selectedPlaybackEngine()} options={options} disabled={switching || stage || (!supportsMpv && entries.length === 0)} onChange={value => {
                if (value === 'mpv') { onSelectMpv(); return; }
                void selectPlaybackEngine(value).catch(error => {
                    console.error('[PlaybackBackend] Engine selection failed', error);
                    setStatusMessage({ type: 'error', text: t('options.playbackBackendFailed') });
                });
            }} />
        </Row>
    );
};
