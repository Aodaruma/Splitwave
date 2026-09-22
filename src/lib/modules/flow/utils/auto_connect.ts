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
	/** Stable group port IDs, in display order, with their underlying audio handles. */
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
	if (source.ordered) return source.ordered.filter((p) => channelNumber(p.handle) !== null || isMainBus(p.handle, true)).map((p) => p.id);
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

function isMainBus(handle: string | null, output = false): boolean {
	return handle === null || handle === 'main' || (output && handle === 'mixed');
}

/** Audio sockets suitable for a group interface; spare channel sockets are omitted. */
export function exposedAudioHandles(ports: AudioPorts, side: 'source' | 'target', edges: Edge[]): (string | null)[] {
	if (side === 'source') return sourceHandles(ports, edges);
	if (ports.ordered) return ports.ordered.filter((p) => channelNumber(p.handle) !== null || isMainBus(p.handle)).map((p) => p.id);
	if (ports.channels) {
		const occupied = edges.filter((e) => e.target === ports.id).map((e) => e.targetHandle ?? '');
		return deriveSlots(occupied, false, ports.channels.max, Math.max(1, ports.channels.min)).map((slot) => slot.id);
	}
	return [...ports.handles]
		.sort((a, b) => a.y - b.y)
		.filter((h) => channelNumber(h.id) !== null || isMainBus(h.id))
		.map((h) => h.id);
}

export function planAutoConnect(source: AudioPorts, target: AudioPorts, edges: Edge[]): Connection[] {
	if (createsCycle(source.id, target.id, edges)) return [];
	const inputs = [...target.handles].sort((a, b) => a.y - b.y);
	const planned: Connection[] = [];
	const matched = new Set<string>();
	for (const sourceHandle of sourceHandles(source, edges)) {
		const port = source.ordered?.find((p) => p.id === sourceHandle);
		const ch = channelNumber(port ? port.handle : sourceHandle);
		let targetHandle: string | null | undefined;
		if (target.ordered) {
			const candidate = target.ordered.find((p) => !matched.has(p.id) && (ch !== null ? channelNumber(p.handle) === ch : isMainBus(p.handle)));
			if (candidate) {
				targetHandle = candidate.id;
				matched.add(candidate.id);
			}
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
