const nativePath = require('node:path');
const path = nativePath.posix;
const asar = require('@electron/asar');

// Checks the production dependency closure inside the finished archive, not the developer's node_modules.
function inspectProductionDependencies(readPackage) {
    const seen = new Set();
    const missing = [];
    function resolvePackage(directory, name) {
        for (let current = directory; ; current = path.dirname(current)) {
            if (path.basename(current) !== 'node_modules') {
                const candidate = path.join(current, 'node_modules', name, 'package.json');
                if (readPackage(candidate)) return candidate;
            }
            if (current === '.') return null;
        }
    }
    function visit(file) {
        if (seen.has(file)) return;
        const pkg = readPackage(file);
        if (!pkg) throw new Error(`[package-check] Missing ${file}`);
        seen.add(file);
        const optional = pkg.optionalDependencies || {};
        for (const name of new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(optional)])) {
            const resolved = resolvePackage(path.dirname(file), name);
            if (resolved) visit(resolved);
            else if (!Object.hasOwn(optional, name)) missing.push({ from: file, dependency: name });
        }
    }
    visit('package.json');
    return { checkedPackages: seen.size, missing };
}

function verifyProductionDependencies(archive) {
    const files = new Set(asar.listPackage(archive).map(file => file.replaceAll('\\', '/').replace(/^\//, '')));
    const cache = new Map();
    const result = inspectProductionDependencies(file => {
        if (!files.has(file)) return null;
        if (!cache.has(file)) cache.set(file, JSON.parse(asar.extractFile(archive, nativePath.normalize(file)).toString('utf8')));
        return cache.get(file);
    });
    if (result.missing.length) {
        const details = result.missing.slice(0, 20).map(({ from, dependency }) => `${from} -> ${dependency}`).join('\n');
        throw new Error(`[package-check] Missing ${result.missing.length} required production dependencies:\n${details}`);
    }
    console.info(`[package-check] Verified ${result.checkedPackages} production packages in ${archive}`);
    return result;
}

module.exports = { inspectProductionDependencies, verifyProductionDependencies };
