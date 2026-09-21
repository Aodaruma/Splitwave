import type { Edge, Node } from '@xyflow/svelte';
import { createId } from '@paralleldrive/cuid2';
import { definition, effectiveNodeData, runtimeId, saveNodeData, scopeAt, type EditorNode, type GroupDocument } from '../../pipeline/groups';
import { withDefaults } from '../../pipeline/defaults';
import type { PipelineNode } from '../../pipeline/types';

export const GROUP_ACTIONS = 'splitwave:group-actions';
export const BOUNDARY_INPUT = '$group-input';
export const BOUNDARY_OUTPUT = '$group-output';

export function groupView(doc: GroupDocument, path: string[]): { nodes: Node[]; edges: Edge[] } {
	const d = scopeAt(doc, path);
	const id = (local: string) => (d.nodes.find((n) => n.id === local)?.kind === 'group' ? local : runtimeId(doc, path, local));
	const nodes: Node[] = d.nodes.map((n) => {
		const inner = n.kind === 'group' ? definition(doc, n.data.definition) : null;
		return {
			id: id(n.id),
			type: n.kind,
			position: { ...n.position },
			data:
				n.kind === 'group'
					? { definition: inner!.id, name: inner!.name, inputs: inner!.inputs, outputs: inner!.outputs }
					: structuredClone(withDefaults(n.kind, effectiveNodeData(doc, id(n.id), n))),
			...('width' in n ? { width: n.width, height: n.height } : {})
		};
	});
	const edges: Edge[] = d.edges.map((e) => ({ ...structuredClone(e), source: id(e.source), target: id(e.target), type: 'channel' }));
	if (path.length) {
		for (const [side, boundary, type, x] of [
			['inputs', BOUNDARY_INPUT, 'source', -200],
			['outputs', BOUNDARY_OUTPUT, 'target', 700]
		] as const) {
			nodes.push({
				id: boundary,
				type: 'groupBoundary',
				position: { x, y: 100 },
				data: { name: side === 'inputs' ? 'Group inputs' : 'Group outputs', ports: d[side], side: type },
				deletable: false
			});
			for (const p of d[side])
				edges.push({
					id: `${boundary}:${p.id}`,
					type: 'channel',
					deletable: false,
					...(side === 'inputs'
						? { source: boundary, sourceHandle: p.id, target: id(p.node), targetHandle: p.handle }
						: { source: id(p.node), sourceHandle: p.handle, target: boundary, targetHandle: p.id })
				});
		}
	}
	return { nodes, edges };
}

export function saveGroupView(doc: GroupDocument, path: string[], nodes: Node[], edges: Edge[]) {
	const d = scopeAt(doc, path);
	const locals = new Map(d.nodes.map((n) => [n.kind === 'group' ? n.id : runtimeId(doc, path, n.id), n.id]));
	const local = (id: string) => locals.get(id) ?? id;
	d.nodes = nodes
		.filter((n) => n.type !== 'groupBoundary')
		.map((n): EditorNode => {
			const original = d.nodes.find((old) => old.id === local(n.id));
			if (!original && n.type !== 'group' && path.length) locals.set(n.id, createId());
			const base = { id: local(n.id), position: { ...n.position }, ...(original?.identity ? { identity: original.identity } : {}) };
			if (!original && n.type !== 'group') {
				const provisional = { ...base, kind: n.type, data: n.data } as EditorNode;
				d.nodes.push(provisional);
				const generated = runtimeId(doc, path, provisional.id);
				for (const key of Object.keys(doc.runtimeIds)) if (doc.runtimeIds[key] === generated) doc.runtimeIds[key] = n.id;
			}
			if (n.type === 'group') return { ...base, kind: 'group', data: { definition: String(n.data.definition) } };
			const data = structuredClone(n.data) as PipelineNode['data'];
			return {
				...base,
				kind: n.type,
				data: original && original.kind !== 'group' && original.kind === n.type ? saveNodeData(doc, n.id, original, data) : data,
				...(n.width != null ? { width: n.width } : {}),
				...(n.height != null ? { height: n.height } : {})
			} as EditorNode;
		});
	d.edges = edges
		.filter((e) => !e.source.startsWith('$group-') && !e.target.startsWith('$group-'))
		.map((e) => ({
			...d.edges.find((old) => old.id === e.id),
			id: e.id,
			source: local(e.source),
			target: local(e.target),
			sourceHandle: e.sourceHandle ?? undefined,
			targetHandle: e.targetHandle ?? undefined,
			data: e.data ? structuredClone(e.data) : undefined
		}));
}
