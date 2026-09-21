import { frequencyPosition } from '$lib/modules/pipeline/eq';

export const FREQUENCY_LABELS = [20, 30, 40, 50, 60, 80, 100, 200, 300, 400, 500, 800, 1000, 2000, 3000, 4000, 6000, 8000, 10000, 20000];
export const frequencyLabel = (hz: number) => (hz >= 1000 ? `${Number((hz / 1000).toFixed(2))}k` : String(Math.round(hz)));
export const majorFrequency = (hz: number) => [20, 100, 1000, 10000, 20000].includes(hz);

export function frequencyTicks(max: number): number[] {
	return [10, 100, 1000, 10000].flatMap((decade) => Array.from({ length: 9 }, (_, i) => decade * (i + 1))).filter((hz) => hz >= 20 && hz <= max);
}

export function frequencyLabels(max: number, width: number) {
	const candidates = [...new Set([...FREQUENCY_LABELS.filter((hz) => hz <= max), max])];
	const selected: { frequency: number; label: string; position: number; left: number; right: number }[] = [];
	const priority = (hz: number) => (hz === 20 || hz === max ? 2 : majorFrequency(hz) ? 1 : 0);
	// Reserve endpoints and decades first; the remaining labels fill available space.
	for (const frequency of candidates.sort((a, b) => priority(b) - priority(a))) {
		const label = frequencyLabel(frequency);
		const position = frequencyPosition(frequency, max);
		const size = label.length * 6.5;
		const left = position * width - (frequency === 20 ? 0 : frequency === max ? size : size / 2);
		const right = left + size;
		if (selected.every((other) => right + 5 <= other.left || left >= other.right + 5)) selected.push({ frequency, label, position, left, right });
	}
	return selected.sort((a, b) => a.frequency - b.frequency);
}

type GuideRange = { label: string; short: string; low: number; high: number };
export type EqGuide = 'default' | 'voice';

// Approximate listening guides, not filter bands or engine parameters.
export const EQ_GUIDES: Record<EqGuide, GuideRange[]> = {
	default: [
		{ label: 'Sub bass', short: 'Sub', low: 20, high: 60 },
		{ label: 'Bass', short: 'Bass', low: 60, high: 250 },
		{ label: 'Low mids', short: 'Low mid', low: 250, high: 500 },
		{ label: 'Mid range', short: 'Mids', low: 500, high: 2000 },
		{ label: 'Upper mids', short: 'Upper mid', low: 2000, high: 6000 },
		{ label: 'Highs', short: 'Highs', low: 6000, high: 20000 }
	],
	voice: [
		{ label: 'Low end rumbles', short: 'Rumble', low: 20, high: 100 },
		{ label: 'Core voice', short: 'Voice', low: 100, high: 400 },
		{ label: 'Box', short: 'Box', low: 400, high: 800 },
		{ label: 'Mid range', short: 'Mids', low: 800, high: 4000 },
		{ label: 'Sibilance', short: 'Sibil.', low: 4000, high: 8000 },
		{ label: 'Air', short: 'Air', low: 8000, high: 20000 }
	]
};

export function guideSegments(guide: EqGuide, max: number, width: number) {
	return EQ_GUIDES[guide]
		.filter((range) => range.low < max)
		.map((range) => {
			const start = frequencyPosition(range.low, max);
			const end = frequencyPosition(range.high, max);
			return {
				...range,
				start,
				end,
				text: [range.label, range.short].find((text) => (end - start) * width >= text.length * 6.5 + 8) ?? '',
				title: `${range.label} · ${range.low.toLocaleString('en-US')}–${range.high.toLocaleString('en-US')} Hz (approximate guide)`
			};
		});
}
