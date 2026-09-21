import { describe, expect, test } from 'bun:test';
import { coefficients, defaultEq, readEq, responseDb, frequencyPosition, positionFrequency, maxFrequency } from '../src/lib/modules/pipeline/eq';
import { DEFAULT_NODE_DATA, withDefaults } from '../src/lib/modules/pipeline/defaults';
import { migrate } from '../src/lib/modules/pipeline/migrations';
import { PIPELINE_VERSION } from '../src/lib/modules/pipeline/version';
import type { EqBand } from '../src/lib/modules/pipeline/generated/EqBand';
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
		Object.assign(d.bands[0], { frequency: 1000, gainDb: 12 });
		expect(responseDb(d, 1000, 48000)).toBeCloseTo(12, 8);
		const wide = responseDb(d, 700, 48000);
		d.bands[0].q = 8;
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
