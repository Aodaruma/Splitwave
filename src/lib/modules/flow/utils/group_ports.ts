import type { Connection, Edge } from '@xyflow/svelte';
import { createId } from '@paralleldrive/cuid2';
import { scopeAt, type GroupDocument, type GroupDefinition } from '../../pipeline/groups';
import { BOUNDARY_INPUT, BOUNDARY_OUTPUT } from './group_view';

export const NEW_GROUP_PORT = '$new-port';
export type PortSide = 'inputs' | 'outputs';

export function boundaryPort(connection: Connection | Edge): { side: PortSide; node: string; handle?: string } | null {
	if (connection.source === BOUNDARY_INPUT && connection.sourceHandle === NEW_GROUP_PORT && !connection.target.startsWith('$group-'))
		return { side: 'inputs', node: connection.target, handle: connection.targetHandle ?? undefined };
	if (connection.target === BOUNDARY_OUTPUT && connection.targetHandle === NEW_GROUP_PORT && !connection.source.startsWith('$group-'))
		return { side: 'outputs', node: connection.source, handle: connection.sourceHandle ?? undefined };
	return null;
}

export function exposePort(d: GroupDefinition, side: PortSide, node: string, handle: string | undefined, label: string): boolean {
	if (!d.nodes.some((n) => n.id === node)) throw new Error('The group port must connect to an interior node.');
	if (d[side].some((p) => p.node === node && p.handle === handle)) return false;
	d[side].push({ id: createId(), node, handle, label });
	return true;
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
