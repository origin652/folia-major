import { createRequire } from 'node:module';
import { vi } from 'vitest';

// Sparse indices deliberately differ from engine values, as in the official live protocol.
const require = createRequire(import.meta.url);
const { parseResponse, commandXml } = require('../../../extensions/hqplayer/protocol.cjs');
export const addDspFixture = (connection: { request: ReturnType<typeof vi.fn> }) => {
    const state = { mode: 1, filter: 37, filter1x: 37, filterNx: 40, shaper: 7, rate: 8 };
    const original = connection.request.getMockImplementation() as ((name: string, attrs: Record<string, number>) => unknown) | undefined;
    const lists = {
        GetModes: '<ModesItem index="1" name="PCM" value="0"/><ModesItem index="2" name="SDM" value="1"/>',
        GetFilters: '<FiltersItem index="2" name="IIR2" value="57"/><FiltersItem index="37" name="poly-sinc-gauss-long" value="37"/><FiltersItem index="40" name="poly-sinc-gauss-hires-lp" value="40"/>',
        GetShapers: '<ShapersItem index="7" name="TPDF" value="5"/><ShapersItem index="9" name="shaped" value="6"/>',
        GetRates: '<RatesItem index="0" rate="0"/><RatesItem index="8" rate="384000"/><RatesItem index="12" rate="768000"/>',
    };
    connection.request.mockImplementation(async (name: string, attrs: Record<string, number>) => {
        if (name === 'State') return parseResponse(commandXml(name, state), name);
        if (name in lists) return parseResponse(`<${name}>${lists[name as keyof typeof lists]}</${name}>`, name);
        if (name === 'SetMode') state.mode = attrs.value;
        if (name === 'SetFilter') { state.filterNx = attrs.value; if (attrs.value1x !== undefined) state.filter1x = attrs.value1x; }
        if (name === 'SetShaping') state.shaper = attrs.value;
        if (name === 'SetRate') state.rate = attrs.value;
        return original ? original(name, attrs) : parseResponse(commandXml(name, { result: 'OK' }), name);
    });
    return { state, lists };
};
