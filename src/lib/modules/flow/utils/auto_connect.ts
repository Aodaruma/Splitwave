import type { Connection, Edge } from '@xyflow/svelte';
import { deriveSlots, parseHandle } from './channels';

export interface ChannelPortConfig {
	max: number;
	min: number;
	selfGrowing: boolean;
}

export interface AudioPorts {
	id: string;
	handles: { id: string | null; y: number }[];
	channels?: ChannelPortConfig;
	/** Group interfaces keep their user-defined order and stable handle IDs. */
	ordered?: { id: string; handle: string | null }[];
}

export function createsCycle(source: string, target: string, edges: Pick<Edge, 'source' | 'target'>[]): boolean {
	const outgoing = new Map<string, string[]>();
	for (const e of edges) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e.target]);
	const pending = [target];
	const visited = new Set<string>();
	while (pending.length) {
		const id = pending.pop()!;
		if (id === source) return true;
		if (visited.has(id)) continue;
		visited.add(id);
		pending.push(...(outgoing.get(id) ?? []));
	}
	return false;
}

function channelNumber(id: string | null): number | null {
	if (id === 'L') return 1;
	if (id === 'R') return 2;
	const ch = id ? parseHandle(id) : null;
	return ch !== null && ch > 0 ? ch : null;
}

function sourceHandles(source: AudioPorts, edges: Edge[]): (string | null)[] {
	if (source.ordered) return source.ordered.map((p) => p.id);
	const config = source.channels;
	if (config) {
		const incoming = edges.filter((e) => e.target === source.id).map((e) => e.targetHandle ?? '');
		const outgoing = edges.filter((e) => e.source === source.id).map((e) => e.sourceHandle ?? '');
		if (config.selfGrowing) {
			// Ignore the spare trailing socket when the stream already has channels.
			return deriveSlots([...incoming, ...outgoing], false, config.max, Math.max(1, config.min)).map((s) => s.id);
		}
		return deriveSlots(incoming, false, config.max, config.min)
			.filter((s) => s.occupied)
			.map((s) => s.id);
	}
	const handles = [...source.handles].sort((a, b) => a.y - b.y);
	const channels = handles.filter((h) => channelNumber(h.id) !== null);
	if (channels.length) return channels.map((h) => h.id);
	// Only the main bus is eligible; never guess a sidechain or a peer route.
	const main = handles.find((h) => h.id === null || h.id === 'main' || h.id === 'mixed');
	return main ? [main.id] : [];
}

export function planAutoConnect(source: AudioPorts, target: AudioPorts, edges: Edge[]): Connection[] {
	if (createsCycle(source.id, target.id, edges)) return [];
	const inputs = [...target.handles].sort((a, b) => a.y - b.y);
	const planned: Connection[] = [];
	const sources = sourceHandles(source, edges);
	for (const [index, sourceHandle] of sources.entries()) {
		const semantic = source.ordered?.find((p) => p.id === sourceHandle)?.handle ?? sourceHandle;
		const ch = channelNumber(semantic);
		let targetHandle: string | null | undefined;
		if (target.ordered) {
			const candidate = source.ordered ? target.ordered[index] : target.ordered.find((p) => channelNumber(p.handle) === ch);
			if (candidate && (channelNumber(candidate.handle) !== null) === (ch !== null)) targetHandle = candidate.id;
		} else if (ch !== null) {
			if (target.channels) {
				if (ch <= target.channels.max) targetHandle = `ch${ch}`;
			} else {
				targetHandle = inputs.find((h) => channelNumber(h.id) === ch)?.id;
			}
		} else {
			// A bus is not a single channel: do not silently downmix it into ch1.
			targetHandle = inputs.find((h) => h.id === null || h.id === 'main')?.id;
		}
		if (targetHandle === undefined) continue;
		const connection = { source: source.id, sourceHandle, target: target.id, targetHandle };
		if (
			[...edges, ...planned].some(
				(e) =>
					e.source === connection.source &&
					e.target === connection.target &&
					(e.sourceHandle ?? null) === sourceHandle &&
					(e.targetHandle ?? null) === targetHandle
			)
		)
			continue;
		planned.push(connection);
	}
	return planned;
}
