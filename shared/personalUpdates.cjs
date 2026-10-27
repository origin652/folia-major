// The personal fork has one update source; persisted official channel choices cannot override it.
const PERSONAL_UPDATES = Object.freeze({
    owner: 'origin652',
    repo: 'folia-major',
    branch: 'personal/playback-backends',
    channel: 'personal',
    releaseTag: 'personal-playback-backends',
});

function isPersonalVersion(version) {
    return typeof version === 'string'
        && /^\d+\.\d+\.\d+-personal\.\d+(?:\.\d+)?$/.test(version);
}

module.exports = { PERSONAL_UPDATES, isPersonalVersion };
