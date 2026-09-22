import type { Connection, Edge } from '@xyflow/svelte';
import { createId } from '@paralleldrive/cuid2';
import { scopeAt, type GroupDocument, type GroupDefinition } from '../../pipeline/groups';
import { BOUNDARY_INPUT, BOUNDARY_OUTPUT } from './group_view';

export const NEW_GROUP_PORT = '$new-port';
export type PortSide = 'inputs' | 'outputs';

export function addPort(d: GroupDefinition, side: PortSide): string {
	const prefix = side === 'inputs' ? 'Input' : 'Output';
	let number = 1;
	while (d[side].some((p) => p.label === `${prefix} ${number}`)) number++;
	const id = createId();
	d[side].push({ id, label: `${prefix} ${number}`, node: '', disconnected: true });
	return id;
}

export function reorderPort(d: GroupDefinition, side: PortSide, id: string, target: string) {
	const ports = d[side];
	const from = ports.findIndex((p) => p.id === id);
	const to = ports.findIndex((p) => p.id === target);
	if (from < 0 || to < 0 || from === to) return;
	ports.splice(to, 0, ports.splice(from, 1)[0]);
}

export function boundaryPort(connection: Connection | Edge): { side: PortSide; node: string; handle?: string; port?: string } | null {
	if (connection.source === BOUNDARY_INPUT && connection.sourceHandle && !connection.target.startsWith('$group-'))
		return {
			side: 'inputs',
			node: connection.target,
			handle: connection.targetHandle ?? undefined,
			...(connection.sourceHandle !== NEW_GROUP_PORT ? { port: connection.sourceHandle } : {})
		};
	if (connection.target === BOUNDARY_OUTPUT && connection.targetHandle && !connection.source.startsWith('$group-'))
		return {
			side: 'outputs',
			node: connection.source,
			handle: connection.sourceHandle ?? undefined,
			...(connection.targetHandle !== NEW_GROUP_PORT ? { port: connection.targetHandle } : {})
		};
	return null;
}

export function exposePort(d: GroupDefinition, side: PortSide, node: string, handle: string | undefined, label: string, portId?: string): boolean {
	if (!d.nodes.some((n) => n.id === node)) throw new Error('The group port must connect to an interior node.');
	if (d[side].some((p) => !p.disconnected && p.node === node && p.handle === handle)) return false;
	const port = portId ? d[side].find((p) => p.id === portId) : undefined;
	if (portId && (!port || !port.disconnected)) throw new Error('Only a disconnected group port can be reconnected.');
	if (port) {
		port.node = node;
		port.handle = handle;
		delete port.disconnected;
		return true;
	}
	d[side].push({ id: createId(), node, handle, label });
	return true;
}

export function cutGroupWires(doc: GroupDocument, path: string[], edges: Edge[], hits: ReadonlySet<string>) {
	const d = scopeAt(doc, path);
	d.edges = d.edges.filter((e) => !hits.has(e.id));
	for (const edge of edges) {
		if (!hits.has(edge.id)) continue;
		const mapping = boundaryPort(edge);
		if (!mapping?.port) continue;
		const port = d[mapping.side].find((p) => p.id === mapping.port);
		if (port) port.disconnected = true;
	}
}

export function editPort(d: GroupDefinition, side: PortSide, id: string, action: string, label?: string) {
	const ports = d[side];
	const index = ports.findIndex((p) => p.id === id);
	if (index < 0) return;
	if (action === 'label') ports[index].label = label?.trim() || 'Audio';
	else if (action === 'remove') ports.splice(index, 1);
	else {
		const to = index + (action === 'up' ? -1 : 1);
		if (to >= 0 && to < ports.length) [ports[index], ports[to]] = [ports[to], ports[index]];
	}
}

/** History may refer to a group removed by Undo; stay at its nearest surviving parent. */
export function survivingGroupPath(doc: GroupDocument, path: string[]): string[] {
	const valid: string[] = [];
	for (const id of path) {
		if (!scopeAt(doc, valid).nodes.some((node) => node.id === id && node.kind === 'group')) break;
		valid.push(id);
	}
	return valid;
}
