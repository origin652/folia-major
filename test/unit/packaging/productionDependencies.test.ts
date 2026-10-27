import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Exercises nested Node resolution in the archive checker, including the missing electron-store/conf regression.
const { inspectProductionDependencies, verifyProductionDependencies } = require('../../../packaging/verifyProductionDependencies.cjs') as {
    inspectProductionDependencies: (read: (file: string) => Package | null) => {
        checkedPackages: number;
        missing: { from: string; dependency: string }[];
    };
    verifyProductionDependencies: (file: string) => { checkedPackages: number; missing: unknown[] };
};
type Package = { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const inspect = (files: Record<string, Package>) => inspectProductionDependencies(file => files[file] ?? null);

describe('packaged production dependency closure', () => {
    it('reads nested and scoped manifests from an actual ASAR on this operating system', async () => {
        const { createPackage } = require('@electron/asar');
        const directory = await mkdtemp(path.join(tmpdir(), 'folia-dependency-check-'));
        try {
            const archive = path.join(directory, 'app.asar');
            const files = {
                'package.json': { dependencies: { '@scope/store': '1' } },
                'node_modules/@scope/store/package.json': { dependencies: { conf: '1' } },
                'node_modules/conf/package.json': {},
            };
            const source = path.join(directory, 'source');
            for (const [file, pkg] of Object.entries(files)) {
                const target = path.join(source, file);
                await mkdir(path.dirname(target), { recursive: true });
                await writeFile(target, JSON.stringify(pkg));
            }
            await createPackage(source, archive);
            expect(verifyProductionDependencies(archive)).toEqual({ checkedPackages: 3, missing: [] });
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('catches a missing transitive dependency even with every direct dependency present', () => {
        expect(inspect({
            'package.json': { dependencies: { 'electron-store': '^11' } },
            'node_modules/electron-store/package.json': { dependencies: { conf: '^15' } },
        }).missing).toEqual([{ from: 'node_modules/electron-store/package.json', dependency: 'conf' }]);
    });

    it('resolves hoisted dependencies and their children', () => {
        expect(inspect({
            'package.json': { dependencies: { 'electron-store': '^11' } },
            'node_modules/electron-store/package.json': { dependencies: { conf: '^15' } },
            'node_modules/conf/package.json': { dependencies: { 'dot-prop': '^10' } },
            'node_modules/dot-prop/package.json': {},
        })).toEqual({ checkedPackages: 4, missing: [] });
    });

    it('prefers a package-local nested dependency over the hoisted copy', () => {
        expect(inspect({
            'package.json': { dependencies: { client: '1' } },
            'node_modules/client/package.json': { dependencies: { dep: '1' } },
            'node_modules/client/node_modules/dep/package.json': {},
            'node_modules/dep/package.json': { dependencies: { absent: '1' } },
        })).toEqual({ checkedPackages: 3, missing: [] });
    });

    it('handles scoped packages and dependency cycles', () => {
        expect(inspect({
            'package.json': { dependencies: { '@scope/client': '1' } },
            'node_modules/@scope/client/package.json': { dependencies: { dep: '1' } },
            'node_modules/dep/package.json': { dependencies: { '@scope/client': '1' } },
        })).toEqual({ checkedPackages: 3, missing: [] });
    });

    it('allows absent optional platform packages but verifies present optional packages', () => {
        expect(inspect({
            'package.json': { optionalDependencies: { absent: '1', present: '1' } },
            'node_modules/present/package.json': { dependencies: { required: '1' } },
        }).missing).toEqual([{ from: 'node_modules/present/package.json', dependency: 'required' }]);
    });

    it('respects optional overrides of dependencies and ignores build-only dependencies', () => {
        expect(inspect({
            'package.json': { dependencies: { platform: '1' }, optionalDependencies: { platform: '1' }, devDependencies: { vite: '1' } },
        })).toEqual({ checkedPackages: 1, missing: [] });
    });

    it('fails if the archive has no root package manifest', () => {
        expect(() => inspect({})).toThrow('Missing package.json');
    });
});
