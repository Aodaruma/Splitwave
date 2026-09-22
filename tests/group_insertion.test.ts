import { describe, expect, it } from 'bun:test';
import type { Node } from '@xyflow/svelte';
import type { AudioPorts } from '../src/lib/modules/flow/utils/auto_connect';
import { insertionHandles, planWireInsertion, saveWireInsertion } from '../src/lib/modules/flow/utils/insertion';
import { BOUNDARY_INPUT, BOUNDARY_OUTPUT, groupView } from '../src/lib/modules/flow/utils/group_view';
import { documentFor, expand, groupSelection, scopeAt } from '../src/lib/modules/pipeline/groups';
import type { Pipeline } from '../src/lib/modules/pipeline/types';

const ports = (id: string): AudioPorts => ({ id, handles: [], channels: { max: Infinity, min: 0, selfGrowing: false } });
const effect: Node = { id: 'inserted', type: 'gain', position: { x: 50, y: 60 }, data: { gainDb: 0, bypassed: false } };
const fixture = (): Pipeline => ({
	id: 'pipeline',
	name: 'Insertion',
	createdAt: 1,
	updatedAt: 1,
	nodes: ['source', 'inside', 'target'].map((id) => ({ id, kind: 'gain', position: { x: 0, y: 0 }, data: { gainDb: 0, bypassed: false } })),
	edges: [
		{ id: 'a', source: 'source', sourceHandle: 'ch1', target: 'inside', targetHandle: 'ch2' },
		{ id: 'b', source: 'source', sourceHandle: 'ch2', target: 'inside', targetHandle: 'ch1' },
		{ id: 'c', source: 'inside', sourceHandle: 'ch1', target: 'target', targetHandle: 'ch1' },
		{ id: 'd', source: 'inside', sourceHandle: 'ch2', target: 'target', targetHandle: 'ch2' }
	]
});

describe('insertion through group interfaces', () => {
	for (const side of ['inputs', 'outputs'] as const) {
		it(`inserts a newly dropped effect at ${side}, preserving outside sockets, crossed stereo and a shared instance`, () => {
			const doc = documentFor(fixture());
			const group = groupSelection(doc, [], ['inside']);
			const path = [group],
				d = scopeAt(doc, path);
			const outside = structuredClone(scopeAt(doc, []).edges);
			const previousPorts = structuredClone(d[side]);
			scopeAt(doc, []).nodes.push({ id: 'shared', kind: 'group', position: { x: 0, y: 300 }, data: { definition: d.id } });
			const view = groupView(doc, path);
			view.nodes.push(structuredClone(effect));
			const boundary = side === 'inputs' ? BOUNDARY_INPUT : BOUNDARY_OUTPUT;
			const hit = view.edges.find((e) => (side === 'inputs' ? e.source === boundary : e.target === boundary))!;
			const plan = planWireInsertion(
				effect,
				'effect',
				ports(effect.id),
				ports(effect.id),
				view.nodes,
				view.edges,
				[hit.id],
				insertionHandles(doc, path)
			)!;
			expect(plan.connections).toHaveLength(2);
			const next = saveWireInsertion(doc, path, view.nodes, view.edges, effect.id, plan, ['new-a', 'new-b']);
			expect(d[side].map((p) => [p.id, p.label])).toEqual(previousPorts.map((p) => [p.id, p.label]));
			expect(scopeAt(doc, []).edges).toEqual(outside);
			expect(d.edges).toHaveLength(2);
			expect(next.filter((e) => e.source === boundary || e.target === boundary)).toHaveLength(2);
			const loaded = JSON.parse(JSON.stringify(doc));
			const roundTrip = groupView(loaded, path);
			for (const e of next) expect(roundTrip.edges).toContainEqual(e);
			const runtime = expand(loaded);
			// Both linked instances include the inserted effect; the outside cross-channel route is unchanged.
			expect(runtime.nodes).toHaveLength(6);
			const route = runtime.edges.find((e) => e.source === 'source' && e.sourceHandle === 'ch1')!;
			if (side === 'inputs') {
				expect(route.target).toBe('inserted');
				expect(route.targetHandle).toBe('ch2');
				expect(runtime.edges).toContainEqual(
					expect.objectContaining({ source: 'inserted', sourceHandle: 'ch2', target: 'inside', targetHandle: 'ch2' })
				);
			} else {
				expect(route.target).toBe('inside');
				expect(runtime.edges).toContainEqual(
					expect.objectContaining({ source: 'inside', sourceHandle: 'ch1', target: 'inserted', targetHandle: 'ch1' })
				);
			}
		});
	}

	it('resolves channels across nested group instances without changing their stable port IDs', () => {
		const doc = documentFor(fixture());
		const inner = groupSelection(doc, [], ['inside']);
		const outer = groupSelection(doc, [], [inner]);
		const view = groupView(doc, []);
		view.nodes.push(structuredClone(effect));
		const hit = view.edges.find((e) => e.target === outer)!;
		const plan = planWireInsertion(effect, 'effect', ports(effect.id), ports(effect.id), view.nodes, view.edges, [hit.id], insertionHandles(doc, []))!;
		expect(plan.connections).toHaveLength(2);
		const before = structuredClone(scopeAt(doc, [outer]).inputs);
		saveWireInsertion(doc, [], view.nodes, view.edges, effect.id, plan, ['new-a', 'new-b']);
		expect(scopeAt(doc, [outer]).inputs).toEqual(before);
		expect(expand(doc).edges).toContainEqual(expect.objectContaining({ source: 'inserted', sourceHandle: 'ch1', target: 'inside', targetHandle: 'ch2' }));
	});
});
