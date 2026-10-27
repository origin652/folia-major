import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Launch decisions use fake processes/ports and a deterministic clock; never start a real player.

const require = createRequire(import.meta.url);
const { createHqpLauncher, launchDesktop } = require('../../../extensions/hqplayer/launcher.cjs');
const executable = path.resolve('installed', 'HQPlayer6Desktop.exe');
const setup = () => {
    let now = 0;
    let running = false;
    let ready = false;
    const probe = vi.fn(async () => ready);
    const inspect = vi.fn(async () => ({ running, candidates: [executable] }));
    const exists = vi.fn(async (file: string) => file === executable);
    const launch = vi.fn(async () => { running = true; ready = true; });
    const delay = vi.fn(async (ms: number) => { now += ms; });
    const ensure = createHqpLauncher({ probe, inspect, exists, launch, delay, now: () => now, timeoutMs: 1500 });
    return { ensure, probe, inspect, exists, launch, delay,
        running: (value: boolean) => { running = value; }, ready: (value: boolean) => { ready = value; } };
};

describe('HQPlayer Desktop process', () => {
    it('starts the GUI visibly without a shell and detaches only after spawn succeeds', async () => {
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        const spawn = vi.fn(() => child);
        const pending = launchDesktop(executable, spawn);
        expect(spawn).toHaveBeenCalledExactlyOnceWith(executable, [], {
            shell: false, detached: true, windowsHide: false, stdio: 'ignore', cwd: path.dirname(executable),
        });
        expect(child.unref).not.toHaveBeenCalled();
        child.emit('spawn');
        await pending;
        expect(child.unref).toHaveBeenCalledOnce();
    });
    it('reports spawn errors without detaching or retrying', async () => {
        const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
        const spawn = vi.fn(() => child);
        const pending = launchDesktop(executable, spawn);
        const error = new Error('access denied');
        child.emit('error', error);
        await expect(pending).rejects.toBe(error);
        expect(spawn).toHaveBeenCalledOnce();
        expect(child.unref).not.toHaveBeenCalled();
    });
});

describe('HQPlayer automatic launch', () => {
    it('never probes or launches when disabled', async () => {
        const s = setup();
        await s.ensure({ autoStart: false });
        expect(s.probe).not.toHaveBeenCalled();
        expect(s.inspect).not.toHaveBeenCalled();
        expect(s.launch).not.toHaveBeenCalled();
    });
    it('uses an available control endpoint without launching or inspecting processes', async () => {
        const s = setup();
        s.ready(true);
        await s.ensure({});
        expect(s.inspect).not.toHaveBeenCalled();
        expect(s.launch).not.toHaveBeenCalled();
    });
    it('starts the registered installation exactly once across concurrent selections/opens', async () => {
        const s = setup();
        await Promise.all([s.ensure({}), s.ensure({}), s.ensure({})]);
        expect(s.launch).toHaveBeenCalledExactlyOnceWith(executable);
        expect(s.probe).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 4321 }));
    });
    it('does not start a second process when an existing player has network control disabled', async () => {
        const s = setup();
        s.running(true);
        await expect(s.ensure({})).rejects.toThrow('No second instance');
        expect(s.launch).not.toHaveBeenCalled();
        expect(s.exists).not.toHaveBeenCalled();
    });
    it('waits for an existing player that is still starting', async () => {
        const s = setup();
        s.running(true);
        s.probe.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await s.ensure({});
        expect(s.delay).toHaveBeenCalledOnce();
        expect(s.launch).not.toHaveBeenCalled();
    });
    it('rechecks for a process started during installation discovery', async () => {
        const s = setup();
        s.inspect.mockResolvedValueOnce({ running: false, candidates: [executable] });
        s.inspect.mockImplementation(async () => { s.ready(true); return { running: true, candidates: [] }; });
        await s.ensure({});
        expect(s.launch).not.toHaveBeenCalled();
    });
    it('uses an explicit absolute executable without shell arguments and rejects other programs', async () => {
        const s = setup();
        const custom = path.resolve('custom', 'HQPlayer5Desktop.exe');
        s.exists.mockImplementation(async file => file === custom);
        await s.ensure({ executable: custom });
        expect(s.launch).toHaveBeenCalledExactlyOnceWith(custom);
        const other = setup();
        await expect(other.ensure({ executable: path.resolve('other.exe') })).rejects.toThrow('installation not found');
        expect(other.launch).not.toHaveBeenCalled();
        await expect(other.ensure({ executable: 'HQPlayer6Desktop.exe --play' })).rejects.toThrow('installation not found');
    });
    it('reports missing installs, spawn failure and protocol errors without a launch retry', async () => {
        const missing = setup();
        missing.exists.mockResolvedValue(false);
        await expect(missing.ensure({})).rejects.toThrow('installation not found');
        expect(missing.launch).not.toHaveBeenCalled();
        const failure = setup();
        failure.launch.mockRejectedValue(new Error('access denied'));
        await expect(failure.ensure({})).rejects.toThrow('access denied');
        expect(failure.launch).toHaveBeenCalledOnce();
        const wrongService = setup();
        wrongService.probe.mockRejectedValue(new Error('not HQPlayer'));
        await expect(wrongService.ensure({})).rejects.toThrow('not HQPlayer');
        expect(wrongService.launch).not.toHaveBeenCalled();
    });
});
