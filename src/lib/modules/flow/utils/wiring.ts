import type { Edge, Node } from '@xyflow/svelte';
import { createsCycle, type AudioPorts } from './auto_connect';
import { parseHandle } from './channels';

export interface Point {
	x: number;
	y: number;
}

type Matrix = Pick<DOMMatrix, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'>;
type PathGeometry = Pick<SVGPathElement, 'getTotalLength' | 'getPointAtLength'>;

/** Sample the rendered curve in CSS pixels, including SVG and viewport transforms. */
export function screenPath(path: PathGeometry, matrix: Matrix, spacing = 2): Point[] {
	const length = path.getTotalLength();
	const scale = Math.hypot(matrix.a, matrix.b, matrix.c, matrix.d);
	if (!Number.isFinite(length * scale) || spacing <= 0) return [];
	const steps = Math.max(1, Math.ceil((length * scale) / spacing));
	return Array.from({ length: steps + 1 }, (_, i) => {
		const p = path.getPointAtLength((length * i) / steps);
		return { x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f };
	});
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x,
		dy = b.y - a.y;
	const length = dx * dx + dy * dy;
	const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
	return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function crossesWire(a: Point, b: Point, wire: readonly Point[], tolerance = 1): boolean {
	const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
	for (let i = 1; i < wire.length; i++) {
		const c = wire[i - 1],
			d = wire[i];
		if (
			Math.max(a.x, b.x) + tolerance < Math.min(c.x, d.x) ||
			Math.min(a.x, b.x) - tolerance > Math.max(c.x, d.x) ||
			Math.max(a.y, b.y) + tolerance < Math.min(c.y, d.y) ||
			Math.min(a.y, b.y) - tolerance > Math.max(c.y, d.y)
		)
			continue;
		if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true;
		if (Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b)) <= tolerance) return true;
	}
	return false;
}

export function editableWire(edge: Edge): boolean {
	return edge.deletable !== false && !edge.source.startsWith('$group-') && !edge.target.startsWith('$group-');
}

export function detachNodes(edges: Edge[], moved: Pick<Node, 'id' | 'type'>[]): Edge[] {
	const ids = new Set(moved.filter((n) => n.type !== 'groupBoundary').map((n) => n.id));
	return edges.filter((e) => !editableWire(e) || (!ids.has(e.source) && !ids.has(e.target)));
}

export function assertRewireAcyclic(before: Pick<Edge, 'id' | 'source' | 'target'>[], after: Pick<Edge, 'id' | 'source' | 'target'>[]) {
	const previous = new Map(before.map((e) => [e.id, e]));
	for (const edge of after) {
		const old = previous.get(edge.id);
		if (old?.source === edge.source && old.target === edge.target) continue;
		if (
			createsCycle(
				edge.source,
				edge.target,
				after.filter((e) => e.id !== edge.id)
			)
		)
			throw new Error('Input switching would create an audio routing cycle.');
	}
}

function portKind(handle: string | null): string {
	if (handle === 'L' || handle === 'R' || (handle && (parseHandle(handle) ?? 0) > 0)) return 'channel';
	if (handle === null || handle === 'main' || handle === 'mixed') return 'bus';
	return `role:${handle}`;
}

/** Rotate whole input bundles; channel numbers (including L/R) are deliberately interchangeable. */
export function switchInputs(target: AudioPorts, edges: Edge[], outputs?: AudioPorts): Edge[] {
	const ports =
		target.ordered ?? [...target.handles].sort((a, b) => a.y - b.y || String(a.id).localeCompare(String(b.id))).map((p) => ({ id: p.id, handle: p.id }));
	const families = new Map<string, (string | null)[]>();
	for (const p of ports) {
		const ch = p.handle ? parseHandle(p.handle) : null;
		if (target.channels && ch !== null && ch > target.channels.max) continue;
		const kind = portKind(p.handle);
		families.set(kind, [...(families.get(kind) ?? []), p.id]);
	}
	const incoming = edges.filter((e) => e.target === target.id);
	const mapping = new Map<string | null, string | null>();
	for (const family of families.values()) {
		// Exposed boundary mappings are part of the group interface, not editable cables.
		const available = family.filter((id) => !incoming.some((e) => (e.targetHandle ?? null) === id && !editableWire(e)));
		const linked = available.filter((id) => incoming.some((e) => (e.targetHandle ?? null) === id));
		const cycle = linked.length === 1 ? available : linked;
		if (cycle.length < 2) continue;
		for (const id of linked) mapping.set(id, cycle[(cycle.indexOf(id) + 1) % cycle.length]);
	}
	if (!mapping.size) return edges;
	const next = edges.map((e) =>
		e.target === target.id && mapping.has(e.targetHandle ?? null) ? { ...e, targetHandle: mapping.get(e.targetHandle ?? null)! } : e
	);
	// Moving the only feed must not strand an existing pass-through output socket.
	if (outputs?.channels && !outputs.channels.selfGrowing) {
		const fed = new Set(next.filter((e) => e.target === target.id).map((e) => e.targetHandle));
		if (edges.some((e) => e.source === target.id && e.sourceHandle && parseHandle(e.sourceHandle) !== null && !fed.has(e.sourceHandle))) return edges;
	}
	return next;
}

/** Three substantial reversals on either axis within 700 ms; one trigger per drag. */
export function shakeDetector(start: Point, time: number) {
	const axes = [
		{ origin: start.x, extreme: start.x, direction: 0, turns: [] as number[] },
		{ origin: start.y, extreme: start.y, direction: 0, turns: [] as number[] }
	];
	let lastTime = time,
		triggered = false;
	return (point: Point, now: number, allowed = true): boolean => {
		if (triggered) return false;
		const reset = !allowed || now - lastTime > 700 || now < lastTime;
		lastTime = now;
		for (const [i, value] of [point.x, point.y].entries()) {
			const axis = axes[i];
			if (reset) {
				Object.assign(axis, { origin: value, extreme: value, direction: 0, turns: [] });
				continue;
			}
			axis.turns = axis.turns.filter((t) => now - t <= 700);
			if (!axis.direction) {
				if (Math.abs(value - axis.origin) >= 24) {
					axis.direction = Math.sign(value - axis.origin);
					axis.extreme = value;
				}
			} else if ((value - axis.extreme) * axis.direction > 0) axis.extreme = value;
			else if ((axis.extreme - value) * axis.direction >= 24) {
				axis.direction *= -1;
				axis.extreme = value;
				axis.turns.push(now);
				if (axis.turns.length >= 3) triggered = true;
			}
		}
		return triggered;
	};
}
