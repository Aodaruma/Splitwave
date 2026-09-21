import type { Edge, Node } from '@xyflow/svelte';
import type { AudioPorts } from './auto_connect';
import type { NodeCategory } from '../../pipeline/types';
import { createsCycle, planAutoConnect } from './auto_connect';
import { crossesWire, editableWire, type Point } from './wiring';

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
	hits: string[]
): { bundle: Edge[]; connections: { before: Edge; input: string; output: string }[] } | null {
	if (category !== 'effect' || node.type === 'plugin' || inputs.id !== node.id || outputs.id !== node.id) return null;
	if (edges.some((e) => e.source === node.id || e.target === node.id)) return null;
	if (!inputs.channels || !outputs.channels || inputs.ordered || outputs.ordered || inputs.channels.selfGrowing || outputs.channels.selfGrowing) return null;
	if (inputs.channels.max !== outputs.channels.max || [...inputs.handles, ...outputs.handles].some((p) => channel(p.id) === null)) return null;
	const touched = edges.filter((e) => hits.includes(e.id));
	if (!touched.length || touched.some((e) => e.source !== touched[0].source || e.target !== touched[0].target)) return null;
	const { source, target } = touched[0];
	if ([source, target].some((id) => !nodes.some((n) => n.id === id && n.type !== 'group' && n.type !== 'groupBoundary'))) return null;
	const bundle = edges.filter((e) => e.source === source && e.target === target);
	if (bundle.some((e) => !editableWire(e) || channel(e.sourceHandle) === null || channel(e.targetHandle) === null)) return null;
	if (
		new Set(bundle.map((e) => channel(e.sourceHandle))).size !== bundle.length ||
		new Set(bundle.map((e) => channel(e.targetHandle))).size !== bundle.length
	)
		return null;
	const remaining = edges.filter((e) => !bundle.includes(e));
	if (createsCycle(source, target, remaining)) return null;
	// Use the same channel/capacity matching as explicit body-to-body connection.
	const sourcePorts: AudioPorts = { id: source, handles: bundle.map((e, y) => ({ id: e.sourceHandle!, y })) };
	const planned = planAutoConnect(sourcePorts, inputs, remaining);
	if (planned.length !== bundle.length) return null;
	const connections = bundle.map((before) => {
		const input = planned.find((e) => e.sourceHandle === before.sourceHandle)!.targetHandle!;
		return { before, input, output: input };
	});
	return { bundle, connections };
}

export function applyWireInsertion(edges: Edge[], node: string, plan: NonNullable<ReturnType<typeof planWireInsertion>>, ids: string[]): Edge[] {
	return edges.flatMap((e) => {
		const index = plan.connections.findIndex((c) => c.before.id === e.id);
		if (index < 0) return [e];
		const { input, output } = plan.connections[index];
		return [
			{ id: ids[index], type: 'channel', source: e.source, sourceHandle: e.sourceHandle, target: node, targetHandle: input },
			{ ...e, source: node, sourceHandle: output }
		];
	});
}
