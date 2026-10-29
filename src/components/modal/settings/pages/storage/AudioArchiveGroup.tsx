import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAudioArchiveStore, isAudioArchiveSupported } from '../../../../../services/audioArchive/useAudioArchiveStore';
import { Button, CopyValue, Row, Status, Toggle, Value } from '../../kit';
import { ARCHIVE_OPTIONS } from './options';

// Archive rows share the audio storage card; the native service still owns their directory and settings.
const AudioArchiveGroup: React.FC = () => {
    const { t } = useTranslation();
    const { settings, busy, error, refresh, configure, choose } = useAudioArchiveStore();
    useEffect(() => { void refresh(); }, [refresh]);
    if (!isAudioArchiveSupported()) return null;
    return (
        <>
            <Row option={ARCHIVE_OPTIONS.enabled} hint={t('audioArchive.description')}>
                <Toggle checked={settings.enabled} disabled={busy || !settings.directory} onChange={enabled => void configure({ enabled })} />
            </Row>
            <Row option={ARCHIVE_OPTIONS.directory} hint={t('audioArchive.directoryHint')}>
                {settings.directory ? <CopyValue value={settings.directory} /> : <Value>{t('audioArchive.chooseFirst')}</Value>}
                <Button disabled={busy} onClick={() => void choose()}>{t('audioArchive.choose')}</Button>
            </Row>
            <Row option={ARCHIVE_OPTIONS.preferLocal} hint={t('audioArchive.preferHint')}>
                <Toggle checked={settings.preferLocal} disabled={busy} onChange={preferLocal => void configure({ preferLocal })} />
            </Row>
            <Row label={t('audioArchive.status')} hint={t('audioArchive.limits')}>
                <Value>{t('audioArchive.saved', { count: settings.savedCount })}{settings.lastSaved ? ` · ${settings.lastSaved}` : ''}</Value>
                <Button disabled={busy} onClick={() => void refresh()}>{t('audioArchive.refresh')}</Button>
            </Row>
            {error && <Row label={<Status tone="error">{t('audioArchive.failed')}</Status>} hint={error} />}
        </>
    );
};

export default AudioArchiveGroup;
