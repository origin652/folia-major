'use strict';

const { createHash } = require('node:crypto');
const { numeric } = require('./protocol.cjs');

// Control SDK setters take list indices, not the engine values in Modes/Filters/ShapersItem.

const indexAttribute = (root, key) => {
    const value = numeric(root, key);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid HQPlayer DSP index: ${key}`);
    return value;
};

const readSelection = async connection => {
    const state = await connection.request('State');
    const selection = {
        mode: indexAttribute(state, 'mode'),
        filter: indexAttribute(state, state.hasAttribute('filterNx') ? 'filterNx' : 'filter'),
        shaper: indexAttribute(state, 'shaper'), rate: indexAttribute(state, 'rate'),
    };
    if (state.hasAttribute('filter1x')) selection.filter1x = indexAttribute(state, 'filter1x');
    return selection;
};

const readList = async (connection, command, tag, rate = false) => {
    const root = await connection.request(command);
    const items = Array.from(root.getElementsByTagName(tag)).map(item => {
        const index = indexAttribute(item, 'index');
        if (rate) {
            const hz = numeric(item, 'rate');
            if (!Number.isSafeInteger(hz) || hz < 0) throw new Error('Invalid HQPlayer DSP rate');
            return { index, rate: hz, name: hz === 0 ? '[source]' : `${hz} Hz` };
        }
        const name = item.getAttribute('name');
        if (!name || name.length > 256) throw new Error(`Invalid HQPlayer ${command} name`);
        return { index, name, value: numeric(item, 'value') };
    });
    if (!items.length || items.length > 512 || new Set(items.map(item => item.index)).size !== items.length) {
        throw new Error(`Invalid HQPlayer ${command} list`);
    }
    return items;
};

const readDsp = async connection => {
    const selection = await readSelection(connection);
    const modes = await readList(connection, 'GetModes', 'ModesItem');
    const filters = await readList(connection, 'GetFilters', 'FiltersItem');
    const shapers = await readList(connection, 'GetShapers', 'ShapersItem');
    const rates = await readList(connection, 'GetRates', 'RatesItem', true);
    const lists = { mode: modes, filter: filters, filter1x: filters, shaper: shapers, rate: rates };
    for (const [key, index] of Object.entries(selection)) {
        if (!lists[key].some(item => item.index === index)) throw new Error(`HQPlayer current ${key} is not in its available list`);
    }
    if (JSON.stringify(selection) !== JSON.stringify(await readSelection(connection))) {
        throw new Error('HQPlayer DSP changed during refresh; read its options again');
    }
    const data = { selection, modes, filters, shapers, rates };
    return { ...data, revision: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
};

const planDsp = (snapshot, revision, patch) => {
    if (revision !== snapshot.revision) throw new Error('HQPlayer DSP options have changed; refresh before applying');
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid HQPlayer DSP changes');
    const keys = Object.keys(patch);
    if (!keys.length || (keys.includes('mode') && keys.length !== 1)) {
        throw new Error('Apply the output mode separately, then review its new DSP options');
    }
    const lists = { mode: snapshot.modes, filter: snapshot.filters, filter1x: snapshot.filters,
        shaper: snapshot.shapers, rate: snapshot.rates };
    const changes = {};
    for (const key of keys) {
        const index = patch[key];
        if (!Object.hasOwn(snapshot.selection, key) || !Number.isSafeInteger(index) || !lists[key].some(item => item.index === index)) {
            throw new Error(`Unavailable HQPlayer DSP selection: ${key}`);
        }
        if (index !== snapshot.selection[key]) changes[key] = index;
    }
    return changes;
};

const applyDsp = async (connection, snapshot, changes) => {
    const next = { ...snapshot.selection, ...changes };
    try {
        if ('mode' in changes) await connection.request('SetMode', { value: next.mode });
        if ('filter' in changes || 'filter1x' in changes) {
            const attributes = { value: next.filter };
            if ('filter1x' in next) attributes.value1x = next.filter1x;
            await connection.request('SetFilter', attributes);
        }
        if ('shaper' in changes) await connection.request('SetShaping', { value: next.shaper });
        if ('rate' in changes) await connection.request('SetRate', { value: next.rate });
        const result = await readDsp(connection);
        for (const [key, value] of Object.entries(changes)) {
            if (result.selection[key] !== value) throw new Error(`HQPlayer did not confirm ${key}`);
        }
        return result;
    } catch (error) {
        // The protocol has no transaction/rollback. Never blindly repeat setters after a timeout.
        throw new Error('HQPlayer DSP was not fully confirmed; some settings may have changed. Refresh before retrying.', { cause: error });
    }
};

module.exports = { readDsp, planDsp, applyDsp };
