import type { Edge, Node } from '@xyflow/svelte';
import type { EdgeLayout, NodeCategory } from '../../pipeline/types';
import type { Point } from './wiring';

export type AlignmentAxis = 'horizontal' | 'vertical';

export function alignNodes(nodes: Node[], axis?: AlignmentAxis): Map<string, Point> {
	const chosen = nodes.filter((n) => n.selected && n.draggable !== false && n.type !== 'groupBoundary');
	if (chosen.length < 2 || chosen.some((n) => !n.measured?.width || !n.measured?.height)) return new Map();
	const left = Math.min(...chosen.map((n) => n.position.x));
	const top = Math.min(...chosen.map((n) => n.position.y));
	const right = Math.max(...chosen.map((n) => n.position.x + n.measured!.width!));
	const bottom = Math.max(...chosen.map((n) => n.position.y + n.measured!.height!));
	const horizontal = (axis ?? (right - left >= bottom - top ? 'horizontal' : 'vertical')) === 'horizontal';
	const size = (n: Node) => (horizontal ? n.measured!.width! : n.measured!.height!);
	const center = (n: Node) => (horizontal ? n.position.x : n.position.y) + size(n) / 2;
	chosen.sort((a, b) => center(a) - center(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const total = chosen.reduce((sum, n) => sum + size(n), 0);
	const gap = Math.max(24, ((horizontal ? right - left : bottom - top) - total) / (chosen.length - 1));
	let at = (horizontal ? (left + right) / 2 : (top + bottom) / 2) - (total + gap * (chosen.length - 1)) / 2;
	return new Map(
		chosen.map((n) => {
			const position = horizontal ? { x: at, y: (top + bottom - n.measured!.height!) / 2 } : { x: (left + right - n.measured!.width!) / 2, y: at };
			at += size(n) + gap;
			return [n.id, position];
		})
	);
}

export function planBulkBypass(
	nodes: Pick<Node, 'id' | 'type' | 'data' | 'selected'>[],
	registry: Record<string, { category: NodeCategory; defaultData: Record<string, unknown> }>
) {
	const eligible = nodes.filter(
		(n) => n.selected && n.type && registry[n.type]?.category === 'effect' && typeof registry[n.type].defaultData.bypassed === 'boolean'
	);
	const bypassed = eligible.some((n) => n.data.bypassed !== true);
	return eligible.filter((n) => n.data.bypassed !== bypassed).map((n) => ({ id: n.id, bypassed }));
}

export function translateEdgeLayout(data: EdgeLayout | undefined, offset: Point): EdgeLayout | undefined {
	return data ? { ...data, reroutes: data.reroutes?.map((p) => ({ x: p.x + offset.x, y: p.y + offset.y })) } : undefined;
}

export function withReroutePoints<T extends Edge>(edges: T[], id: string, points: Point[]): T[] {
	return edges.map((edge) => (edge.id === id ? { ...edge, data: { ...edge.data, reroutes: points } } : edge));
}

/** Rerouted cables are polylines so their visible path and insertion order agree exactly. */
export function reroutePath(source: Point, target: Point, points: Point[]): string {
	return [source, ...points, target].map((p, i) => `${i ? 'L' : 'M'} ${p.x},${p.y}`).join(' ');
}

export function insertReroute(source: Point, target: Point, points: Point[], point: Point): Point[] {
	const path = [source, ...points, target];
	let best = Infinity,
		index = 0;
	for (let i = 1; i < path.length; i++) {
		const a = path[i - 1],
			b = path[i];
		const dx = b.x - a.x,
			dy = b.y - a.y;
		const t = dx || dy ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
		const distance = Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
		if (distance < best) {
			best = distance;
			index = i - 1;
		}
	}
	return [...points.slice(0, index), { ...point }, ...points.slice(index)];
}
