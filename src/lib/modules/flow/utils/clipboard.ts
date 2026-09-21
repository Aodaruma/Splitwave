import type { Edge, Node, XYPosition } from '@xyflow/svelte';
import type { ClipboardEntry } from '../../pipeline/stores.svelte';
import type { NodeKind } from '../../pipeline/types';
import { translateEdgeLayout } from './layout';

export function copyGraph(nodes: Node[], edges: Edge[]): ClipboardEntry | null {
	if (!nodes.length) return null;
	const origin = { x: Math.min(...nodes.map((n) => n.position.x)), y: Math.min(...nodes.map((n) => n.position.y)) };
	const index = new Map(nodes.map((n, i) => [n.id, i]));
	return {
		origin,
		nodes: nodes.map((n) => ({
			kind: n.type as NodeKind,
			data: structuredClone(n.data),
			dx: n.position.x - origin.x,
			dy: n.position.y - origin.y,
			width: n.width ?? n.initialWidth,
			height: n.height ?? n.initialHeight
		})),
		edges: edges.flatMap((e) => {
			const source = index.get(e.source);
			const target = index.get(e.target);
			if (source === undefined || target === undefined) return [];
			// WebRTC outputs belong to a live session, not the copied node.
			if (e.sourceHandle?.startsWith('peer:') || (nodes[source].type === 'webRtcCollaborator' && e.sourceHandle === 'mixed')) return [];
			return [
				{
					source,
					target,
					sourceHandle: e.sourceHandle ?? undefined,
					targetHandle: e.targetHandle ?? undefined,
					data: translateEdgeLayout(e.data, { x: -origin.x, y: -origin.y })
				}
			];
		})
	};
}

export function offsetOrigin(origin: XYPosition, gridSize?: number): XYPosition {
	const offset = gridSize ? Math.ceil(50 / gridSize) * gridSize : 50;
	return { x: origin.x + offset, y: origin.y + offset };
}

/** IDs are supplied by the editor so graph construction has no side effects. */
export function pasteGraph(
	entry: ClipboardEntry,
	origin: XYPosition,
	nodeIds: string[],
	edgeIds: string[],
	gridSize?: number
): { nodes: Node[]; edges: Edge[] } {
	return {
		nodes: entry.nodes.map((n, i) => {
			const data = structuredClone(n.data);
			// Registration and recording destinations must have a single owner.
			if (n.kind === 'mute') {
				delete data.hotkey;
				if (data.pushToTalk) data.muted = true;
			}
			if (n.kind === 'fileRecording') data.filePath = null;
			const x = origin.x + n.dx;
			const y = origin.y + n.dy;
			return {
				id: nodeIds[i],
				type: n.kind,
				position: { x: gridSize ? Math.round(x / gridSize) * gridSize : x, y: gridSize ? Math.round(y / gridSize) * gridSize : y },
				data,
				...(n.width != null && { width: n.width }),
				...(n.height != null && { height: n.height }),
				selected: true
			};
		}),
		edges: entry.edges.map((e, i) => ({
			id: edgeIds[i],
			type: 'channel',
			source: nodeIds[e.source],
			sourceHandle: e.sourceHandle,
			target: nodeIds[e.target],
			targetHandle: e.targetHandle,
			data: translateEdgeLayout(e.data, origin)
		}))
	};
}
