import { describe, expect, test } from 'bun:test';
import { frequencyPosition, maxFrequency, defaultEq, responseDb, readEq } from '../src/lib/modules/pipeline/eq';
import { EQ_GUIDES, FREQUENCY_LABELS, frequencyLabels, frequencyTicks, guideSegments } from '../src/lib/modules/flow/ui/effect/_eq_display';
import { documentFor, groupSelection, materialize, copyDefinition, expand } from '../src/lib/modules/pipeline/groups';
import { groupView, saveGroupView } from '../src/lib/modules/flow/utils/group_view';
import { copyGraph, pasteGraph } from '../src/lib/modules/flow/utils/clipboard';
import { createHistoryRestorer } from '../src/lib/modules/flow/utils/history_restore';
import { migrate } from '../src/lib/modules/pipeline/migrations';
import type { EqNodeData, Pipeline } from '../src/lib/modules/pipeline/types';

const pipeline = (data: Partial<EqNodeData>): Pipeline => ({
	id: 'eq-test',
	name: 'EQ',
	createdAt: 1,
	updatedAt: 1,
	version: 2,
	nodes: [{ id: 'eq', kind: 'eq', position: { x: 0, y: 0 }, data: data as EqNodeData }],
	edges: []
});

describe('EQ compatibility through existing persistence paths', () => {
	const arbitrary = readEq({ mode: 'parametric' });
	arbitrary.bands.forEach((band, i) =>
		Object.assign(band, {
			filter: ['highCut', 'lowShelf', 'highShelf', 'lowCut', 'bell'][i % 5],
			frequency: 33.25 * (i + 1) ** 3,
			gainDb: i - 4.125,
			q: 0.2 + i / 2,
			enabled: i % 3 !== 0
		})
	);
	const examples = [{ gainsDb: [-18, -9, 0, -2, -1, 0, 3, 2, 1, 0] }, { mode: 'parametric', bypassed: true }, arbitrary] as Partial<EqNodeData>[];

	for (const [index, example] of examples.entries()) {
		test(`legacy data ${index + 1} survives import, nested groups, copy, initialization, undo and redo`, async () => {
			const saved = { ...example, eqGuide: 'voice' };
			const expected = readEq(saved);
			const p = migrate(JSON.parse(JSON.stringify(pipeline(saved))));
			const doc = documentFor(p);
			const groupId = groupSelection(doc, [], ['eq']);
			const view = groupView(doc, [groupId]);
			expect(view.nodes[0].data).toEqual(expected);
			saveGroupView(doc, [groupId], view.nodes, view.edges);
			const before = materialize(p, structuredClone(doc));
			expect(before.nodes[0].data).toEqual(expected);
			const clone = copyDefinition(doc, doc.root);
			expect(expand({ ...doc, root: clone }).nodes[0].data).toEqual(expected);
			const clipboard = copyGraph(view.nodes, view.edges)!;
			const pasted = pasteGraph(clipboard, { x: 20, y: 30 }, ['copy'], []);
			expect(pasted.nodes[0].data).toEqual(expected);
			(pasted.nodes[0].data as EqNodeData).bands[0].frequency = 321;
			expect(view.nodes[0].data).toEqual(expected);
			view.nodes[0].data = { ...view.nodes[0].data, ...defaultEq() };
			saveGroupView(doc, [groupId], view.nodes, view.edges);
			const after = materialize(p, doc);
			const history = [before, after];
			let cursor = 1;
			let restored = after;
			const move = createHistoryRestorer({
				flush: () => {},
				current: () => ({ history, cursor }),
				restore: async (snapshot) => {
					restored = JSON.parse(JSON.stringify(snapshot));
					return true;
				},
				setCursor: (value) => {
					cursor = value;
				}
			});
			await move(-1);
			expect(groupView(documentFor(restored), [groupId]).nodes[0].data).toEqual(expected);
			await move(1);
			expect(groupView(documentFor(restored), [groupId]).nodes[0].data).toEqual({ ...defaultEq(), eqGuide: 'voice' });
		});
	}
});

describe('EQ frequency grid and explanatory guides', () => {
	test('every decade contains minor ticks 2 through 9, clipped at sample-rate limits', () => {
		const ticks = frequencyTicks(20000);
		for (const decade of [10, 100, 1000]) for (let n = 2; n <= 9; n++) expect(ticks).toContain(n * decade);
		expect(frequencyPosition(300, 20000) - frequencyPosition(200, 20000)).toBeGreaterThan(frequencyPosition(900, 20000) - frequencyPosition(800, 20000));
		for (const sr of [8000, 22050, 44100, 48000]) {
			const max = maxFrequency(sr);
			expect(frequencyTicks(max).every((f) => f >= 20 && f <= max)).toBe(true);
		}
	});
	test('detailed labels adapt to width, retain endpoints and never overlap', () => {
		expect(frequencyLabels(20000, 2000).map((tick) => tick.frequency)).toEqual(FREQUENCY_LABELS);
		for (const width of [160, 280, 418, 538, 600])
			for (const max of [3920, 7840, 10804.5, 20000]) {
				const labels = frequencyLabels(max, width);
				expect(labels[0].frequency).toBe(20);
				expect(labels.at(-1)!.frequency).toBe(max);
				for (const [i, label] of labels.entries()) {
					expect(label.position).toBe(frequencyPosition(label.frequency, max));
					expect(label.left).toBeGreaterThanOrEqual(-0.000001);
					expect(label.right).toBeLessThanOrEqual(width + 0.000001);
					if (i) expect(label.left - labels[i - 1].right).toBeGreaterThanOrEqual(4.999999);
				}
			}
	});
	test('guide boundaries share log positions; narrow segments hide text but retain full titles', () => {
		expect(EQ_GUIDES.default.map(({ low, high }) => [low, high])).toEqual([
			[20, 60],
			[60, 250],
			[250, 500],
			[500, 2000],
			[2000, 6000],
			[6000, 20000]
		]);
		expect(EQ_GUIDES.voice.map(({ low, high }) => [low, high])).toEqual([
			[20, 100],
			[100, 400],
			[400, 800],
			[800, 4000],
			[4000, 8000],
			[8000, 20000]
		]);
		for (const guide of ['default', 'voice'] as const)
			for (const max of [3920, 7840, 8050, 20000])
				for (const width of [160, 538]) {
					const segments = guideSegments(guide, max, width);
					expect(segments[0].start).toBe(0);
					expect(segments.at(-1)!.end).toBe(1);
					for (const [i, segment] of segments.entries()) {
						expect(segment.start).toBe(frequencyPosition(segment.low, max));
						expect(segment.end).toBe(frequencyPosition(segment.high, max));
						expect(segment.end).toBeGreaterThan(segment.start);
						expect(segment.title).toContain(segment.label);
						expect(segment.title).toContain('Hz (approximate guide)');
						if (i) expect(segment.start).toBe(segments[i - 1].end);
						if (segment.text) expect(segment.text.length * 6.5 + 8).toBeLessThanOrEqual((segment.end - segment.start) * width);
					}
				}
		expect(guideSegments('voice', 20000, 538).every((segment) => segment.text.length)).toBe(true);
		expect(guideSegments('voice', 8050, 538).at(-1)!.text).toBe('');
	});
	test('display guides leave arbitrary EQ responses identical', () => {
		const eq = readEq({ mode: 'parametric' });
		eq.bands[2].gainDb = 8;
		for (const eqGuide of ['default', 'voice']) {
			const shown = readEq({ ...eq, eqGuide } as EqNodeData);
			for (const hz of [20, 250, 1000, 5000, 20000]) expect(responseDb(shown, hz, 48000)).toBe(responseDb(eq, hz, 48000));
		}
	});
});
