import { describe, expect, test } from 'bun:test';
import {
	coefficients,
	defaultEq,
	readEq,
	responseDb,
	frequencyPosition,
	positionFrequency,
	maxFrequency,
	isChannelEq,
	bandEditable
} from '../src/lib/modules/pipeline/eq';
import { DEFAULT_NODE_DATA, withDefaults } from '../src/lib/modules/pipeline/defaults';
import { migrate } from '../src/lib/modules/pipeline/migrations';
import { PIPELINE_VERSION } from '../src/lib/modules/pipeline/version';
import type { EqBand } from '../src/lib/modules/pipeline/generated/EqBand';
import type { EqData } from '../src/lib/modules/pipeline/generated/EqData';
import type { Pipeline } from '../src/lib/modules/pipeline/types';
import fixtures from './fixtures/eq-response.json';
import { FACTORY_PRESETS } from '../src/lib/modules/preset/factory';

describe('EQ persistence and graph math', () => {
	test('new EQ is parametric; old pipelines and presets remain graphic', () => {
		const gainsDb = [-18, -9, 0, -2, -1, 0, 3, 2, 1, 0] as ReturnType<typeof defaultEq>['gainsDb'];
		expect(DEFAULT_NODE_DATA.eq.mode).toBe('parametric');
		expect(defaultEq().bands).toHaveLength(8);
		expect(readEq({ gainsDb }).mode).toBe('graphic');
		expect(withDefaults('eq', { gainsDb })).toMatchObject({ mode: 'graphic', gainsDb });
		const p = { version: 2, nodes: [{ id: 'eq', kind: 'eq', data: { gainsDb }, position: { x: 0, y: 0 } }], edges: [] } as unknown as Pipeline;
		const migrated = migrate(p);
		expect(migrated.version).toBe(PIPELINE_VERSION);
		expect(migrated.nodes[0].data).toMatchObject({ mode: 'graphic', gainsDb });
		const next = defaultEq();
		next.bands[0] = { filter: 'lowShelf', frequency: 123, gainDb: 4, q: 2, enabled: false };
		expect(readEq(JSON.parse(JSON.stringify(next)))).toEqual(next);
	});
	test('new Channel EQ has fixed shapes, starting frequencies, and only four enabled bells', () => {
		const eq = defaultEq();
		expect(DEFAULT_NODE_DATA.eq).toEqual(eq);
		expect(eq.bands.map((b) => b.filter)).toEqual(['lowCut', 'lowShelf', 'bell', 'bell', 'bell', 'bell', 'highShelf', 'highCut']);
		expect(eq.bands.map((b) => b.frequency)).toEqual([20, 75, 100, 250, 1040, 2500, 7500, 20000]);
		expect(eq.bands.map((b) => b.enabled)).toEqual([false, false, true, true, true, true, false, false]);
		expect(eq.bands.every((b) => b.gainDb === 0)).toBe(true);
		expect(eq.bands[0].q).toBeCloseTo(0.707, 3);
		expect(eq.bands[7].q).toBeCloseTo(0.707, 3);
		for (const sr of [8000, 16000, 44100, 48000, 96000]) {
			for (let t = 0; t <= 100; t++) expect(responseDb(eq, positionFrequency(t / 100, maxFrequency(sr)), sr)).toBeCloseTo(0, 8);
		}
	});
	test('missing saved fields keep the original backward defaults, independent of new EQ defaults', () => {
		const bands = [40, 100, 250, 630, 1600, 4000, 10000, 16000].map((frequency) => ({
			filter: 'bell',
			frequency,
			gainDb: 0,
			q: 1,
			enabled: true
		})) as EqData['bands'];
		const gainsDb: EqData['gainsDb'] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		for (const mode of ['graphic', 'parametric'] as const) {
			const stored = { mode, bypassed: true };
			const expected = { ...stored, bands, gainsDb };
			expect(readEq(stored)).toEqual(expected);
			expect(withDefaults('eq', stored)).toEqual(expected);
			expect(readEq({ ...stored, bands: defaultEq().bands }).bands).toEqual(defaultEq().bands);
		}
		expect(readEq({})).toEqual({ mode: 'graphic', bypassed: false, bands, gainsDb });
		const first = readEq({ mode: 'parametric' });
		first.bands[0].frequency = 999;
		first.gainsDb[0] = 10;
		expect(readEq({ mode: 'parametric' }).bands).toEqual(bands);
		expect(readEq({}).gainsDb).toEqual(gainsDb);
	});
	test('fixed-layout detection checks saved shapes and order, never the curve settings', () => {
		const eq = defaultEq();
		for (const b of eq.bands) Object.assign(b, { frequency: 333, gainDb: 7, q: 2.3, enabled: !b.enabled });
		expect(isChannelEq(eq)).toBe(true);
		expect(isChannelEq({ ...eq, mode: 'graphic' })).toBe(false);
		expect(isChannelEq(readEq({ mode: 'parametric' }))).toBe(false);
		[eq.bands[0], eq.bands[7]] = [eq.bands[7], eq.bands[0]];
		expect(isChannelEq(eq)).toBe(false);
		expect(readEq(JSON.parse(JSON.stringify(eq)))).toEqual(eq);
	});
	test('band editing requires both an engaged node and enabled band; legacy gains respect bypass', () => {
		const eq = defaultEq();
		expect(eq.bands.map((_, i) => bandEditable(eq, i))).toEqual([false, false, true, true, true, true, false, false]);
		eq.bypassed = true;
		expect(eq.bands.every((_, i) => !bandEditable(eq, i))).toBe(true);
		const legacy = readEq({});
		expect(bandEditable(legacy, 9)).toBe(true);
		legacy.bypassed = true;
		expect(bandEditable(legacy, 9)).toBe(false);
	});
	test('factory presets retain graphic gains and omit instance bypass', () => {
		const presets = FACTORY_PRESETS.filter((p) => p.kind === 'eq');
		expect(presets).toHaveLength(6);
		for (const p of presets) {
			expect(p.data).toMatchObject({ mode: 'graphic' });
			expect('bypassed' in p.data).toBe(false);
		}
		expect(presets[0].data).toMatchObject({ gainsDb: [-18, -9, 0, -2, -1, 0, 3, 2, 1, 0] });
	});
	test('logarithmic positions round trip and stay below Nyquist', () => {
		for (const sr of [8000, 44100, 48000, 384000]) {
			const max = maxFrequency(sr);
			expect(max).toBeLessThan(sr / 2);
			for (const hz of [20, 100, 1000, max]) expect(positionFrequency(frequencyPosition(hz, max), max)).toBeCloseTo(hz, 8);
		}
	});
	test('flat, disabled, and bypass responses are unity', () => {
		const d = defaultEq();
		for (const f of [20, 100, 1000, 10000, 20000]) expect(responseDb(d, f, 48000)).toBeCloseTo(0, 8);
		d.bands[0].enabled = false;
		d.bands[0].gainDb = 18;
		d.bands[0].filter = 'lowCut';
		expect(responseDb(d, 1000, 48000)).toBeCloseTo(0, 8);
		d.bands[0].enabled = true;
		d.bypassed = true;
		expect(responseDb(d, 1000, 48000)).toBe(0);
	});
	test('bell peak and Q have audible meaning', () => {
		const d = defaultEq();
		Object.assign(d.bands[2], { frequency: 1000, gainDb: 12 });
		expect(responseDb(d, 1000, 48000)).toBeCloseTo(12, 8);
		const wide = responseDb(d, 700, 48000);
		d.bands[2].q = 8;
		expect(responseDb(d, 700, 48000)).toBeLessThan(wide - 4);
	});
	test('coefficients match the shared Rust contract at rate boundaries', () => {
		for (const f of fixtures.parametric) {
			coefficients(f.band as EqBand, f.sampleRate).forEach((v, i) => expect(v).toBeCloseTo(f.coefficients[i], 10));
		}
	});
	test('legacy graph sums digital branches with their phase', () => {
		for (const f of fixtures.graphic) {
			const d = readEq({ gainsDb: f.gainsDb as ReturnType<typeof defaultEq>['gainsDb'] });
			expect(responseDb(d, f.frequency, f.sampleRate)).toBeCloseTo(f.db, 7);
		}
		// Sequential legacy crossovers are not a cascade of peaking filters, even at zero gain.
		expect(Math.abs(responseDb(defaultEq('graphic'), 1000, 48000))).toBeGreaterThan(0.01);
	});
});
