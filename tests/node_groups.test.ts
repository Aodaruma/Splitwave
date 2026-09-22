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
	runtimeId,
	scopeAt,
	ungroup,
	type GroupDocument,
	type GroupNode
} from '../src/lib/modules/pipeline/groups';
import { findGroupInstance, saveToLibrary, type GroupLibrary } from '../src/lib/modules/pipeline/group_library';
import { BOUNDARY_INPUT, BOUNDARY_OUTPUT, groupView, saveGroupView } from '../src/lib/modules/flow/utils/group_view';
import { boundaryPort, editPort, exposePort, NEW_GROUP_PORT, survivingGroupPath } from '../src/lib/modules/flow/utils/group_ports';
import { groupPathFromPage, groupPathFromUrl, groupUrl } from '../src/lib/modules/flow/utils/group_navigation';
import { createHistoryRestorer } from '../src/lib/modules/flow/utils/history_restore';
import { withDefaults } from '../src/lib/modules/pipeline/defaults';
import { migrate, isFromFuture } from '../src/lib/modules/pipeline/migrations';
import { exposedAudioHandles, planGroupPorts, planAutoConnect } from '../src/lib/modules/flow/utils/auto_connect';
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
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

describe('reusable node groups', () => {
	it('new interior sockets become stable external ports and survive linked-instance edits', () => {
		const p = { ...pipeline(), edges: [] };
		const doc = documentFor(p);
		const id = groupSelection(doc, [], ['a']);
		const original = group(doc, id);
		definition(doc, doc.root).nodes.push({ ...structuredClone(original), id: 'linked', identity: undefined });
		const d = scopeAt(doc, ['linked']);
		expect(exposePort(d, 'inputs', 'a', 'ch1', 'Left')).toBe(true);
		expect(exposePort(d, 'inputs', 'a', 'ch2', 'Right')).toBe(true);
		expect(exposePort(d, 'outputs', 'a', 'ch1', 'Output')).toBe(true);
		expect(exposePort(d, 'inputs', 'a', 'ch1', 'Duplicate')).toBe(false);
		expect(() => exposePort(d, 'inputs', 'missing', 'ch1', 'Bad')).toThrow('interior node');
		const input = d.inputs[0].id;
		const output = d.outputs[0].id;
		definition(doc, doc.root).edges.push(
			{ id: 'in', source: 'mic', sourceHandle: 'ch2', target: 'linked', targetHandle: input },
			{ id: 'out', source: 'linked', sourceHandle: output, target: 'rec', targetHandle: 'ch1' }
		);
		const before = routing(expand(doc));
		const runtime = runtimeId(doc, ['linked'], 'a');
		expect(runtime).not.toBe('a');
		expect(before.edges.find((e) => e.id === 'in')?.target).toBe(runtime);
		editPort(d, 'inputs', input, 'label', 'Voice L');
		editPort(d, 'inputs', input, 'down');
		const view = groupView(doc, ['linked']);
		expect(view.edges.find((e) => e.sourceHandle === input)?.target).toBe(runtime);
		saveGroupView(doc, ['linked'], view.nodes, view.edges);
		expect(routing(expand(doc))).toEqual(before);
		const saved = materialize(p, doc);
		expect(routing(expand(documentFor(JSON.parse(JSON.stringify(saved)))))).toEqual(before);
		editPort(d, 'inputs', input, 'remove');
		expect(() => expand(doc)).toThrow('Missing input port');
	});
	it('accepts only new boundary sockets and keeps them out of the audio graph', () => {
		const input = { source: BOUNDARY_INPUT, sourceHandle: NEW_GROUP_PORT, target: 'a', targetHandle: 'ch1' };
		const output = { source: 'a', sourceHandle: 'ch1', target: BOUNDARY_OUTPUT, targetHandle: NEW_GROUP_PORT };
		expect(boundaryPort(input)).toEqual({ side: 'inputs', node: 'a', handle: 'ch1' });
		expect(boundaryPort(output)).toEqual({ side: 'outputs', node: 'a', handle: 'ch1' });
		expect(boundaryPort({ ...input, sourceHandle: 'existing' })).toBeNull();
		expect(boundaryPort({ ...input, target: BOUNDARY_OUTPUT, targetHandle: NEW_GROUP_PORT })).toBeNull();
		const doc = documentFor(pipeline());
		const id = groupSelection(doc, [], ['a']);
		const view = groupView(doc, [id]);
		const before = routing(expand(doc));
		saveGroupView(doc, [id], view.nodes, [...view.edges, { ...input, id: 'temporary' }]);
		expect(routing(expand(doc))).toEqual(before);
	});
	it('exposes meaningful stereo ports without sidechains or spare channel sockets', () => {
		const handles = [
			{ id: 'ch1', y: 0 },
			{ id: 'ch2', y: 10 },
			{ id: 'ch3', y: 20 }
		];
		const ports = { id: 'a', handles, channels: { max: 8, min: 0, selfGrowing: false } };
		const edges = [1, 2].map((ch) => ({ id: String(ch), source: 'mic', target: 'a', targetHandle: `ch${ch}` }));
		expect(exposedAudioHandles(ports, 'source', edges)).toEqual(['ch1', 'ch2']);
		expect(exposedAudioHandles(ports, 'target', edges)).toEqual(['ch1', 'ch2']);
		expect(exposedAudioHandles(ports, 'target', [])).toEqual(['ch1']);
		expect(
			exposedAudioHandles(
				{
					id: 'group',
					handles: [],
					ordered: [
						{ id: 'left', handle: 'L' },
						{ id: 'sidechain', handle: 'sidechain' },
						{ id: 'right', handle: 'R' }
					]
				},
				'target',
				[]
			)
		).toEqual(['left', 'right']);
	});
	it('repeated boundary gestures expose the next dynamic input within its channel limit', () => {
		const ports = { id: 'a', handles: [], channels: { max: 3, min: 0, selfGrowing: false } };
		const exposed: string[] = [];
		for (let ch = 1; ch <= 3; ch++) {
			const edges = exposed.map((handle) => ({ id: handle, source: BOUNDARY_INPUT, target: 'a', targetHandle: handle }));
			expect(planGroupPorts(ports, 'target', edges, exposed)).toEqual([`ch${ch}`]);
			exposed.push(`ch${ch}`);
		}
		expect(planGroupPorts(ports, 'target', [], exposed)).toEqual([]);
	});
	it('exposes existing stereo inputs together before advancing and does not invent output or fixed ports', () => {
		const ports = { id: 'a', handles: [], channels: { max: 8, min: 0, selfGrowing: false } };
		const edges = ['ch1', 'ch2', 'sidechain'].map((handle) => ({ id: handle, source: 'mic', target: 'a', targetHandle: handle }));
		expect(planGroupPorts(ports, 'target', edges, [])).toEqual(['ch1', 'ch2']);
		expect(planGroupPorts(ports, 'target', edges, ['ch1'])).toEqual(['ch2']);
		expect(planGroupPorts(ports, 'target', edges, ['ch1', 'ch2'])).toEqual(['ch3']);
		expect(planGroupPorts(ports, 'source', edges, ['ch1', 'ch2'])).toEqual([]);
		expect(planGroupPorts(ports, 'source', [], [])).toEqual([]);
		const fixed = {
			id: 'fixed',
			handles: [
				{ id: 'L', y: 0 },
				{ id: 'R', y: 10 },
				{ id: 'sidechain', y: 20 }
			]
		};
		expect(planGroupPorts(fixed, 'target', [], ['L', 'R'])).toEqual([]);
		const nested = { ...ports, ordered: [{ id: 'stable', handle: 'ch1' }] };
		expect(planGroupPorts(nested, 'target', [], ['stable'])).toEqual([]);
	});
	it('retains nested navigation URLs and falls back after Undo removes a group', () => {
		const doc = documentFor(pipeline());
		const outer = groupSelection(doc, [], ['a', 'b']);
		const inner = groupSelection(doc, [outer], ['a']);
		const url = new URL('http://localhost/pipelines/p?view=editor#canvas');
		const nested = groupUrl(url, [outer, inner]);
		// SvelteKit shallow navigation keeps the loaded URL and changes page.state.
		expect(groupPathFromPage(url, { editorGroupPath: [outer, inner] })).toEqual([outer, inner]);
		expect(groupPathFromPage(nested, { editorGroupPath: [] })).toEqual([]);
		expect(groupPathFromPage(nested, {})).toEqual([outer, inner]);
		expect(groupPathFromUrl(nested)).toEqual([outer, inner]);
		expect(nested.searchParams.get('view')).toBe('editor');
		expect(nested.hash).toBe('#canvas');
		expect(survivingGroupPath(doc, groupPathFromUrl(nested))).toEqual([outer, inner]);
		ungroup(doc, [outer], inner);
		expect(survivingGroupPath(doc, groupPathFromUrl(nested))).toEqual([outer]);
		ungroup(doc, [], outer);
		expect(survivingGroupPath(doc, groupPathFromUrl(nested))).toEqual([]);
		expect(groupUrl(nested, []).href).toBe(url.href);
	});
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
	it('reusable insertion inherits the saved occurrence state of a nested child group', () => {
		const p = pipeline();
		p.nodes[1] = { ...node('a', 'plugin'), data: withDefaults('plugin', { path: 'p', pluginId: 'plug', state: 'factory' }) };
		const doc = documentFor(p);
		const child = groupSelection(doc, [], ['a']);
		const childDefinition = group(doc, child).data.definition;
		const outer = groupSelection(doc, [], [child]);
		const library = saveToLibrary(empty(), patchRuntimeNode(materialize(p, doc), 'a', { state: 'user-preset' }));
		const before = structuredClone(library);
		const source = findGroupInstance(library, childDefinition)!;
		expect(source.path).toEqual([outer, child]);
		expect(findGroupInstance(library, doc.root)?.path).toEqual([]);
		expect(findGroupInstance(library, 'unused')).toBeUndefined();
		for (const linked of [false, true]) {
			const target = documentFor({ ...pipeline('q'), nodes: [], edges: [] });
			Object.assign(target.definitions, structuredClone(library.definitions));
			const id = linked ? childDefinition : copyDefinition(target, childDefinition);
			definition(target, target.root).nodes.push({ id: 'inserted', kind: 'group', data: { definition: id }, position: { x: 0, y: 0 } });
			copyInstanceState(source.doc, source.path, target, ['inserted']);
			const copied = expand(target).nodes[0];
			expect(copied.id).not.toBe('a');
			expect(copied.data.state).toBe('user-preset');
			expect(definition(target, id).nodes[0].data).toMatchObject({ state: 'factory' });
		}
		expect(library).toEqual(before);
	});
	it('group views round-trip captured plugin states without broadcasting them to linked instances', () => {
		const p = pipeline();
		p.nodes[1] = { ...node('a', 'plugin'), data: withDefaults('plugin', { path: 'p', pluginId: 'plug', state: 'factory' }) };
		const doc = documentFor(p);
		const first = groupSelection(doc, [], ['a']);
		definition(doc, doc.root).nodes.push({ ...structuredClone(group(doc, first)), id: 'linked', identity: undefined });
		const linkedId = runtimeId(doc, ['linked'], 'a');
		let library = saveToLibrary(empty(), patchRuntimeNode(materialize(p, doc), linkedId, { state: 'captured' }));
		const edit = documentFor(library.pipelines.p);
		const sharedData = structuredClone(scopeAt(edit, ['linked']).nodes[0].data);
		const view = groupView(edit, ['linked']);
		expect(view.nodes.find((n) => n.id === linkedId)!.data.state).toBe('captured');
		saveGroupView(edit, ['linked'], view.nodes, view.edges);
		library = saveToLibrary(library, materialize(p, edit));
		const reloaded = JSON.parse(JSON.stringify(library.pipelines.p)) as Pipeline;
		expect(reloaded.nodes.find((n) => n.id === linkedId)!.data.state).toBe('captured');
		expect(reloaded.nodes.find((n) => n.id === 'a')!.data.state).toBe('factory');
		expect(scopeAt(reloaded.groups!, ['linked']).nodes[0].data).toEqual(sharedData);
		expect(reloaded.nodes).toHaveLength(5);
		expect(reloaded.edges).toHaveLength(4);
	});
	it('explicit plugin presets, resets and selection changes replace stale occurrence state', () => {
		const p = pipeline();
		p.nodes[1] = { ...node('a', 'plugin'), data: withDefaults('plugin', { path: 'p', pluginId: 'plug', state: 'factory' }) };
		let doc = documentFor(p);
		const first = groupSelection(doc, [], ['a']);
		definition(doc, doc.root).nodes.push({ ...structuredClone(group(doc, first)), id: 'linked', identity: undefined });
		const linkedId = runtimeId(doc, ['linked'], 'a');
		doc = documentFor(patchRuntimeNode(materialize(p, doc), 'a', { state: 'captured' }));
		let view = groupView(doc, [first]);
		Object.assign(view.nodes.find((n) => n.id === 'a')!.data, { state: 'preset', bypassed: true });
		saveGroupView(doc, [first], view.nodes, view.edges);
		let full = materialize(p, doc);
		expect(full.nodes.find((n) => n.id === 'a')!.data.state).toBe('preset');
		expect(full.nodes.find((n) => n.id === linkedId)!.data).toMatchObject({ state: 'factory', bypassed: true });
		full = patchRuntimeNode(full, 'a', { state: 'runtime-preset', bypassed: false });
		expect(full.nodes.find((n) => n.id === 'a')!.data).toMatchObject({ state: 'runtime-preset', bypassed: false });
		doc = documentFor(full);
		view = groupView(doc, [first]);
		view.nodes.find((n) => n.id === 'a')!.data.state = null;
		saveGroupView(doc, [first], view.nodes, view.edges);
		full = saveToLibrary(empty(), materialize(p, doc)).pipelines.p;
		expect(full.nodes.find((n) => n.id === 'a')!.data.state).toBeNull();
		expect(full.nodes.find((n) => n.id === linkedId)!.data.state).toBe('factory');
		full = patchRuntimeNode(full, 'a', { state: 'another-capture' });
		doc = documentFor(full);
		view = groupView(doc, [first]);
		Object.assign(view.nodes.find((n) => n.id === 'a')!.data, { path: 'other', pluginId: 'other', state: null });
		saveGroupView(doc, [first], view.nodes, view.edges);
		expect(doc.pluginStates.a).toBeUndefined();
		full = patchRuntimeNode(materialize(p, doc), 'a', { path: 'p', pluginId: 'plug', state: 'new-preset' });
		expect(full.nodes.find((n) => n.id === 'a')!.data.state).toBe('new-preset');
		expect(full.nodes.find((n) => n.id === linkedId)!.data.state).toBe('new-preset');
		full = patchRuntimeNode(full, 'a', { state: null, bypassed: true });
		expect(full.nodes.find((n) => n.id === 'a')!.data.state).toBeNull();
	});
	it('legacy nodes receive withDefaults in root and nested views and keep them on save', () => {
		const p = { ...pipeline(), nodes: [node('a', 'compressor'), node('b', 'audioFile'), node('c', 'eq')], edges: [] };
		p.nodes[0].data = { thresholdDb: -25 } as PipelineNode['data'];
		p.nodes[1].data = { filePath: 'input.wav' } as PipelineNode['data'];
		p.nodes[2].data = {} as PipelineNode['data'];
		for (const nested of [false, true]) {
			const doc = documentFor(p);
			const path = nested ? [groupSelection(doc, [], ['a', 'b', 'c'])] : [];
			const view = groupView(doc, path);
			for (const original of p.nodes) expect(view.nodes.find((n) => n.id === original.id)!.data).toEqual(withDefaults(original.kind, original.data));
			(view.nodes.find((n) => n.id === 'c')!.data.gainsDb as number[])[0] = 6;
			expect(withDefaults('eq', {}).gainsDb[0]).toBe(0);
			saveGroupView(doc, path, view.nodes, view.edges);
			const full = materialize(p, doc);
			expect(full.nodes[0].data).toMatchObject({ thresholdDb: -25, ratio: 3, bypassed: false });
			expect(full.nodes[1].data).toMatchObject({ filePath: 'input.wav', autoStart: true, loopEnabled: false });
			expect(groupView(doc, path).nodes.find((n) => n.id === 'c')!.data.gainsDb).toEqual([6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		}
	});
	it('independent copies and imports clear nested destinations and hotkeys while Make Independent preserves them', () => {
		const p = pipeline();
		p.nodes[1] = { ...node('a', 'mute'), data: withDefaults('mute', { hotkey: 'Ctrl+M', pushToTalk: true, muted: false, cueEnabled: true }) };
		p.nodes[2] = { ...node('b', 'audioFile'), data: withDefaults('audioFile', { filePath: 'input.wav', loopEnabled: true }) };
		p.nodes[3].data = withDefaults('fileRecording', { filePath: 'record.wav' });
		const doc = documentFor(p);
		const child = groupSelection(doc, [], ['a', 'rec']);
		const outer = groupSelection(doc, [], [child, 'b']);
		const original = group(doc, outer);
		const originalDefinition = original.data.definition;
		const before = routing(expand(doc));
		for (const source of [original.data.definition, doc.root]) {
			const copied = copyDefinition(doc, source);
			const flat = expand({ ...doc, root: copied, runtimeIds: {} });
			expect(flat.nodes.find((n) => n.kind === 'fileRecording')!.data.filePath).toBeNull();
			const mute = flat.nodes.find((n) => n.kind === 'mute')!.data;
			expect(mute.hotkey).toBeUndefined();
			expect(mute).toMatchObject({ pushToTalk: true, muted: true, cueEnabled: true });
			expect(flat.nodes.find((n) => n.kind === 'audioFile')!.data.filePath).toBe('input.wav');
		}
		expect(routing(expand(doc))).toEqual(before);
		makeIndependent(doc, [], outer);
		expect(routing(expand(doc))).toEqual(before);
		expect(group(doc, outer).data.definition).not.toBe(originalDefinition);
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

describe('serialized group history restoration', () => {
	it('selects each Undo/Redo target after the preceding delayed restore updates the cursor', async () => {
		const p = pipeline();
		const doc = documentFor(p);
		groupSelection(doc, [], ['a', 'b']);
		const history = ['A', 'B', 'C'].map((name) => materialize({ ...p, name }, structuredClone(doc)));
		let cursor = 2;
		let shown = history[cursor];
		const started = deferred<void>();
		const saved = deferred<void>();
		const targets: string[] = [];
		const flushed: number[] = [];
		const move = createHistoryRestorer({
			flush: () => {
				flushed.push(cursor);
			},
			current: () => ({ history, cursor }),
			restore: async (snapshot) => {
				targets.push(snapshot.name);
				if (targets.length === 1) {
					started.resolve();
					await saved.promise;
				}
				shown = structuredClone(snapshot);
				return true;
			},
			setCursor: (next) => (cursor = next)
		});
		const requests = [move(-1), move(-1), move(1)];
		await started.promise;
		expect(targets).toEqual(['B']);
		expect(flushed).toEqual([2]);
		expect(cursor).toBe(2);
		saved.resolve();
		await Promise.all(requests);
		expect(targets).toEqual(['B', 'A', 'B']);
		expect(flushed).toEqual([2, 1, 0]);
		expect(cursor).toBe(1);
		expect(shown).toEqual(history[cursor]);
		expect(shown.nodes).toHaveLength(4);
		expect(shown.edges).toHaveLength(4);
		await Promise.all([move(1), move(1)]);
		expect(cursor).toBe(2);
		expect(shown).toEqual(history[cursor]);
		await Promise.all([move(-1), move(-1), move(-1)]);
		expect(cursor).toBe(0);
		expect(shown).toEqual(history[cursor]);
	});
	it('leaves the cursor unchanged after shared-restore cancellation or rejection and accepts the next request', async () => {
		const history = ['A', 'B', 'C'].map((name) => ({ ...pipeline(), name }));
		let cursor = 2;
		let shown = history[cursor];
		const confirmation = deferred<boolean>();
		const started = deferred<void>();
		const targets: string[] = [];
		const move = createHistoryRestorer({
			flush: () => {},
			current: () => ({ history, cursor }),
			restore: async (snapshot) => {
				targets.push(snapshot.name);
				if (targets.length === 1) {
					started.resolve();
					if (!(await confirmation.promise)) return false;
				}
				if (targets.length === 2) throw new Error('shared revision conflict');
				shown = snapshot;
				return true;
			},
			setCursor: (next) => (cursor = next)
		});
		const cancelled = move(-1);
		const rejected = move(-1).then(
			() => null,
			(error: Error) => error
		);
		await started.promise;
		expect(targets).toEqual(['B']);
		confirmation.resolve(false);
		await cancelled;
		expect((await rejected)?.message).toBe('shared revision conflict');
		expect(cursor).toBe(2);
		expect(shown).toEqual(history[2]);
		await move(-1);
		expect(targets).toEqual(['B', 'B', 'B']);
		expect(cursor).toBe(1);
		expect(shown).toEqual(history[cursor]);
	});
});
