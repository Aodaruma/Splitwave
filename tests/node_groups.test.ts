import { describe, expect, it } from 'bun:test';
import { PIPELINE_VERSION } from '../src/lib/modules/pipeline/version';
import type { Pipeline, PipelineNode } from '../src/lib/modules/pipeline/types';
import {
	assertReusableInstance,
	copyDefinition,
	copyInstanceState,
	definition,
	documentFor,
	expand,
	groupSelection,
	makeIndependent,
	materialize,
	patchRuntimeNode,
	scopeAt,
	ungroup,
	type GroupDocument,
	type GroupNode
} from '../src/lib/modules/pipeline/groups';
import { saveToLibrary, type GroupLibrary } from '../src/lib/modules/pipeline/group_library';
import { groupView, saveGroupView } from '../src/lib/modules/flow/utils/group_view';
import { migrate, isFromFuture } from '../src/lib/modules/pipeline/migrations';
import { planAutoConnect } from '../src/lib/modules/flow/utils/auto_connect';
import { copyGraph, pasteGraph } from '../src/lib/modules/flow/utils/clipboard';

const node = (id: string, kind: PipelineNode['kind'] = 'gain'): PipelineNode => ({
	id,
	kind,
	data: { gainDb: 0, bypassed: false } as PipelineNode['data'],
	position: { x: 100, y: 200 }
});
const pipeline = (id = 'p'): Pipeline => ({
	id,
	name: id,
	version: 2,
	createdAt: 1,
	updatedAt: 2,
	nodes: [node('mic', 'microphone'), node('a'), node('b'), node('rec', 'fileRecording')],
	edges: [
		{ id: 'in', source: 'mic', sourceHandle: 'ch2', target: 'a', targetHandle: 'ch1' },
		{ id: 'internal', source: 'a', sourceHandle: 'ch1', target: 'b', targetHandle: 'sidechain' },
		{ id: 'out', source: 'b', sourceHandle: 'ch1', target: 'rec', targetHandle: 'ch2' },
		{ id: 'fanout', source: 'a', sourceHandle: 'ch1', target: 'rec', targetHandle: 'ch1' }
	]
});
const routing = (g: ReturnType<typeof expand>) => ({
	nodes: g.nodes.map((n) => ({ id: n.id, kind: n.kind, data: n.data })).sort((a, b) => a.id.localeCompare(b.id)),
	edges: [...g.edges].sort((a, b) => a.id.localeCompare(b.id))
});
const empty = (): GroupLibrary => ({ version: 3, pipelines: {}, definitions: {} });
const group = (doc: GroupDocument, id: string): GroupNode => definition(doc, doc.root).nodes.find((n) => n.id === id) as GroupNode;

describe('reusable node groups', () => {
	it('group and ungroup preserve IDs, fan-out, sidechain handles and wiring', () => {
		const doc = documentFor(pipeline());
		const before = routing(expand(doc));
		const id = groupSelection(doc, [], ['a', 'b']);
		expect(routing(expand(doc))).toEqual(before);
		const d = definition(doc, group(doc, id).data.definition);
		expect(d.inputs).toHaveLength(1);
		expect(d.outputs).toHaveLength(2);
		ungroup(doc, [], id);
		expect(routing(expand(doc))).toEqual(before);
	});
	it('nested regrouping preserves stable IDs and parent interface endpoints', () => {
		const doc = documentFor(pipeline());
		const before = routing(expand(doc));
		const outer = groupSelection(doc, [], ['a', 'b']);
		const inner = groupSelection(doc, [outer], ['a']);
		expect(routing(expand(doc))).toEqual(before);
		ungroup(doc, [outer], inner);
		expect(routing(expand(doc))).toEqual(before);
		ungroup(doc, [], outer);
		expect(routing(expand(doc))).toEqual(before);
	});
	it('copy, linked duplicate and Make Independent have separate runtime IDs', () => {
		const doc = documentFor(pipeline());
		const first = groupSelection(doc, [], ['a', 'b']);
		const original = group(doc, first);
		definition(doc, doc.root).nodes.push(
			{ ...structuredClone(original), id: 'linked', identity: undefined },
			{ ...structuredClone(original), id: 'copy', identity: undefined, data: { definition: copyDefinition(doc, original.data.definition) } }
		);
		const before = expand(doc);
		expect(new Set(before.nodes.map((n) => n.id)).size).toBe(before.nodes.length);
		(definition(doc, original.data.definition).nodes[0].data as Record<string, unknown>).gainDb = 12;
		expect(expand(doc).nodes.filter((n) => n.data.gainDb === 12)).toHaveLength(2);
		makeIndependent(doc, [], 'linked');
		expect(expand(doc).nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
		(definition(doc, original.data.definition).nodes[0].data as Record<string, unknown>).gainDb = 24;
		expect(expand(doc).nodes.filter((n) => n.data.gainDb === 24)).toHaveLength(1);
	});
	it('navigation edits always materialize the complete graph', () => {
		const p = pipeline();
		const doc = documentFor(p);
		const id = groupSelection(doc, [], ['a', 'b']);
		const view = groupView(doc, [id]);
		view.nodes.find((n) => n.id === 'a')!.data.gainDb = 9;
		saveGroupView(doc, [id], view.nodes, view.edges);
		const full = materialize(p, doc);
		expect(full.nodes).toHaveLength(4);
		expect(full.edges).toHaveLength(4);
		expect(full.nodes.find((n) => n.id === 'a')!.data.gainDb).toBe(9);
		expect(full.nodes.some((n) => n.kind === 'microphone')).toBe(true);
		expect(full.nodes.some((n) => n.kind === 'fileRecording')).toBe(true);
	});
	it('rejects missing definitions, indirect cycles and removed connected ports', () => {
		const doc = documentFor(pipeline());
		const id = groupSelection(doc, [], ['a']);
		const inner = definition(doc, group(doc, id).data.definition);
		const original = structuredClone(doc);
		inner.inputs = [];
		expect(() => expand(doc)).toThrow('Missing input port');
		const cycle = structuredClone(original);
		definition(cycle, inner.id).nodes.push({ id: 'cycle', kind: 'group', position: { x: 0, y: 0 }, data: { definition: doc.root } });
		expect(() => expand(cycle)).toThrow('cycle');
		delete original.definitions[inner.id];
		expect(() => expand(original)).toThrow('Missing reusable group');
	});
	it('keeps port IDs through rename and reordering', () => {
		const doc = documentFor(pipeline());
		const id = groupSelection(doc, [], ['a', 'b']);
		const before = routing(expand(doc));
		const inner = definition(doc, group(doc, id).data.definition);
		inner.outputs.reverse();
		inner.outputs[0].label = 'Voice';
		expect(routing(expand(doc))).toEqual(before);
	});
	it('round-trips legacy v2, nested documents and duplicates without losing data', () => {
		const p = migrate(pipeline());
		expect(p.version).toBe(PIPELINE_VERSION);
		expect(isFromFuture({ ...p, version: PIPELINE_VERSION + 1 })).toBe(true);
		const doc = documentFor(p);
		const id = groupSelection(doc, [], ['a', 'b']);
		groupSelection(doc, [id], ['a']);
		const saved = materialize(p, doc);
		expect(materialize(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
		expect(materialize(migrate(pipeline())).nodes).toEqual(pipeline().nodes);
	});
	it('atomically updates shared uses, including other pipelines, and rejects stale Undo', () => {
		let lib = saveToLibrary(empty(), pipeline());
		const first = lib.pipelines.p;
		const source = first.groups!;
		const second = { ...pipeline('q'), nodes: [], edges: [] };
		const doc = documentFor(second);
		Object.assign(doc.definitions, structuredClone(source.definitions));
		definition(doc, doc.root).nodes.push({ id: 'ref', kind: 'group', data: { definition: source.root }, position: { x: 0, y: 0 } });
		lib = saveToLibrary(lib, materialize(second, doc));
		const stale = structuredClone(lib.pipelines.q);
		const otherIds = lib.pipelines.q.nodes.map((n) => n.id);
		const edit = documentFor(lib.pipelines.p);
		groupSelection(edit, [], ['a', 'b']);
		lib = saveToLibrary(lib, materialize(lib.pipelines.p, edit));
		expect(lib.pipelines.q.nodes.map((n) => n.id).sort()).toEqual(otherIds.sort());
		expect(() => saveToLibrary(lib, stale)).toThrow('edited elsewhere');
		const current = lib.pipelines.q;
		const patched = patchRuntimeNode(current, current.nodes.find((n) => n.kind === 'gain')!.id, { gainDb: 18 });
		lib = saveToLibrary(lib, patched);
		expect(lib.pipelines.p.nodes.some((n) => n.data.gainDb === 18)).toBe(true);
	});
	it('captured plugin state belongs to one instance', () => {
		const p = pipeline();
		p.nodes[1] = { ...node('a', 'plugin'), data: { path: 'p', pluginId: 'plug', state: 'initial' } as PipelineNode['data'] };
		const doc = documentFor(p);
		const id = groupSelection(doc, [], ['a']);
		definition(doc, doc.root).nodes.push({ ...structuredClone(group(doc, id)), id: 'second', identity: undefined });
		const full = materialize(p, doc);
		const plugins = full.nodes.filter((n) => n.kind === 'plugin');
		const captured = patchRuntimeNode(full, plugins[1].id, { state: 'instance' });
		expect(captured.nodes.find((n) => n.id === plugins[0].id)!.data.state).toBe('initial');
		expect(captured.nodes.find((n) => n.id === plugins[1].id)!.data.state).toBe('instance');
		const cloned = documentFor(captured);
		definition(cloned, cloned.root).nodes.push({ ...structuredClone(group(cloned, id)), id: 'third', identity: undefined });
		copyInstanceState(captured.groups!, ['second'], cloned, ['third']);
		expect(expand(cloned).nodes.filter((n) => n.data.state === 'instance')).toHaveLength(2);
	});
	it('duplicate through the clipboard preserves a group and its port wiring', () => {
		const doc = documentFor(pipeline());
		const id = groupSelection(doc, [], ['a', 'b']);
		const view = groupView(doc, []);
		const copied = copyGraph(
			view.nodes.filter((n) => n.id === id || n.id === 'rec'),
			view.edges
		)!;
		const pasted = pasteGraph(
			copied,
			{ x: 500, y: 500 },
			copied.nodes.map((n) => (n.kind === 'group' ? 'group-copy' : 'rec-copy')),
			['e1', 'e2']
		);
		const newGroup = pasted.nodes.find((n) => n.type === 'group')!;
		newGroup.data.definition = copyDefinition(doc, String(newGroup.data.definition));
		saveGroupView(doc, [], [...view.nodes, ...pasted.nodes], [...view.edges, ...pasted.edges]);
		const flat = expand(doc);
		expect(flat.nodes).toHaveLength(7);
		expect(flat.edges.filter((e) => e.target === 'rec-copy')).toHaveLength(2);
		expect(new Set(flat.nodes.map((n) => n.id)).size).toBe(7);
	});
	it('adding a node in one linked interior gives every instance a stable runtime ID', () => {
		const doc = documentFor(pipeline());
		const id = groupSelection(doc, [], ['a']);
		definition(doc, doc.root).nodes.push({ ...structuredClone(group(doc, id)), id: 'linked', identity: undefined });
		const view = groupView(doc, ['linked']);
		view.nodes.push({ id: 'added-runtime', type: 'gain', position: { x: 0, y: 0 }, data: { gainDb: 3 } });
		saveGroupView(doc, ['linked'], view.nodes, view.edges);
		const first = expand(doc);
		expect(first.nodes.some((n) => n.id === 'added-runtime')).toBe(true);
		expect(first.nodes.filter((n) => n.data.gainDb === 3)).toHaveLength(2);
		expect(expand(JSON.parse(JSON.stringify(doc))).nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
	});
	it('rejects port deletion atomically when an unused library group still references it', () => {
		const doc = documentFor(pipeline());
		const id = groupSelection(doc, [], ['a']);
		let lib = saveToLibrary(empty(), materialize(pipeline(), doc));
		const saved = structuredClone(lib);
		const edit = documentFor(lib.pipelines.p);
		definition(edit, group(edit, id).data.definition).inputs = [];
		expect(() => saveToLibrary(lib, { ...lib.pipelines.p, groups: edit })).toThrow('Missing input port');
		expect(lib).toEqual(saved);
	});
	it('keeps WebRTC grouping intact but rejects reusing room-specific routes', () => {
		const p = pipeline();
		p.nodes[1] = node('a', 'webRtcCollaborator');
		p.edges[1].sourceHandle = 'peer:session:0';
		const doc = documentFor(p);
		const before = routing(expand(doc));
		const id = groupSelection(doc, [], ['a', 'b']);
		expect(routing(expand(doc))).toEqual(before);
		expect(() => assertReusableInstance(doc, group(doc, id).data.definition)).toThrow('room-specific');
	});
	it('Alt connects group ports in order with stable handles and preserves bus/channel meaning', () => {
		const output = {
			id: 'g1',
			handles: [],
			ordered: [
				{ id: 'voice', handle: 'ch1' },
				{ id: 'music', handle: 'ch2' }
			]
		};
		const input = {
			id: 'g2',
			handles: [],
			ordered: [
				{ id: 'left', handle: 'ch1' },
				{ id: 'right', handle: 'ch2' }
			]
		};
		const planned = planAutoConnect(output, input, []);
		expect(planned.map((e) => [e.sourceHandle, e.targetHandle])).toEqual([
			['voice', 'left'],
			['music', 'right']
		]);
		expect(
			planAutoConnect(
				output,
				input,
				planned.map((e, i) => ({ ...e, id: String(i) }))
			)
		).toHaveLength(0);
		expect(planAutoConnect({ ...output, ordered: [{ id: 'mix', handle: 'mixed' }] }, input, [])).toHaveLength(0);
		expect(planAutoConnect(output, { id: 'plain', handles: [], channels: { min: 0, max: 2, selfGrowing: false } }, []).map((e) => e.targetHandle)).toEqual([
			'ch1',
			'ch2'
		]);
	});
});
