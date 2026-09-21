import { PIPELINE_VERSION } from './version';
import { createId } from '@paralleldrive/cuid2';
import type { Pipeline, PipelineEdge, PipelineNode } from './types';
import { RECORDING_FORMATS } from './recording-formats';

export interface GroupPort {
	id: string;
	label: string;
	node: string;
	handle?: string;
}

export interface GroupNode {
	id: string;
	kind: 'group';
	position: { x: number; y: number };
	data: { definition: string };
}

export type EditorNode = (PipelineNode | GroupNode) & { identity?: string[] };
export type EditorEdge = PipelineEdge & { identity?: string[] };
export interface GroupGraph {
	nodes: EditorNode[];
	edges: EditorEdge[];
}

export interface GroupDefinition extends GroupGraph {
	id: string;
	name: string;
	revision: number;
	inputs: GroupPort[];
	outputs: GroupPort[];
}

export interface GroupDocument {
	root: string;
	definitions: Record<string, GroupDefinition>;
	/** Paths belong to occurrences, never to a shared definition. */
	runtimeIds: Record<string, string>;
	pluginStates: Record<string, { path: string; pluginId: string; state: string | null }>;
}

export function definition(doc: GroupDocument, id: string): GroupDefinition {
	const d = doc.definitions[id];
	if (!d) throw new Error(`Missing reusable group: ${id}`);
	return d;
}

export function scopeAt(doc: GroupDocument, path: string[]): GroupDefinition {
	let d = definition(doc, doc.root);
	for (const id of path) {
		const n = d.nodes.find((n) => n.id === id);
		if (n?.kind !== 'group') throw new Error(`Missing group instance: ${id}`);
		d = definition(doc, n.data.definition);
	}
	return d;
}

export function runtimeId(doc: GroupDocument, path: string[], localId: string): string {
	let d = definition(doc, doc.root);
	const identity: string[] = [];
	for (const id of path) {
		const n = d.nodes.find((n) => n.id === id);
		if (n?.kind !== 'group') throw new Error('Missing group instance: ' + id);
		identity.push(...(n.identity ?? [n.id]));
		d = definition(doc, n.data.definition);
	}
	const item = localId.startsWith('#') ? d.edges.find((e) => e.id === localId.slice(1)) : d.nodes.find((n) => n.id === localId);
	identity.push(...(item?.identity ?? [localId]));
	const key = identity.join('/');
	return (doc.runtimeIds[key] ??= identity.length === 1 ? identity[0].replace(/^#/, '') : createId());
}

export function documentFor(p: Pipeline): GroupDocument {
	if (p.groups) return structuredClone(p.groups);
	const root = `pipeline:${p.id}`;
	return {
		root,
		definitions: {
			[root]: { id: root, name: p.name, revision: 0, nodes: structuredClone(p.nodes), edges: structuredClone(p.edges), inputs: [], outputs: [] }
		},
		runtimeIds: {},
		pluginStates: {}
	};
}

export function dependencies(doc: GroupDocument, root = doc.root): Record<string, GroupDefinition> {
	const result: Record<string, GroupDefinition> = {};
	const visiting = new Set<string>();
	function visit(id: string) {
		if (visiting.has(id)) throw new Error(`Reusable group cycle: ${[...visiting, id].join(' → ')}`);
		if (result[id]) return;
		const d = definition(doc, id);
		visiting.add(id);
		for (const n of d.nodes) if (n.kind === 'group') visit(n.data.definition);
		visiting.delete(id);
		result[id] = d;
	}
	visit(root);
	return result;
}

export function effectiveNodeData(doc: GroupDocument, id: string, node: PipelineNode): PipelineNode['data'] {
	const state = doc.pluginStates[id];
	return node.kind === 'plugin' && state?.path === node.data.path && state?.pluginId === node.data.pluginId
		? { ...node.data, state: state.state }
		: { ...node.data };
}

export function saveNodeData(doc: GroupDocument, id: string, node: PipelineNode, data: PipelineNode['data']): PipelineNode['data'] {
	if (node.kind !== 'plugin') return data;
	if (node.data.path !== data.path || node.data.pluginId !== data.pluginId) {
		delete doc.pluginStates[id];
		return data;
	}
	const state = data.state ?? null;
	if (state !== (effectiveNodeData(doc, id, node).state ?? null) && (typeof state === 'string' || state === null)) {
		doc.pluginStates[id] = { path: String(data.path), pluginId: String(data.pluginId), state };
	}
	// Displaying a capture must not publish it to the shared definition.
	return { ...data, state: node.data.state ?? null };
}

export function expand(doc: GroupDocument): { nodes: PipelineNode[]; edges: PipelineEdge[] } {
	dependencies(doc);
	const nodes: PipelineNode[] = [];
	const edges: PipelineEdge[] = [];
	function endpoint(
		d: GroupDefinition,
		path: string[],
		nodeId: string,
		handle: string | undefined,
		side: 'inputs' | 'outputs'
	): { node: string; handle?: string } {
		const n = d.nodes.find((n) => n.id === nodeId);
		if (!n) throw new Error(`Missing node in ${d.name}: ${nodeId}`);
		if (n.kind !== 'group') return { node: runtimeId(doc, path, n.id), handle };
		const inner = definition(doc, n.data.definition);
		const port = inner[side].find((p) => p.id === handle);
		if (!port) throw new Error(`Missing ${side === 'inputs' ? 'input' : 'output'} port in ${inner.name}: ${handle ?? '(none)'}`);
		return endpoint(inner, [...path, n.id], port.node, port.handle, side);
	}
	function visit(d: GroupDefinition, path: string[]) {
		const ids = new Set<string>();
		for (const n of d.nodes) {
			if (ids.has(n.id) || n.id.includes('/')) throw new Error(`Invalid or duplicate node ID in ${d.name}: ${n.id}`);
			ids.add(n.id);
			if (n.kind === 'group') visit(definition(doc, n.data.definition), [...path, n.id]);
			else {
				const id = runtimeId(doc, path, n.id);
				const captured = doc.pluginStates[id];
				if (captured && (n.kind !== 'plugin' || captured.path !== n.data.path || captured.pluginId !== n.data.pluginId)) delete doc.pluginStates[id];
				const data = effectiveNodeData(doc, id, n);
				const { identity: _, ...node } = n;
				nodes.push({ ...node, id, data });
			}
		}
		for (const side of ['inputs', 'outputs'] as const) {
			const portIds = new Set<string>();
			for (const p of d[side]) {
				if (portIds.has(p.id)) throw new Error(`Duplicate port in ${d.name}: ${p.id}`);
				portIds.add(p.id);
				endpoint(d, path, p.node, p.handle, side);
			}
		}
		for (const e of d.edges) {
			const source = endpoint(d, path, e.source, e.sourceHandle, 'outputs');
			const target = endpoint(d, path, e.target, e.targetHandle, 'inputs');
			const { identity: _, ...edge } = e;
			edges.push({
				...edge,
				id: runtimeId(doc, path, `#${e.id}`),
				source: source.node,
				sourceHandle: source.handle,
				target: target.node,
				targetHandle: target.handle
			});
		}
	}
	visit(definition(doc, doc.root), []);
	if (new Set(nodes.map((n) => n.id)).size !== nodes.length) throw new Error('Duplicate runtime node ID');
	// Channel configuration must follow complete wiring even with the editor closed.
	for (const n of nodes) {
		const source = n.kind === 'netReceiver';
		const wired = edges
			.filter((e) => (source ? e.source === n.id : e.target === n.id))
			.reduce((max, e) => {
				const handle = source ? e.sourceHandle : e.targetHandle;
				const match = /^ch([1-9]\d*)$/.exec(handle ?? '');
				return match ? Math.max(max, Number(match[1])) : max;
			}, 0);
		if (['netReceiver', 'netSender', 'webRtcCollaborator'].includes(n.kind)) n.data.channels = Math.max(1, Math.min(wired, 255));
		if (n.kind === 'fileRecording' && Number(n.data.channels) > 2) {
			const format = (n.data as import('./types').FileRecordingNodeData).format;
			n.data.channels = Math.max(3, Math.min(wired, RECORDING_FORMATS[format.kind].maxChannels));
		}
	}
	return { nodes, edges };
}

export function materialize(p: Pipeline, doc = documentFor(p)): Pipeline {
	const graph = expand(doc);
	return { ...p, ...graph, version: PIPELINE_VERSION, groups: { ...doc, definitions: dependencies(doc) } };
}

export function groupSelection(doc: GroupDocument, path: string[], selected: string[], name = 'Group'): string {
	expand(doc);
	const d = scopeAt(doc, path);
	const chosen = new Set(selected);
	const children = d.nodes.filter((n) => chosen.has(n.id));
	if (!children.length) throw new Error('Select nodes to group');
	const id = createId();
	const inner: GroupDefinition = { id: createId(), name, revision: 0, nodes: children, edges: [], inputs: [], outputs: [] };
	const position = { x: Math.min(...children.map((n) => n.position.x)), y: Math.min(...children.map((n) => n.position.y)) };
	function port(side: 'inputs' | 'outputs', node: string, handle?: string) {
		let p = inner[side].find((p) => p.node === node && p.handle === handle);
		if (!p) {
			const child = children.find((n) => n.id === node)!;
			const label = child.kind === 'group' ? definition(doc, child.data.definition).name : String(child.data.name || child.kind);
			p = { id: createId(), label: `${label} · ${handle ?? 'Audio'}`, node, handle };
			inner[side].push(p);
		}
		return p.id;
	}
	const outer: EditorEdge[] = [];
	for (const e of d.edges) {
		const source = chosen.has(e.source),
			target = chosen.has(e.target);
		if (source && target) inner.edges.push(e);
		else
			outer.push({
				...e,
				...(source ? { source: id, sourceHandle: port('outputs', e.source, e.sourceHandle) } : {}),
				...(target ? { target: id, targetHandle: port('inputs', e.target, e.targetHandle) } : {})
			});
	}
	// A parent interface is wiring too, even when this occurrence is unused.
	for (const side of ['inputs', 'outputs'] as const)
		for (const p of d[side])
			if (chosen.has(p.node)) {
				p.handle = port(side, p.node, p.handle);
				p.node = id;
			}
	inner.nodes = children.map((n) => ({ ...n, position: { x: n.position.x - position.x + 100, y: n.position.y - position.y + 100 } }));
	doc.definitions[inner.id] = inner;
	d.nodes = [...d.nodes.filter((n) => !chosen.has(n.id)), { id, kind: 'group', data: { definition: inner.id }, position, identity: [] }];
	d.edges = outer;
	return id;
}

export function ungroup(doc: GroupDocument, path: string[], id: string) {
	expand(doc);
	const d = scopeAt(doc, path);
	const instance = d.nodes.find((n) => n.id === id);
	if (instance?.kind !== 'group') throw new Error('Select a group');
	const inner = definition(doc, instance.data.definition);
	const ids = new Map(inner.nodes.map((n) => [n.id, createId()]));
	const edgeIds = new Map(inner.edges.map((e) => [e.id, createId()]));
	const resolve = (side: 'inputs' | 'outputs', handle?: string) => {
		const p = inner[side].find((p) => p.id === handle);
		if (!p) throw new Error(`Missing port in ${inner.name}: ${handle}`);
		return { node: ids.get(p.node)!, handle: p.handle };
	};
	d.edges = d.edges.map((e) => {
		const s = e.source === id ? resolve('outputs', e.sourceHandle) : null;
		const t = e.target === id ? resolve('inputs', e.targetHandle) : null;
		return { ...e, ...(s ? { source: s.node, sourceHandle: s.handle } : {}), ...(t ? { target: t.node, targetHandle: t.handle } : {}) };
	});
	for (const side of ['inputs', 'outputs'] as const) for (const p of d[side]) if (p.node === id) Object.assign(p, resolve(side, p.handle));
	d.edges.push(
		...inner.edges.map((e) => ({
			...e,
			id: edgeIds.get(e.id)!,
			identity: [...(instance.identity ?? [instance.id]), ...(e.identity ?? ['#' + e.id])],
			source: ids.get(e.source)!,
			target: ids.get(e.target)!
		}))
	);
	d.nodes = [
		...d.nodes.filter((n) => n.id !== id),
		...inner.nodes.map((n) => ({
			...structuredClone(n),
			id: ids.get(n.id)!,
			identity: [...(instance.identity ?? [instance.id]), ...(n.identity ?? [n.id])],
			position: { x: n.position.x + instance.position.x - 100, y: n.position.y + instance.position.y - 100 }
		}))
	];
}

export function copyDefinition(doc: GroupDocument, id: string, preserveConfiguration = false): string {
	const originals = dependencies(doc, id);
	const ids = new Map(Object.keys(originals).map((id) => [id, createId()]));
	for (const original of Object.values(originals)) {
		const copy = structuredClone(original);
		copy.id = ids.get(original.id)!;
		copy.revision = 0;
		copy.nodes = copy.nodes.map((n) => (n.kind === 'group' ? { ...n, data: { definition: ids.get(n.data.definition)! } } : n));
		if (!preserveConfiguration)
			for (const n of copy.nodes) {
				if (n.kind === 'fileRecording') n.data.filePath = null;
				if (n.kind === 'mute') {
					delete n.data.hotkey;
					if (n.data.pushToTalk) n.data.muted = true;
				}
			}
		doc.definitions[copy.id] = copy;
	}
	return ids.get(id)!;
}

export function assertReusableInstance(doc: GroupDocument, id: string) {
	for (const d of Object.values(dependencies(doc, id))) {
		const live = (node: string, handle?: string) =>
			d.nodes.some((n) => n.id === node && n.kind === 'webRtcCollaborator') && (handle === 'mixed' || handle?.startsWith('peer:'));
		if (d.edges.some((e) => live(e.source, e.sourceHandle)) || d.outputs.some((p) => live(p.node, p.handle))) {
			throw new Error(
				`“${d.name}” contains WebRTC room-specific routes. Disconnect those routes before reusing it; each new instance needs its own room.`
			);
		}
	}
}

export function makeIndependent(doc: GroupDocument, path: string[], id: string) {
	const n = scopeAt(doc, path).nodes.find((n) => n.id === id);
	if (n?.kind !== 'group') throw new Error('Select a group');
	n.data.definition = copyDefinition(doc, n.data.definition, true);
}

export function copyInstanceState(source: GroupDocument, sourcePath: string[], target: GroupDocument, targetPath: string[]) {
	const from = scopeAt(source, sourcePath);
	const to = scopeAt(target, targetPath);
	for (const n of from.nodes) {
		if (!to.nodes.some((other) => other.id === n.id)) continue;
		if (n.kind === 'group') copyInstanceState(source, [...sourcePath, n.id], target, [...targetPath, n.id]);
		else if (n.kind === 'plugin') {
			const state = source.pluginStates[runtimeId(source, sourcePath, n.id)];
			if (state) target.pluginStates[runtimeId(target, targetPath, n.id)] = { ...state };
		}
	}
}

/** Runtime captures must not overwrite another instance's plugin state. */
export function capturePluginStates(p: Pipeline): Pipeline {
	if (!p.groups) return p;
	const doc = structuredClone(p.groups);
	for (const n of p.nodes)
		if (n.kind === 'plugin' && (typeof n.data.state === 'string' || n.data.state === null)) {
			doc.pluginStates[n.id] = { path: String(n.data.path), pluginId: String(n.data.pluginId), state: n.data.state };
		}
	return { ...p, groups: doc };
}

export function assertLiveRestore(current: Pipeline, next: Pipeline) {
	for (const n of next.nodes) {
		const old = current.nodes.find((old) => old.id === n.id);
		if (
			n.kind === 'plugin' &&
			old?.kind === 'plugin' &&
			n.data.path === old.data.path &&
			n.data.pluginId === old.data.pluginId &&
			n.data.state !== old.data.state
		) {
			throw new Error('Stop the pipeline before restoring plugin state. The plugin host cannot restore opaque state during playback.');
		}
	}
}

export function patchRuntimeNode(p: Pipeline, id: string, patch: Record<string, unknown>): Pipeline {
	const doc = documentFor(p);
	function visit(d: GroupDefinition, path: string[]): boolean {
		for (const n of d.nodes) {
			if (n.kind === 'group') {
				if (visit(definition(doc, n.data.definition), [...path, n.id])) return true;
			} else if (runtimeId(doc, path, n.id) === id) {
				n.data = saveNodeData(doc, id, n, { ...effectiveNodeData(doc, id, n), ...patch } as PipelineNode['data']);
				return true;
			}
		}
		return false;
	}
	if (!visit(definition(doc, doc.root), [])) throw new Error(`Missing runtime node: ${id}`);
	return materialize(p, doc);
}
