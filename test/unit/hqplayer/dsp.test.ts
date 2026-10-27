import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { addDspFixture } from './dspFixture';

// DSP snapshots are live capabilities, never hard-coded presets or automatic playback overrides.
const require = createRequire(import.meta.url);
const { readDsp, planDsp, applyDsp } = require('../../../extensions/hqplayer/dsp.cjs');
const setup = () => {
    const connection = { request: vi.fn() };
    return { connection, ...addDspFixture(connection) };
};
describe('HQPlayer DSP protocol', () => {
    it('reads selected indices and both filters without mistaking engine values for list indices', async () => {
        const s = setup();
        const snapshot = await readDsp(s.connection);
        expect(snapshot.selection).toEqual({ mode: 1, filter: 40, filter1x: 37, shaper: 7, rate: 8 });
        expect(snapshot.shapers[0]).toEqual({ index: 7, name: 'TPDF', value: 5 });
        expect(snapshot.rates[0]).toEqual({ index: 0, name: '[source]', rate: 0 });
        expect(s.connection.request.mock.calls.every(([name]) => !name.startsWith('Set'))).toBe(true);
    });
    it('sends only changed settings using indices, preserving the other filter', async () => {
        const s = setup();
        const snapshot = await readDsp(s.connection);
        const changes = planDsp(snapshot, snapshot.revision, { filter: 2, shaper: 9, rate: 12 });
        const after = await applyDsp(s.connection, snapshot, changes);
        expect(after.selection).toMatchObject({ filter: 2, filter1x: 37, shaper: 9, rate: 12 });
        expect(s.connection.request.mock.calls.filter(([name]) => name.startsWith('Set'))).toEqual([
            ['SetFilter', { value: 2, value1x: 37 }], ['SetShaping', { value: 9 }], ['SetRate', { value: 12 }],
        ]);
    });
    it('rejects stale capabilities, invalid selections and mixed mode/DSP changes before any setter', async () => {
        const s = setup();
        const snapshot = await readDsp(s.connection);
        for (const patch of [{ shaper: 5 }, { filter: 57 }, { rate: 384000 }, { filter1x: '37' }, { device: 1 }, { mode: 2, rate: 0 }]) {
            expect(() => planDsp(snapshot, snapshot.revision, patch)).toThrow();
        }
        s.state.mode = 2;
        const next = await readDsp(s.connection);
        expect(() => planDsp(next, snapshot.revision, { rate: 0 })).toThrow('refresh');
        expect(s.connection.request.mock.calls.some(([name]) => name.startsWith('Set'))).toBe(false);
    });
    it('refreshes all lists after a separate mode change and makes unchanged drafts a no-op', async () => {
        const s = setup();
        const snapshot = await readDsp(s.connection);
        expect(planDsp(snapshot, snapshot.revision, { filter: 40, shaper: 7, rate: 8 })).toEqual({});
        const next = await applyDsp(s.connection, snapshot, planDsp(snapshot, snapshot.revision, { mode: 2 }));
        expect(next.selection.mode).toBe(2);
        expect(s.connection.request).toHaveBeenCalledWith('SetMode', { value: 2 });
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'GetRates')).toHaveLength(2);
    });
    it('does not retry or roll back a partially applied change after a command failure', async () => {
        const s = setup();
        const snapshot = await readDsp(s.connection);
        const request = s.connection.request.getMockImplementation()!;
        s.connection.request.mockImplementation(async (name, attrs) => {
            if (name === 'SetRate') throw new Error('socket timeout');
            return request(name, attrs);
        });
        await expect(applyDsp(s.connection, snapshot, { shaper: 9, rate: 12 })).rejects.toThrow('some settings may have changed');
        expect(s.state.shaper).toBe(9);
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'SetRate')).toHaveLength(1);
        expect(s.connection.request.mock.calls.filter(([name]) => name === 'SetShaping')).toHaveLength(1);
    });
    it('rejects malformed or duplicate capabilities instead of inventing options', async () => {
        const s = setup();
        s.lists.GetRates = '<RatesItem index="8" rate="384000"/><RatesItem index="8" rate="768000"/>';
        await expect(readDsp(s.connection)).rejects.toThrow('Invalid HQPlayer GetRates list');
    });
    it('supports an older State without split filters, and never invents a 1x setter', async () => {
        const s = setup();
        const request = s.connection.request.getMockImplementation()!;
        s.connection.request.mockImplementation(async (name, attrs) => {
            const root = await request(name, attrs);
            if (name === 'State') { root.removeAttribute('filter1x'); root.removeAttribute('filterNx'); }
            return root;
        });
        const snapshot = await readDsp(s.connection);
        expect(snapshot.selection).toMatchObject({ filter: 37 });
        expect(snapshot.selection).not.toHaveProperty('filter1x');
        // Only test the request shape here: this legacy simulator does not update its old filter field.
        await expect(applyDsp(s.connection, snapshot, { filter: 2 })).rejects.toThrow('not fully confirmed');
        expect(s.connection.request).toHaveBeenCalledWith('SetFilter', { value: 2 });
    });
});
