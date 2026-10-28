import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AudioTransferSnapshot } from '../../types/playbackTransfer';
import { formatByteSize } from '../../utils/formatByteSize';
import { useReducedMotionFor } from '../../hooks/useReducedMotionFor';

// Transfer feedback stays visible when the companion window's transport keys fade away.
export const RemoteTransferStatus = ({ transfer }: { transfer?: AudioTransferSnapshot | null }) => {
    const { t } = useTranslation();
    const reduced = useReducedMotionFor('uiMicroMotion');
    if (!transfer || !transfer.buffering && !(transfer.bytesPerSecond > 0)) return null;
    const speed = `${formatByteSize(Math.max(0, transfer.bytesPerSecond))}/s`;
    return (
        <div className="remote-transfer" data-buffering={transfer.buffering} title={t('remote.audioDownloadSpeed')}>
            {transfer.buffering && <>
                <Loader2 size={11} aria-hidden className={reduced ? undefined : 'remote-transfer__spinner'} />
                <span role="status" className="sr-only">{t('remote.buffering')}</span>
            </>}
            <span aria-label={t('remote.audioDownloadSpeed')}>{speed}</span>
        </div>
    );
};
