import { describe, expect, it } from 'bun:test';
import type { Edge, Node } from '@xyflow/svelte';
import { copyGraph, offsetOrigin, pasteGraph } from '../src/lib/modules/flow/utils/clipboard';
import { createsCycle, planAutoConnect, type AudioPorts } from '../src/lib/modules/flow/utils/auto_connect';
import { canvasShortcut } from '../src/lib/modules/flow/utils/shortcuts';

const node = (id: string, type = 'gain', data: Record<string, unknown> = {}): Node => ({ id, type, position: { x: 0, y: 0 }, data });
const edge = (source: string, target: string, sourceHandle = 'ch1', targetHandle = sourceHandle): Edge => ({
	id: `${source}-${sourceHandle}-${target}-${targetHandle}`,
	source,
	target,
	sourceHandle,
	targetHandle
});
const fixed = (id: string, handles: (string | null)[]): AudioPorts => ({ id, handles: handles.map((id, y) => ({ id, y })) });
const growing = (id: string, max = Infinity, selfGrowing = false, min = 0): AudioPorts => ({ id, handles: [], channels: { max, min, selfGrowing } });

describe('canvas shortcuts', () => {
	it('accepts Ctrl/Cmd+D and Shift+Tab only in the canvas keyboard scope', () => {
		const key = { key: 'Tab', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false };
		expect(canvasShortcut(key, true)).toBe('toggleGrid');
		expect(canvasShortcut(key, false)).toBeNull();
		expect(canvasShortcut({ ...key, shiftKey: false }, true)).toBeNull();
		expect(canvasShortcut({ ...key, ctrlKey: true }, true)).toBeNull();
		expect(canvasShortcut({ ...key, altKey: true }, true)).toBeNull();
		for (const modifier of ['ctrlKey', 'metaKey'] as const) {
			const duplicate = { ...key, key: 'd', shiftKey: false, [modifier]: true };
			expect(canvasShortcut(duplicate, true)).toBe('duplicate');
			expect(canvasShortcut(duplicate, false)).toBeNull();
			expect(canvasShortcut({ ...duplicate, altKey: true }, true)).toBeNull();
		}
	});
});

describe('copy and duplicate graphs', () => {
	it('deep-copies data, geometry and internal wiring using only the supplied new IDs', () => {
		const nodes = [
			{
				...node('eq', 'eq', { gains: [1, 2], custom: { enabled: true } }),
				position: { x: 10, y: 30 },
				width: 240,
				height: 160,
				selected: true,
				dragging: true
			},
			{ ...node('out', 'speaker'), position: { x: 310, y: 90 } }
		];
		const edges = [edge('eq', 'out', 'ch1'), edge('eq', 'out', 'ch2'), edge('outside', 'eq')];
		const entry = copyGraph(nodes, edges)!;
		const before = structuredClone(entry);
		const copy = pasteGraph(entry, offsetOrigin(entry.origin), ['new-eq', 'new-out'], ['new-L', 'new-R']);
		expect(copy.nodes.map((n) => n.id)).toEqual(['new-eq', 'new-out']);
		expect(copy.nodes.map((n) => n.position)).toEqual([
			{ x: 60, y: 80 },
			{ x: 360, y: 140 }
		]);
		expect(copy.nodes[0]).toMatchObject({ width: 240, height: 160, selected: true, data: nodes[0].data });
		expect(copy.nodes[0]).not.toHaveProperty('dragging');
		expect(copy.edges).toEqual([
			{ ...edge('new-eq', 'new-out', 'ch1'), id: 'new-L', type: 'channel' },
			{ ...edge('new-eq', 'new-out', 'ch2'), id: 'new-R', type: 'channel' }
		]);
		(copy.nodes[0].data.gains as number[])[0] = 99;
		(copy.nodes[0].data.custom as { enabled: boolean }).enabled = false;
		expect(nodes[0].data.gains).toEqual([1, 2]);
		expect(entry).toEqual(before);
		expect(nodes[0].selected).toBe(true);
		expect(nodes[0].position).toEqual({ x: 10, y: 30 });
	});

	it('snaps only new positions, and repeated duplication keeps moving by whole grid steps', () => {
		const original = { ...node('a'), position: { x: 13, y: -8 } };
		const entry = copyGraph([original], [])!;
		const first = pasteGraph(entry, offsetOrigin(entry.origin, 20), ['b'], [], 20);
		expect(first.nodes[0].position).toEqual({ x: 80, y: 60 });
		const next = copyGraph(first.nodes, [])!;
		const second = pasteGraph(next, offsetOrigin(next.origin, 20), ['c'], [], 20);
		expect(second.nodes[0].position).toEqual({ x: 140, y: 120 });
		expect(original.position).toEqual({ x: 13, y: -8 });
		expect(offsetOrigin({ x: 0, y: 0 }, 40)).toEqual({ x: 80, y: 80 });
	});

	it('does not share hotkey registrations, recording destinations or held push-to-talk state', () => {
		const nodes = [
			node('m', 'mute', { hotkey: 'Ctrl+M', pushToTalk: true, muted: false, cueEnabled: true }),
			node('r', 'fileRecording', { filePath: 'C:/record.wav', format: { kind: 'wav', bitDepth: 'f32' }, channels: 2 }),
			node('p', 'plugin', { path: 'plugin.clap', pluginId: 'eq', state: 'saved-state', bypassed: false }),
			node('f', 'audioFile', { filePath: 'C:/input.wav', loopEnabled: true })
		];
		const entry = copyGraph(nodes, [])!;
		const copies = pasteGraph(entry, { x: 50, y: 50 }, ['m2', 'r2', 'p2', 'f2'], []).nodes;
		expect(copies[0].data).toEqual({ pushToTalk: true, muted: true, cueEnabled: true });
		expect(copies[1].data).toEqual({ ...nodes[1].data, filePath: null });
		expect(copies[2].data).toEqual(nodes[2].data);
		expect(copies[3].data).toEqual(nodes[3].data);
		expect(entry.nodes[0].data.hotkey).toBe('Ctrl+M');
		expect(nodes[1].data.filePath).toBe('C:/record.wav');
	});

	it('omits live peer routes and accepts an empty selection', () => {
		expect(copyGraph([], [])).toBeNull();
		const entry = copyGraph(
			[node('rtc', 'webRtcCollaborator'), node('out')],
			[edge('rtc', 'out', 'peer:session:0', 'ch1'), edge('rtc', 'out', 'mixed', 'ch2')]
		);
		expect(entry?.edges).toEqual([]);
	});
});

describe('automatic audio connections', () => {
	it('matches reordered group ports by channel and then display order without crossing L/R', () => {
		const source: AudioPorts = {
			id: 'group-out',
			handles: [],
			ordered: [
				{ id: 'first-left', handle: 'L' },
				{ id: 'right', handle: 'ch2' },
				{ id: 'second-left', handle: 'ch1' }
			]
		};
		const target: AudioPorts = {
			id: 'group-in',
			handles: [],
			ordered: [
				{ id: 'right-input', handle: 'R' },
				{ id: 'left-input', handle: 'ch1' },
				{ id: 'other-left', handle: 'L' }
			]
		};
		const planned = planAutoConnect(source, target, []);
		expect(planned.map((e) => [e.sourceHandle, e.targetHandle])).toEqual([
			['first-left', 'left-input'],
			['right', 'right-input'],
			['second-left', 'other-left']
		]);
		expect(
			planAutoConnect(
				source,
				target,
				planned.map((e, i) => ({ ...e, id: String(i) }))
			)
		).toEqual([]);
	});

	it('keeps null group buses distinct from sidechains, peer routes and individual channels', () => {
		const source: AudioPorts = {
			id: 'group-out',
			handles: [],
			ordered: [
				{ id: 'peer', handle: 'peer:p:0' },
				{ id: 'audio', handle: null }
			]
		};
		const target: AudioPorts = {
			id: 'group-in',
			handles: [],
			ordered: [
				{ id: 'key', handle: 'sidechain' },
				{ id: 'left', handle: 'ch1' },
				{ id: 'audio-input', handle: null }
			]
		};
		expect(planAutoConnect(source, target, []).map((e) => [e.sourceHandle, e.targetHandle])).toEqual([['audio', 'audio-input']]);
		expect(planAutoConnect(source, growing('channels'), [])).toEqual([]);
	});

	it('connects stereo as L to L and R to R, including target sockets that have not rendered', () => {
		expect(planAutoConnect(fixed('source', ['ch1', 'ch2']), growing('target'), [])).toEqual([
			{ source: 'source', sourceHandle: 'ch1', target: 'target', targetHandle: 'ch1' },
			{ source: 'source', sourceHandle: 'ch2', target: 'target', targetHandle: 'ch2' }
		]);
		expect(planAutoConnect(fixed('source', ['L', 'R']), fixed('target', ['ch1', 'ch2']), []).map((e) => e.targetHandle)).toEqual(['ch1', 'ch2']);
		expect(planAutoConnect(fixed('source', ['ch1', 'ch2']), fixed('target', ['L', 'R']), []).map((e) => e.targetHandle)).toEqual(['L', 'R']);
	});

	it('respects fixed hardware and dynamic source/target capacity', () => {
		const source = fixed('source', ['ch1', 'ch2', 'ch3', 'ch4']);
		expect(planAutoConnect(source, fixed('speaker', ['ch1', 'ch2']), [])).toHaveLength(2);
		expect(planAutoConnect(source, growing('mono-recording', 1), [])).toHaveLength(1);
		expect(planAutoConnect(source, growing('stereo-meter', 2), [])).toHaveLength(2);
		expect(planAutoConnect(growing('file', 2, true, 6), growing('target'), [])).toHaveLength(2);
		expect(planAutoConnect(growing('file', 0, true, 6), growing('target'), [])).toEqual([]);
	});

	it('derives effect outputs from incoming channels without shifting channel holes', () => {
		const edges = [edge('mic', 'fx', 'ch2'), edge('mic', 'fx', 'ch4'), edge('key', 'fx', 'ch1', 'sidechain')];
		const planned = planAutoConnect(growing('fx'), growing('out'), edges);
		expect(planned.map((e) => [e.sourceHandle, e.targetHandle])).toEqual([
			['ch2', 'ch2'],
			['ch4', 'ch4']
		]);
		expect(planAutoConnect(growing('unwired'), growing('out'), edges)).toEqual([]);
	});

	it('uses stream width for self-growing sources, not their empty spare socket', () => {
		expect(planAutoConnect(growing('file', 8, true, 2), growing('out'), [])).toHaveLength(2);
		const edges = [edge('mic', 'plugin', 'ch1'), edge('mic', 'plugin', 'ch2')];
		expect(planAutoConnect(growing('plugin', Infinity, true), growing('out'), edges)).toHaveLength(2);
		expect(planAutoConnect(growing('receiver', 255, true), growing('out'), [edge('receiver', 'other', 'ch4')])).toHaveLength(4);
		expect(planAutoConnect(growing('unknown-stream', 255, true), growing('out'), [])).toHaveLength(1);
	});

	it('preserves existing wires and allows mixing, but never duplicates an edge tuple', () => {
		const edges = [edge('other', 'out', 'ch1'), edge('source', 'out', 'ch1')];
		const before = structuredClone(edges);
		const planned = planAutoConnect(fixed('source', ['ch1', 'ch2']), growing('out'), edges);
		expect(planned).toEqual([{ source: 'source', sourceHandle: 'ch2', target: 'out', targetHandle: 'ch2' }]);
		expect(edges).toEqual(before);
		expect(planAutoConnect(fixed('third', ['ch1']), growing('out'), edges)).toHaveLength(1);
		expect(planAutoConnect(fixed('source', ['ch1', 'ch2']), growing('out'), [...edges, { ...planned[0], id: 'new' }])).toEqual([]);
	});

	it('uses only main audio, never sidechains or arbitrary peer handles', () => {
		const planned = planAutoConnect(fixed('source', ['peer:p:0', 'ch2', 'ch1']), fixed('out', ['sidechain', 'ch1', 'ch2']), []);
		expect(planned.map((e) => e.sourceHandle)).toEqual(['ch2', 'ch1']);
		expect(planned.every((e) => e.sourceHandle === e.targetHandle)).toBe(true);
		expect(planAutoConnect(fixed('rtc', ['peer:p:0']), growing('out'), [])).toEqual([]);
		expect(planAutoConnect(fixed('source', ['ch1']), fixed('out', ['sidechain']), [])).toEqual([]);
		expect(planAutoConnect(fixed('rtc', ['peer:p:0', 'mixed']), fixed('out', [null]), [])).toEqual([
			{ source: 'rtc', sourceHandle: 'mixed', target: 'out', targetHandle: null }
		]);
		expect(planAutoConnect(fixed('bus', [null]), growing('out'), [])).toEqual([]);
	});

	it('rejects self-connections, cycles, reverse directions and unavailable endpoints', () => {
		const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];
		expect(planAutoConnect(fixed('a', ['ch1']), growing('a'), [])).toEqual([]);
		expect(planAutoConnect(fixed('d', ['ch1']), growing('a'), edges)).toEqual([]);
		expect(planAutoConnect(fixed('a', ['ch1']), growing('d'), edges)).toHaveLength(1);
		expect(planAutoConnect(fixed('speaker', []), growing('effect'), [])).toEqual([]);
		expect(planAutoConnect(fixed('effect', ['ch1']), fixed('mic', []), [])).toEqual([]);
	});
});

describe('cycle detection', () => {
	it('traverses branches and terminates even when the imported graph already contains a cycle', () => {
		const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'b'), edge('c', 'd')];
		expect(createsCycle('d', 'a', edges)).toBe(true);
		expect(createsCycle('new', 'a', edges)).toBe(false);
		expect(createsCycle('a', 'new', edges)).toBe(false);
		expect(createsCycle('a', 'a', [])).toBe(true);
	});
});
