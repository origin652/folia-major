'use strict';

// An OK command reply is not a position acknowledgement, especially just after loading an HTTP URI.
const confirmResumeSeek = async ({ request, readStatus, stillOwns }, seconds) => {
    const target = Math.floor(seconds);
    let sent = 0;
    for (let attempt = 0; attempt < 16; attempt++) {
        let status = await readStatus();
        if (!stillOwns(status)) throw new Error('HQPlayer transport changed while restoring the playback position');
        if (!['paused', 'playing'].includes(status.state)) throw new Error('HQPlayer stopped while restoring the playback position');
        // Wait for decoder metadata as well as PLAYING; URI acknowledgement can precede seek readiness.
        if ((target === 0 || status.duration > target) && sent < 3 && attempt % 2 === 0) {
            await request('Seek', { position: target });
            sent++;
            status = await readStatus();
            if (!stillOwns(status)) throw new Error('HQPlayer transport changed while restoring the playback position');
        }
        if (sent && status.state === 'paused' && Math.abs(status.position - target) <= 1) return status;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('HQPlayer did not confirm the resume position; playback remains paused. This stream may not support seeking.');
};

module.exports = { confirmResumeSeek };
