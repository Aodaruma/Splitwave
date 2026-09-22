import { describe, expect, test } from 'bun:test';
import { bellQAtFrequency, bellQBounds } from '../src/lib/modules/flow/ui/effect/_eq_display';
import { defaultEq, maxFrequency, responseDb } from '../src/lib/modules/pipeline/eq';

describe('graphical Bell Q handles', () => {
	test('boundaries follow the digital half-gain response and invert back to Q', () => {
		for (const sr of [8000, 44100, 48000, 192000]) {
			for (const frequency of [20, 1000, maxFrequency(sr)]) {
				for (const q of [0.1, 1, 12]) {
					const edges = bellQBounds(frequency, q, sr);
					expect(edges[0]).toBeLessThan(frequency);
					expect(edges[1]).toBeGreaterThan(frequency);
					expect(edges[0]).toBeGreaterThan(0);
					expect(edges[1]).toBeLessThan(sr / 2);
					for (const edge of edges) {
						expect(bellQAtFrequency(frequency, edge, sr)).toBeCloseTo(q, 8);
						for (const gainDb of [-12, 12]) {
							const eq = defaultEq();
							eq.bands.forEach((b) => (b.enabled = false));
							Object.assign(eq.bands[2], { frequency, gainDb, q, enabled: true });
							expect(responseDb(eq, edge, sr)).toBeCloseTo(gainDb / 2, 4);
						}
					}
				}
			}
		}
	});
	test('dragging toward the center narrows the band and clamps Q at the center', () => {
		expect(bellQAtFrequency(1000, 1000, 48000)).toBe(12);
		expect(bellQAtFrequency(1000, 900, 48000)).toBeGreaterThan(bellQAtFrequency(1000, 500, 48000));
		expect(bellQAtFrequency(1000, 1100, 48000)).toBeGreaterThan(bellQAtFrequency(1000, 2000, 48000));
		expect(bellQAtFrequency(1000, 20, 48000)).toBe(0.1);
	});
});
