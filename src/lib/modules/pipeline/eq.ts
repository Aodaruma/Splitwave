import type { EqData } from './generated/EqData';
import type { EqBand } from './generated/EqBand';
import type { EqMode } from './generated/EqMode';

export const GRAPHIC_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const CROSSOVERS = [45.2548, 89.4427, 176.7767, 353.5534, 707.1068, 1414.2136, 2828.4271, 5656.8542, 11313.7085];
export const BAND_FREQUENCIES = [40, 100, 250, 630, 1600, 4000, 10000, 16000];
export const maxFrequency = (sampleRate: number) => Math.min(20000, sampleRate * 0.49);
export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
export const frequencyPosition = (hz: number, max: number) => Math.log(clamp(hz, 20, max) / 20) / Math.log(max / 20);
export const positionFrequency = (t: number, max: number) => 20 * (max / 20) ** clamp(t, 0, 1);

export function defaultEq(mode: EqMode = 'parametric'): EqData {
	return {
		mode,
		gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
		bypassed: false,
		bands: BAND_FREQUENCIES.map((frequency) => ({ filter: 'bell', frequency, gainDb: 0, q: 1, enabled: true })) as EqData['bands']
	};
}

/** Absence of mode means the original crossover algorithm, including old presets. */
export function readEq(stored: Partial<EqData>): EqData {
	return { ...defaultEq('graphic'), ...stored, mode: stored.mode ?? 'graphic' };
}

export type Coefficients = [number, number, number, number, number];
/** RBJ Q form, mirrored by audio/effects/eq.rs and checked against shared fixtures. */
export function coefficients(b: EqBand, sr: number): Coefficients {
	if (!b.enabled) return [1, 0, 0, 0, 0];
	const w = (2 * Math.PI * clamp(Math.fround(b.frequency), 20, maxFrequency(sr))) / sr;
	const c = Math.cos(w),
		alpha = Math.sin(w) / (2 * Math.fround(b.q)),
		a = 10 ** (Math.fround(b.gainDb) / 40),
		beta = 2 * Math.sqrt(a) * alpha;
	let n: number[], d: number[];
	switch (b.filter) {
		case 'bell':
			n = [1 + alpha * a, -2 * c, 1 - alpha * a];
			d = [1 + alpha / a, -2 * c, 1 - alpha / a];
			break;
		case 'lowCut':
			n = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
			d = [1 + alpha, -2 * c, 1 - alpha];
			break;
		case 'highCut':
			n = [(1 - c) / 2, 1 - c, (1 - c) / 2];
			d = [1 + alpha, -2 * c, 1 - alpha];
			break;
		case 'lowShelf':
			n = [a * (a + 1 - (a - 1) * c + beta), 2 * a * (a - 1 - (a + 1) * c), a * (a + 1 - (a - 1) * c - beta)];
			d = [a + 1 + (a - 1) * c + beta, -2 * (a - 1 + (a + 1) * c), a + 1 + (a - 1) * c - beta];
			break;
		case 'highShelf':
			n = [a * (a + 1 + (a - 1) * c + beta), -2 * a * (a - 1 + (a + 1) * c), a * (a + 1 + (a - 1) * c - beta)];
			d = [a + 1 - (a - 1) * c + beta, 2 * (a - 1 - (a + 1) * c), a + 1 - (a - 1) * c - beta];
			break;
	}
	return [n[0] / d[0], n[1] / d[0], n[2] / d[0], d[1] / d[0], d[2] / d[0]];
}

type Complex = [number, number];
const multiply = ([a, b]: Complex, [c, d]: Complex): Complex => [a * c - b * d, a * d + b * c];
function response([b0, b1, b2, a1, a2]: Coefficients, w: number): Complex {
	const c = Math.cos(w),
		s = -Math.sin(w),
		c2 = Math.cos(2 * w),
		s2 = -Math.sin(2 * w);
	const nr = b0 + b1 * c + b2 * c2,
		ni = b1 * s + b2 * s2,
		dr = 1 + a1 * c + a2 * c2,
		di = a1 * s + a2 * s2,
		den = dr * dr + di * di;
	return [(nr * dr + ni * di) / den, (ni * dr - nr * di) / den];
}

/** Reproduce the legacy f32 coefficients, then sum complex LR4 branches (including phase). */
export function graphicCoefficients(fc: number, sr: number, high: boolean): Coefficients {
	const f = Math.fround;
	const w = f(f(2 * f(Math.PI)) * f(f(fc) / sr));
	const c = f(Math.cos(w)),
		alpha = f(f(Math.sin(w)) / f(2 * f(Math.SQRT1_2))),
		inv = f(1 / f(1 + alpha));
	const b1 = high ? -f(1 + c) : f(1 - c),
		b0 = f(Math.abs(b1) * 0.5);
	return [f(b0 * inv), f(b1 * inv), f(b0 * inv), f(f(-2 * c) * inv), f(f(1 - alpha) * inv)];
}

export function responseDb(data: EqData, frequency: number, sr: number): number {
	if (data.bypassed) return 0;
	const w = (2 * Math.PI * frequency) / sr;
	let total: Complex = [1, 0];
	if (data.mode === 'parametric') {
		for (const band of data.bands) total = multiply(total, response(coefficients(band, sr), w));
	} else {
		let residual: Complex = [1, 0];
		total = [0, 0];
		for (let i = 0; i < 10; i++) {
			let branch = residual;
			if (i < 9) {
				const lp = response(graphicCoefficients(CROSSOVERS[i], sr, false), w);
				const hp = response(graphicCoefficients(CROSSOVERS[i], sr, true), w);
				branch = multiply(residual, multiply(lp, lp));
				residual = multiply(residual, multiply(hp, hp));
			}
			const gain = 10 ** (data.gainsDb[i] / 20);
			total = [total[0] + branch[0] * gain, total[1] + branch[1] * gain];
		}
	}
	return 20 * Math.log10(Math.max(1e-12, Math.hypot(...total)));
}
