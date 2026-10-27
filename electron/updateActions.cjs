// Serializes checks and downloads so repeated UI/IPC requests cannot discard a staged installer.
function createUpdateActions({ getStatus, check, download, autoDownloadEnabled }) {
    let checking = null;
    let downloading = null;

    function checkNow(options) {
        if (getStatus().status === 'downloaded') return Promise.resolve(getStatus());
        if (!checking) {
            checking = Promise.resolve().then(() => check(options)).finally(() => { checking = null; });
        }
        return checking;
    }

    function downloadNow() {
        if (downloading) return downloading;
        if (getStatus().status === 'downloaded') return Promise.resolve(getStatus());
        downloading = Promise.resolve().then(async () => {
            // A manual request must work even when startup checking and auto-download are off.
            if (checking) await checking;
            else if (getStatus().status !== 'available') await checkNow({ manual: true });
            if (getStatus().status === 'disabled') await checkNow({ manual: true });
            if (getStatus().status === 'available') await download();
            return getStatus();
        }).finally(() => { downloading = null; });
        return downloading;
    }

    return {
        downloadNow,
        async checkNow(options) {
            if (downloading) return downloading;
            const status = await checkNow(options);
            return status.status === 'available' && autoDownloadEnabled() ? downloadNow() : status;
        },
    };
}

module.exports = { createUpdateActions };
