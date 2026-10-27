const fs = require('node:fs');
const path = require('node:path');
const { PERSONAL_UPDATES } = require('../../shared/personalUpdates.cjs');

// Stamps CI builds with a monotonic personal version and a verifiable source identity.
function stampPersonalPackage(pkg, env) {
    const source = PERSONAL_UPDATES;
    if (env.GITHUB_REPOSITORY !== `${source.owner}/${source.repo}`
        || env.GITHUB_REF !== `refs/heads/${source.branch}`) {
        throw new Error('Personal releases must be built from the configured fork and branch.');
    }
    if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('Missing source commit.');
    for (const key of ['GITHUB_RUN_NUMBER', 'GITHUB_RUN_ATTEMPT']) {
        if (!/^[1-9]\d*$/.test(env[key] || '')) throw new Error(`Invalid ${key}.`);
    }
    const base = /^\d+\.\d+\.\d+/.exec(pkg.version)?.[0];
    if (!base) throw new Error('Missing semver base version.');
    return {
        ...pkg,
        version: `${base}-personal.${env.GITHUB_RUN_NUMBER}.${env.GITHUB_RUN_ATTEMPT}`,
        foliaReleaseChannel: source.channel,
        foliaUpdateSource: { ...source, commit: env.GITHUB_SHA },
        build: {
            ...pkg.build,
            generateUpdatesFilesForAllChannels: false,
            publish: [{
                provider: 'generic',
                url: `https://github.com/${source.owner}/${source.repo}/releases/download/${source.releaseTag}/`,
                channel: source.channel,
            }],
        },
    };
}

if (require.main === module) {
    const packagePath = path.resolve(__dirname, '../../package.json');
    const pkg = stampPersonalPackage(JSON.parse(fs.readFileSync(packagePath, 'utf8')), process.env);
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.info(`[PersonalRelease] ${pkg.version} from ${pkg.foliaUpdateSource.commit}`);
}

module.exports = { stampPersonalPackage };
