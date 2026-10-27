const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PERSONAL_UPDATES, isPersonalVersion } = require('../../shared/personalUpdates.cjs');
const { compareVersions, parseUpdateMetadataVersion } = require('../../electron/updateChannels.cjs');
const { stampPersonalPackage } = require('./stamp.cjs');

// Uploads uniquely named payloads before switching channel metadata; old download URLs stay valid.
function planPersonalRelease(files, readText) {
    const metadata = files.filter(file => /^personal(?:-mac)?\.yml$/.test(path.basename(file)));
    if (!metadata.some(file => path.basename(file) === 'personal.yml')) throw new Error('Missing Windows update metadata.');
    if (!files.some(file => file.endsWith('.exe'))) throw new Error('Missing Windows installer.');
    const versions = metadata.map(file => parseUpdateMetadataVersion(readText(file)));
    if (!versions.every(isPersonalVersion) || new Set(versions).size !== 1) {
        throw new Error('All channel metadata must identify the same personal version.');
    }
    const version = versions[0];
    const payloads = files.filter(file => /\.(exe|dmg|zip|deb|rpm|tar\.gz|blockmap)$/.test(file));
    if (payloads.some(file => !path.basename(file).includes(version))) throw new Error('Unversioned release payload.');
    return { version, metadata, payloads };
}

function listFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(file) : [file];
    });
}

function publishPersonalRelease(directory, env) {
    const source = PERSONAL_UPDATES;
    const repo = `${source.owner}/${source.repo}`;
    if (env.GITHUB_REPOSITORY !== repo || env.GITHUB_REF !== `refs/heads/${source.branch}`) {
        throw new Error('Refusing to publish outside the configured fork and branch.');
    }
    if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('Missing source commit.');
    const gh = (...args) => execFileSync('gh', [...args, '--repo', repo], { encoding: 'utf8' });
    const plan = planPersonalRelease(listFiles(directory), file => fs.readFileSync(file, 'utf8'));
    if (plan.version !== stampPersonalPackage(require('../../package.json'), env).version) {
        throw new Error('Artifacts do not belong to this build run and attempt.');
    }
    const releases = JSON.parse(gh('release', 'list', '--limit', '100', '--json', 'tagName,isDraft'));
    const existing = releases.find(release => release.tagName === source.releaseTag);
    if (existing && !existing.isDraft) {
        const previous = parseUpdateMetadataVersion(gh('release', 'download', source.releaseTag, '--pattern', 'personal.yml', '--output', '-'));
        if (!isPersonalVersion(previous) || compareVersions(plan.version, previous) <= 0) {
            throw new Error(`Refusing to replace ${previous} with ${plan.version}. Rerun to obtain a new attempt version.`);
        }
    }
    if (!existing) {
        gh('release', 'create', source.releaseTag, '--draft', '--prerelease', '--target', env.GITHUB_SHA,
            '--title', `Personal ${plan.version}`, '--notes', `Source: ${repo}@${source.branch}, commit ${env.GITHUB_SHA}`);
    }
    // No clobber or removal of old binaries: a client may still be downloading the previous build.
    gh('release', 'upload', source.releaseTag, ...plan.payloads);
    gh('release', 'upload', source.releaseTag, ...plan.metadata, '--clobber');
    gh('release', 'edit', source.releaseTag, '--draft=false', '--prerelease', '--latest=false',
        '--title', `Personal ${plan.version}`, '--notes', `Source: https://github.com/${repo}/tree/${source.branch}\nCommit: ${env.GITHUB_SHA}\nVersion: ${plan.version}`);
}

if (require.main === module) publishPersonalRelease(path.resolve(process.argv[2] || 'personal-artifacts'), process.env);

module.exports = { planPersonalRelease, publishPersonalRelease };
