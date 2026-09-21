import { describe, expect, it } from 'bun:test';
import type { Edge, Node } from '@xyflow/svelte';
import { alignNodes, insertReroute, planBulkBypass, reroutePath, withReroutePoints } from '../src/lib/modules/flow/utils/layout';
import { applyWireInsertion, planWireInsertion, wireHitsBounds } from '../src/lib/modules/flow/utils/insertion';
import { copyGraph, pasteGraph } from '../src/lib/modules/flow/utils/clipboard';
import { createHistoryRestorer } from '../src/lib/modules/flow/utils/history_restore';
import { canvasShortcut } from '../src/lib/modules/flow/utils/shortcuts';
import { groupView, saveGroupView } from '../src/lib/modules/flow/utils/group_view';
import { copyDefinition, definition, documentFor, expand, groupSelection, materialize, scopeAt, ungroup } from '../src/lib/modules/pipeline/groups';
import { saveToLibrary } from '../src/lib/modules/pipeline/group_library';
import type { Pipeline, PipelineEdge } from '../src/lib/modules/pipeline/types';
import type { AudioPorts } from '../src/lib/modules/flow/utils/auto_connect';

const node = (id: string, x = 0, y = 0, width = 100, height = 50, type = 'gain'): Node => ({
	id,
	type,
	position: { x, y },
	measured: { width, height },
	data: {},
	selected: true
});
const edge = (id: string, source = 'source', target = 'target', sourceHandle = 'ch1', targetHandle = sourceHandle): PipelineEdge => ({
	id,
	source,
	target,
	sourceHandle,
	targetHandle
});
const ports = (id: string, max = Infinity): AudioPorts => ({ id, handles: [], channels: { max, min: 0, selfGrowing: false } });
const effect = node('effect');
const nodes = [node('source'), effect, node('target'), node('fanout'), node('other')];
const insert = (edges: Edge[], hits = ['L'], max = Infinity) =>
	planWireInsertion(effect, 'effect', ports('effect', max), ports('effect', max), nodes, edges, hits);

function pipeline(): Pipeline {
	return {
		id: 'p',
		name: 'Points',
		createdAt: 1,
		updatedAt: 1,
		nodes: [
			{ id: 'source', kind: 'gain', data: { gainDb: 0, bypassed: false }, position: { x: 20, y: 30 } },
			{ id: 'target', kind: 'gain', data: { gainDb: 0, bypassed: false }, position: { x: 400, y: 60 } },
			{ id: 'outside', kind: 'gain', data: { gainDb: 0, bypassed: false }, position: { x: 800, y: 90 } }
		],
		edges: [
			{
				...edge('L', 'source', 'target', 'L', 'ch2'),
				data: {
					reroutes: [
						{ x: 250, y: -50 },
						{ x: 350, y: 110 }
					]
				}
			},
			{ ...edge('R', 'source', 'target', 'R', 'ch1'), data: { reroutes: [{ x: 260, y: -40 }] } },
			{ ...edge('out', 'target', 'outside'), data: { reroutes: [{ x: 620, y: 200 }] } },
			{ ...edge('fanin', 'outside', 'target', 'ch2', 'ch1'), data: { reroutes: [{ x: 720, y: 210 }] } }
		]
	};
}

describe('measured selection alignment', () => {
	it('preserves bounds center, equal free space, stable order and routing with unequal sizes', () => {
		const selected = [node('c', 800, 20, 100, 120), node('a', 0, 40, 200, 50), node('b', 310, -20, 70, 40, 'group')];
		const original = structuredClone(selected);
		const aligned = alignNodes(selected);
		expect([...aligned.keys()]).toEqual(['a', 'b', 'c']);
		expect(aligned.get('a')!.x).toBe(0);
		expect(aligned.get('c')!.x + 100).toBe(900);
		expect(aligned.get('b')!.x - aligned.get('a')!.x - 200).toBe(aligned.get('c')!.x - aligned.get('b')!.x - 70);
		for (const n of selected) expect(aligned.get(n.id)!.y + n.measured!.height! / 2).toBe(60);
		expect(selected).toEqual(original);
	});

	it('expands overlaps symmetrically and excludes boundaries, locked and unselected nodes', () => {
		const selected = [
			node('a', 0, 0, 100, 60),
			node('b', 0, 10, 200, 100),
			{ ...node('boundary', -1000, -1000, 2000, 2000, 'groupBoundary') },
			{ ...node('locked'), draggable: false },
			{ ...node('unselected'), selected: false }
		];
		const aligned = alignNodes(selected, 'vertical');
		expect([...aligned.keys()]).toEqual(['a', 'b']);
		expect(aligned.get('b')!.y - aligned.get('a')!.y - 60).toBe(24);
		expect((aligned.get('a')!.y + aligned.get('b')!.y + 100) / 2).toBe(55);
		expect(aligned.get('a')!.x + 50).toBe(100);
		expect(aligned.get('b')!.x + 100).toBe(100);
	});

	it('chooses vertical for tall arrangements and refuses incomplete measurements', () => {
		const selected = [node('z', 0, 600), node('a')];
		expect(alignNodes(selected)).toEqual(alignNodes(selected, 'vertical'));
		expect([...alignNodes([node('z'), node('a')]).keys()]).toEqual(['a', 'z']);
		expect(alignNodes([node('a'), { ...node('b'), measured: undefined }]).size).toBe(0);
	});
});

describe('wire insertion planning', () => {
	it('inserts a crossed stereo mapping as a unit, keeps IDs, target handles, fanout, fan-in and layout', () => {
		const edges = [
			edge('L', 'source', 'target', 'L', 'ch2'),
			edge('R', 'source', 'target', 'R', 'ch1'),
			edge('fan', 'source', 'fanout', 'L'),
			edge('other-feed', 'other', 'target', 'ch4', 'ch1')
		];
		edges[0].data = { reroutes: [{ x: 70, y: 90 }] };
		const original = structuredClone(edges);
		const plan = insert(edges)!;
		expect(plan.bundle.map((e) => e.id)).toEqual(['L', 'R']);
		const after = applyWireInsertion(edges, 'effect', plan, ['new-L', 'new-R']);
		expect(after).toContainEqual({ ...edge('new-L', 'source', 'effect', 'L', 'ch1'), type: 'channel' });
		expect(after).toContainEqual({ ...edges[0], source: 'effect', sourceHandle: 'ch1' });
		expect(after).toContainEqual({ ...edges[1], source: 'effect', sourceHandle: 'ch2' });
		expect(after.find((e) => e.id === 'fan')).toBe(edges[2]);
		expect(after.find((e) => e.id === 'other-feed')).toBe(edges[3]);
		expect(edges).toEqual(original);
	});

	it('requires whole-bundle capacity and rejects ambiguous overlaps and existing effect wiring', () => {
		const stereo = [edge('L'), edge('R', 'source', 'target', 'ch2')];
		expect(insert(stereo, ['L'], 1)).toBeNull();
		expect(insert(stereo, ['L'], 2)).not.toBeNull();
		expect(insert([...stereo, edge('crossing', 'other', 'target')], ['L', 'crossing'])).toBeNull();
		for (const wired of [edge('in', 'other', 'effect'), edge('out', 'effect', 'fanout')]) expect(insert([...stereo, wired])).toBeNull();
		expect(insert([...stereo, edge('duplicate', 'source', 'target', 'ch1', 'ch2')])).toBeNull();
	});

	it('refuses cycles, exposed mappings, buses, sidechains, plugins and asymmetric I/O', () => {
		expect(insert([edge('L'), edge('back', 'target', 'source')])).toBeNull();
		for (const role of ['main', 'mixed', 'sidechain', 'peer:test']) expect(insert([edge('L', 'source', 'target', role)])).toBeNull();
		expect(insert([{ ...edge('L'), deletable: false }])).toBeNull();
		for (const type of ['group', 'groupBoundary'])
			expect(
				planWireInsertion(
					effect,
					'effect',
					ports('effect'),
					ports('effect'),
					nodes.map((n) => (n.id === 'source' ? { ...n, type } : n)),
					[edge('L')],
					['L']
				)
			).toBeNull();
		expect(planWireInsertion({ ...effect, type: 'plugin' }, 'effect', ports('effect'), ports('effect'), nodes, [edge('L')], ['L'])).toBeNull();
		expect(planWireInsertion(effect, 'monitor', ports('effect'), ports('effect'), nodes, [edge('L')], ['L'])).toBeNull();
		expect(planWireInsertion(effect, 'effect', ports('effect', 2), ports('effect', 1), nodes, [edge('L')], ['L'])).toBeNull();
		expect(
			planWireInsertion(effect, 'effect', { ...ports('effect'), handles: [{ id: 'sidechain', y: 10 }] }, ports('effect'), nodes, [edge('L')], ['L'])
		).toBeNull();
	});

	it('hit tests the rendered polyline against bounds, including between sparse samples', () => {
		const bounds = { x: 50, y: 60, width: 30, height: 40 };
		expect(
			wireHitsBounds(
				[
					{ x: 0, y: 0 },
					{ x: 65, y: 80 },
					{ x: 100, y: 0 }
				],
				bounds
			)
		).toBe(true);
		expect(
			wireHitsBounds(
				[
					{ x: 0, y: 80 },
					{ x: 200, y: 80 }
				],
				bounds
			)
		).toBe(true);
		expect(
			wireHitsBounds(
				[
					{ x: 0, y: 0 },
					{ x: 200, y: 0 }
				],
				bounds
			)
		).toBe(false);
	});
});

describe('editable cable points', () => {
	it('adds on the nearest segment of a backtracking path and renders through every point', () => {
		const source = { x: 0, y: 0 },
			target = { x: 100, y: 0 };
		const points = [
			{ x: 80, y: 40 },
			{ x: 20, y: 40 }
		];
		const added = insertReroute(source, target, points, { x: 50, y: 42 });
		expect(added).toEqual([points[0], { x: 50, y: 42 }, points[1]]);
		expect(reroutePath(source, target, added)).toBe('M 0,0 L 80,40 L 50,42 L 20,40 L 100,0');
		expect(points).toHaveLength(2);
	});

	it('preserves every edge and handle on copy/paste, translating points relative to the new origin', () => {
		const p = pipeline();
		const doc = documentFor(p),
			view = groupView(doc, []);
		const copy = copyGraph(view.nodes, view.edges)!;
		const pasted = pasteGraph(copy, { x: 120, y: 230 }, ['s2', 't2', 'o2'], ['l2', 'r2', 'out2', 'fanin2']);
		expect(pasted.edges).toHaveLength(4);
		expect(pasted.edges[0].data?.reroutes).toEqual([
			{ x: 350, y: 150 },
			{ x: 450, y: 310 }
		]);
		expect(pasted.edges[0].sourceHandle).toBe('L');
		expect(pasted.edges[0].targetHandle).toBe('ch2');
		expect(pasted.edges[1].targetHandle).toBe('ch1');
		expect(pasted.edges[3].targetHandle).toBe('ch1');
		(pasted.edges[0].data!.reroutes as { x: number }[])[0].x = 999;
		expect(p.edges[0].data!.reroutes![0].x).toBe(250);
	});

	it('keeps scoped coordinates through grouping, nested view, independent reuse, ungroup and JSON import', () => {
		const original = pipeline(),
			doc = documentFor(original);
		const runtime = expand(doc);
		const instance = groupSelection(doc, [], ['source', 'target']);
		const inner = scopeAt(doc, [instance]);
		expect(inner.edges[0].data?.reroutes).toEqual([
			{ x: 330, y: 20 },
			{ x: 430, y: 180 }
		]);
		const view = groupView(doc, [instance]);
		const boundary = view.edges.find((e) => e.deletable === false)!;
		expect(boundary.data).toBeUndefined();
		expect(view.edges.find((e) => e.id === 'L')!.data?.reroutes).toEqual(inner.edges[0].data!.reroutes);
		saveGroupView(doc, [instance], view.nodes, view.edges);
		const copy = definition(doc, copyDefinition(doc, inner.id));
		expect(copy.edges).toEqual(inner.edges);
		copy.edges[0].data!.reroutes![0].x = 999;
		expect(inner.edges[0].data!.reroutes![0].x).toBe(330);
		expect(expand(doc).edges).toEqual(runtime.edges);
		ungroup(doc, [], instance);
		const flat = scopeAt(doc, []);
		expect(flat.edges.find((e) => e.sourceHandle === 'L')!.data?.reroutes).toEqual(original.edges[0].data!.reroutes);
		expect(flat.edges.find((e) => e.id === 'out')!.data).toEqual(original.edges[2].data);
		expect(flat.edges.find((e) => e.id === 'fanin')!.data).toEqual(original.edges[3].data);
		const loaded = materialize(JSON.parse(JSON.stringify(materialize(original, doc))));
		expect(loaded.groups!.definitions[doc.root].edges).toEqual(JSON.parse(JSON.stringify(flat.edges)));
		expect(loaded.edges).toHaveLength(4);
		expect(loaded.edges.every((e) => e.data === undefined)).toBe(true);
	});

	it('saves/removes points without changing runtime routing or another snapshot and survives library saving', () => {
		const initial = materialize(pipeline());
		const doc = documentFor(initial);
		const view = groupView(doc, []);
		view.edges[0].data = { reroutes: [{ x: 777, y: 888 }] };
		saveGroupView(doc, [], view.nodes, view.edges);
		const after = materialize(initial, doc);
		expect(after.edges).toEqual(initial.edges);
		expect(initial.groups!.definitions[doc.root].edges[0].data!.reroutes![0].x).toBe(250);
		let library = saveToLibrary({ version: 3, pipelines: {}, definitions: {} }, initial);
		library = saveToLibrary(library, {
			...after,
			groups: {
				...doc,
				definitions: { ...doc.definitions, [doc.root]: { ...doc.definitions[doc.root], revision: library.definitions[doc.root].revision } }
			}
		});
		expect(library.definitions[doc.root].edges[0].data!.reroutes).toEqual([{ x: 777, y: 888 }]);
		view.edges[0].data = { reroutes: [] };
		saveGroupView(doc, [], view.nodes, view.edges);
		expect(groupView(doc, []).edges[0].data?.reroutes).toEqual([]);
		expect(expand(doc).edges).toEqual(initial.edges);
	});
});

describe('bulk bypass and scoped shortcuts', () => {
	const registry = {
		gain: { category: 'effect' as const, defaultData: { bypassed: false } },
		plugin: { category: 'effect' as const, defaultData: { bypassed: false } },
		monitor: { category: 'monitor' as const, defaultData: { bypassed: false } },
		unsupported: { category: 'effect' as const, defaultData: {} }
	};
	it('bypasses mixed selection, engages fully bypassed selection, and excludes unsupported roles', () => {
		const selected = [
			node('a'),
			{ ...node('b', 0, 0, 100, 50, 'plugin'), data: { bypassed: true } },
			node('c', 0, 0, 100, 50, 'monitor'),
			node('d', 0, 0, 100, 50, 'unsupported'),
			node('g', 0, 0, 100, 50, 'group'),
			{ ...node('e'), selected: false }
		];
		expect(planBulkBypass(selected, registry)).toEqual([{ id: 'a', bypassed: true }]);
		selected[0].data.bypassed = true;
		expect(planBulkBypass(selected, registry)).toEqual([
			{ id: 'a', bypassed: false },
			{ id: 'b', bypassed: false }
		]);
	});

	it('accepts only unmodified M and Shift+= in canvas scope', () => {
		const key = { key: 'm', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
		expect(canvasShortcut(key, true)).toBe('bypass');
		expect(canvasShortcut(key, false)).toBeNull();
		for (const modifier of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) expect(canvasShortcut({ ...key, [modifier]: true }, true)).toBeNull();
		for (const keyName of ['=', '+']) {
			expect(canvasShortcut({ ...key, key: keyName, shiftKey: true }, true)).toBe('align');
			expect(canvasShortcut({ ...key, key: keyName, shiftKey: true }, false)).toBeNull();
		}
	});
});

describe('snapshot transactions and shared definitions', () => {
	it('cancels cable geometry without restoring disconnected peers or overwriting concurrent routes', () => {
		const points = [{ x: 40, y: 70 }];
		const before: Edge[] = [
			{ id: 'cable', source: 'source', target: 'target', data: { reroutes: points } },
			{ id: 'peer', source: 'webrtc', sourceHandle: 'peer:remote', target: 'target' }
		];
		const moved = withReroutePoints(before, 'cable', [{ x: 80, y: 90 }]);
		const current = moved.filter((edge) => edge.id !== 'peer').map((edge) => ({ ...edge, targetHandle: 'ch2' }));
		current.push({ id: 'new', source: 'source', target: 'other', targetHandle: 'ch1' });
		const restored = withReroutePoints(current, 'cable', points);
		expect(restored.map((edge) => edge.id)).toEqual(['cable', 'new']);
		expect(restored[0].targetHandle).toBe('ch2');
		expect(restored[0].data?.reroutes).toEqual(points);
		expect(restored[1]).toBe(current[1]);
		expect(withReroutePoints([], 'cable', points)).toEqual([]);
	});

	it('one history step restores both insertion wiring and position, including cable points', async () => {
		const initial = pipeline();
		initial.edges = initial.edges.filter((e) => e.id === 'L' || e.id === 'R');
		initial.nodes.push({ id: 'effect', kind: 'gain', data: { gainDb: 0, bypassed: false }, position: { x: 100, y: 500 } });
		const before = materialize(initial),
			doc = documentFor(before),
			view = groupView(doc, []);
		const plan = planWireInsertion(effect, 'effect', ports('effect'), ports('effect'), view.nodes, view.edges, ['L'])!;
		view.nodes.find((n) => n.id === 'effect')!.position = { x: 250, y: 0 };
		saveGroupView(doc, [], view.nodes, applyWireInsertion(view.edges, 'effect', plan, ['input-L', 'input-R']));
		const after = materialize(before, doc),
			history = [before, after];
		let cursor = 1,
			current = after;
		const restore = createHistoryRestorer({
			flush: () => {},
			current: () => ({ history, cursor }),
			setCursor: (value) => {
				cursor = value;
			},
			restore: async (snapshot) => {
				current = materialize(structuredClone(snapshot));
				return true;
			}
		});
		await restore(-1);
		expect(current.nodes.find((n) => n.id === 'effect')!.position).toEqual({ x: 100, y: 500 });
		expect(current.edges).toEqual(before.edges);
		expect(current.groups!.definitions[doc.root].edges).toEqual(before.groups!.definitions[doc.root].edges);
		await restore(1);
		expect(current.edges).toEqual(after.edges);
		expect(current.nodes.find((n) => n.id === 'effect')!.position).toEqual({ x: 250, y: 0 });
	});

	it('applies selected bypass through the shared document to every live instance', () => {
		const initial = pipeline(),
			doc = documentFor(initial);
		const first = groupSelection(doc, [], ['source', 'target']);
		const shared = scopeAt(doc, [first]);
		scopeAt(doc, []).nodes.push({ id: 'linked', kind: 'group', data: { definition: shared.id }, position: { x: 0, y: 600 } });
		const before = materialize(initial, doc);
		const view = groupView(doc, [first]);
		view.nodes.forEach((n) => {
			n.selected = n.type === 'gain';
		});
		const plan = planBulkBypass(view.nodes, { gain: { category: 'effect', defaultData: { bypassed: false } } });
		for (const p of plan) view.nodes.find((n) => n.id === p.id)!.data.bypassed = p.bypassed;
		saveGroupView(doc, [first], view.nodes, view.edges);
		const after = materialize(before, doc);
		expect(after.nodes.filter((n) => n.data.bypassed === true)).toHaveLength(4);
		expect(after.edges).toEqual(before.edges);
		expect(before.nodes.filter((n) => n.data.bypassed === true)).toHaveLength(0);
		const library = saveToLibrary({ version: 3, pipelines: {}, definitions: {} }, after);
		expect(library.pipelines[initial.id].nodes.filter((n) => n.data.bypassed === true)).toHaveLength(4);
	});

	it('translates internal points through two nesting levels and ungrouping without moving outer points', () => {
		const initial = pipeline(),
			doc = documentFor(initial);
		const first = groupSelection(doc, [], ['source', 'target']);
		const second = groupSelection(doc, [], [first]);
		const leaf = scopeAt(doc, [second, first]);
		const view = groupView(doc, [second, first]);
		expect(view.edges.find((e) => e.id === 'L')!.data).toEqual(leaf.edges[0].data);
		saveGroupView(doc, [second, first], view.nodes, view.edges);
		ungroup(doc, [], second);
		const instance = scopeAt(doc, []).nodes.find((n) => n.kind === 'group')!;
		ungroup(doc, [], instance.id);
		expect(scopeAt(doc, []).edges.find((e) => e.sourceHandle === 'L')!.data).toEqual(initial.edges[0].data);
		expect(scopeAt(doc, []).edges.find((e) => e.id === 'out')!.data).toEqual(initial.edges[2].data);
	});
});
