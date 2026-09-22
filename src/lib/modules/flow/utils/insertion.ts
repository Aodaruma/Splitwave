import type { Edge, Node } from '@xyflow/svelte';
import type { AudioPorts } from './auto_connect';
import type { NodeCategory } from '../../pipeline/types';
import { createsCycle } from './auto_connect';
import { crossesWire, editableWire, type Point } from './wiring';
import { definition, runtimeId, scopeAt, type GroupDocument, type GroupDefinition } from '../../pipeline/groups';
import { BOUNDARY_INPUT, BOUNDARY_OUTPUT, saveGroupView } from './group_view';
import { boundaryPort } from './group_ports';

/** Resolve stable group socket IDs to the underlying channel, including nested boundaries. */
export function insertionHandles(doc: GroupDocument, path: string[]) {
	const scope = scopeAt(doc, path);
	const locals = new Map(scope.nodes.map((n) => [n.kind === 'group' ? n.id : runtimeId(doc, path, n.id), n.id]));
	function resolve(d: GroupDefinition, id: string, side: 'source' | 'target', handle: string | null | undefined): string | null {
		const node = d.nodes.find((n) => n.id === id);
		if (!node) return null;
		if (node.kind !== 'group') return handle ?? null;
		const inner = definition(doc, node.data.definition);
		const port = inner[side === 'source' ? 'outputs' : 'inputs'].find((p) => p.id === handle && !p.disconnected);
		return port ? resolve(inner, port.node, side, port.handle) : null;
	}
	return (id: string, side: 'source' | 'target', handle: string | null | undefined): string | null => {
		if (id === BOUNDARY_INPUT || id === BOUNDARY_OUTPUT) {
			const input = id === BOUNDARY_INPUT;
			const port = scope[input ? 'inputs' : 'outputs'].find((p) => p.id === handle && !p.disconnected);
			return port ? resolve(scope, port.node, input ? 'target' : 'source', port.handle) : null;
		}
		return resolve(scope, locals.get(id) ?? id, side, handle);
	};
}

export function wireHitsBounds(points: Point[], bounds: { x: number; y: number; width: number; height: number }): boolean {
	const { x, y, width, height } = bounds;
	if (points.some((p) => p.x >= x && p.x <= x + width && p.y >= y && p.y <= y + height)) return true;
	const corners = [
		{ x, y },
		{ x: x + width, y },
		{ x: x + width, y: y + height },
		{ x, y: y + height }
	];
	return corners.some((p, i) => crossesWire(p, corners[(i + 1) % 4], points, 0));
}

function channel(handle: string | null | undefined): number | null {
	if (handle === 'L') return 1;
	if (handle === 'R') return 2;
	const match = /^ch([1-9]\d*)$/.exec(handle ?? '');
	return match ? Number(match[1]) : null;
}

/** A whole endpoint bundle or nothing: never merge fan-in into a new effect input. */
export function planWireInsertion(
	node: Pick<Node, 'id' | 'type'>,
	category: NodeCategory | undefined,
	inputs: AudioPorts,
	outputs: AudioPorts,
	nodes: Pick<Node, 'id' | 'type'>[],
	edges: Edge[],
	hits: string[],
	resolveHandle?: ReturnType<typeof insertionHandles>
): { bundle: Edge[]; connections: { before: Edge; input: string; output: string }[] } | null {
	if ((category !== 'effect' && category !== 'monitor') || node.type === 'plugin' || inputs.id !== node.id || outputs.id !== node.id) return null;
	if (edges.some((e) => e.source === node.id || e.target === node.id)) return null;
	if (!inputs.channels || !outputs.channels || inputs.ordered || outputs.ordered || inputs.channels.selfGrowing || outputs.channels.selfGrowing) return null;
	if (inputs.channels.max !== outputs.channels.max || [...inputs.handles, ...outputs.handles].some((p) => channel(p.id) === null)) return null;
	const touched = edges.filter((e) => hits.includes(e.id));
	if (!touched.length || touched.some((e) => e.source !== touched[0].source || e.target !== touched[0].target)) return null;
	const { source, target } = touched[0];
	if ([source, target].some((id) => !nodes.some((n) => n.id === id && (resolveHandle || (n.type !== 'group' && n.type !== 'groupBoundary'))))) return null;
	const bundle = edges.filter((e) => e.source === source && e.target === target);
	const channels = bundle.map((e) => ({
		before: e,
		source: channel(resolveHandle ? resolveHandle(e.source, 'source', e.sourceHandle) : e.sourceHandle),
		target: channel(resolveHandle ? resolveHandle(e.target, 'target', e.targetHandle) : e.targetHandle)
	}));
	if (bundle.some((e) => !editableWire(e) && !(resolveHandle && boundaryPort(e)))) return null;
	if (channels.some((c) => c.source === null || c.target === null || c.source > inputs.channels!.max)) return null;
	if (new Set(channels.map((c) => c.source)).size !== bundle.length || new Set(channels.map((c) => c.target)).size !== bundle.length) return null;
	const remaining = edges.filter((e) => !bundle.includes(e));
	if (createsCycle(source, target, remaining)) return null;
	const connections = channels.map(({ before, source }) => ({ before, input: `ch${source}`, output: `ch${source}` }));
	return { bundle, connections };
}

export function applyWireInsertion(edges: Edge[], node: string, plan: NonNullable<ReturnType<typeof planWireInsertion>>, ids: string[]): Edge[] {
	return edges.flatMap((e) => {
		const index = plan.connections.findIndex((c) => c.before.id === e.id);
		if (index < 0) return [e];
		const { input, output } = plan.connections[index];
		if (boundaryPort(e)?.side === 'inputs')
			return [
				{ ...e, target: node, targetHandle: input },
				{ id: ids[index], type: 'channel', source: node, sourceHandle: output, target: e.target, targetHandle: e.targetHandle }
			];
		return [
			{ id: ids[index], type: 'channel', source: e.source, sourceHandle: e.sourceHandle, target: node, targetHandle: input },
			{ ...e, source: node, sourceHandle: output }
		];
	});
}

/** Boundary wires are views of stored port mappings; keep their IDs and outside connections. */
export function saveWireInsertion(
	doc: GroupDocument,
	path: string[],
	nodes: Node[],
	edges: Edge[],
	node: string,
	plan: NonNullable<ReturnType<typeof planWireInsertion>>,
	ids: string[]
): Edge[] {
	const next = applyWireInsertion(edges, node, plan, ids);
	saveGroupView(doc, path, nodes, next);
	const d = scopeAt(doc, path);
	const local = d.nodes.find((n) => (n.kind === 'group' ? n.id : runtimeId(doc, path, n.id)) === node)?.id;
	if (!local) throw new Error('The inserted node is no longer in this group.');
	for (const { before, input, output } of plan.connections) {
		const mapping = boundaryPort(before);
		if (!mapping?.port) continue;
		const port = d[mapping.side].find((p) => p.id === mapping.port);
		if (!port || port.disconnected) throw new Error('The group port changed during insertion.');
		port.node = local;
		port.handle = mapping.side === 'inputs' ? input : output;
	}
	return next;
}
