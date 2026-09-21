import { describe, expect, it } from 'bun:test';
import type { Edge } from '@xyflow/svelte';
import type { AudioPorts } from '../src/lib/modules/flow/utils/auto_connect';
import { assertRewireAcyclic, crossesWire, detachNodes, screenPath, shakeDetector, switchInputs, type Point } from '../src/lib/modules/flow/utils/wiring';
import { canvasShortcut } from '../src/lib/modules/flow/utils/shortcuts';

const edge = (id: string, targetHandle: string | null = 'ch1', source = id, target = 'node'): Edge => ({
	id,
	source,
	target,
	sourceHandle: 'ch1',
	targetHandle
});
const ports = (ids: (string | null)[]): AudioPorts => ({ id: 'node', handles: ids.map((id, y) => ({ id, y })) });
const matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
const path = (length: number, at: (t: number) => Point) => ({
	getTotalLength: () => length,
	getPointAtLength: (s: number) => at(length ? s / length : 0) as DOMPoint
});

describe('rendered wire cutting geometry', () => {
	it('handles zoom, pan and SVG offset in screen pixels', () => {
		for (const zoom of [0.25, 1, 2.5]) {
			const wire = screenPath(
				path(100, (t) => ({ x: 100 * t, y: 10 })),
				{ ...matrix, a: zoom, d: zoom, e: 70, f: -20 }
			);
			expect(wire[0]).toEqual({ x: 70, y: 10 * zoom - 20 });
			expect(crossesWire({ x: 70 + 50 * zoom, y: -100 }, { x: 70 + 50 * zoom, y: 100 }, wire)).toBe(true);
			expect(crossesWire({ x: 60, y: -100 }, { x: 60, y: 100 }, wire)).toBe(false);
		}
	});

	it('uses the rendered curve instead of the line between endpoints', () => {
		const wire = screenPath(
			path(200, (t) => ({ x: 100 * t, y: 300 * t * (1 - t) })),
			matrix
		);
		expect(crossesWire({ x: 50, y: 65 }, { x: 50, y: 85 }, wire)).toBe(true);
		expect(crossesWire({ x: 50, y: -5 }, { x: 50, y: 5 }, wire)).toBe(false);
	});

	it('supports straight, step and rounded-step geometry and long sparsely delivered gestures', () => {
		const straight = screenPath(
			path(10000, (t) => ({ x: t * 10000, y: 5 })),
			matrix
		);
		const step = [
			{ x: 0, y: 0 },
			{ x: 50, y: 0 },
			{ x: 50, y: 50 },
			{ x: 100, y: 50 }
		];
		const rounded = screenPath(
			path(Math.PI * 10, (t) => ({ x: 50 + 10 * Math.cos(t * Math.PI), y: 50 + 10 * Math.sin(t * Math.PI) })),
			matrix
		);
		expect(crossesWire({ x: 1234, y: -500 }, { x: 1234, y: 500 }, straight)).toBe(true);
		expect(crossesWire({ x: 45, y: 25 }, { x: 55, y: 25 }, step)).toBe(true);
		expect(crossesWire({ x: 50, y: 55 }, { x: 50, y: 65 }, rounded)).toBe(true);
	});

	it('cuts every crossed wire along a freehand path, including repeated crossings only once', () => {
		const wires = [0, 20, 40].map((x) => [
			{ x, y: -10 },
			{ x, y: 10 }
		]);
		const stroke = [
			{ x: -5, y: 0 },
			{ x: 25, y: 0 },
			{ x: 15, y: 2 },
			{ x: 50, y: 0 }
		];
		const hits = new Set<number>();
		for (let i = 1; i < stroke.length; i++)
			wires.forEach((w, id) => {
				if (crossesWire(stroke[i - 1], stroke[i], w)) hits.add(id);
			});
		expect([...hits]).toEqual([0, 1, 2]);
	});

	it('handles endpoint touches, collinear overlap, zero length and near misses', () => {
		const wire = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 }
		];
		expect(crossesWire({ x: 10, y: 0 }, { x: 20, y: 10 }, wire, 0)).toBe(true);
		expect(crossesWire({ x: 5, y: 0 }, { x: 15, y: 0 }, wire, 0)).toBe(true);
		expect(crossesWire({ x: 5, y: 0 }, { x: 5, y: 0 }, wire, 0)).toBe(true);
		expect(crossesWire({ x: 11, y: 0 }, { x: 20, y: 0 }, wire, 0)).toBe(false);
		expect(crossesWire({ x: 0, y: 2 }, { x: 10, y: 2 }, wire)).toBe(false);
		expect(crossesWire({ x: 0, y: 0 }, { x: 10, y: 0 }, [])).toBe(false);
		expect(
			screenPath(
				path(0, () => ({ x: 3, y: 4 })),
				matrix
			)
		).toEqual([
			{ x: 3, y: 4 },
			{ x: 3, y: 4 }
		]);
	});
});

describe('input switching', () => {
	it('rejects feedback introduced by expanded group input assignments without mutating either graph', () => {
		const before = [edge('inside', 'ch1', 'inner-a', 'inner-b'), edge('return', 'ch1', 'inner-b', 'inner-c')];
		const after = [before[0], { ...before[1], target: 'inner-a' }];
		expect(() => assertRewireAcyclic(before, after)).toThrow('routing cycle');
		expect(() => assertRewireAcyclic(before, [before[0], { ...before[1], target: 'inner-b' }])).toThrow('routing cycle');
		expect(() => assertRewireAcyclic(before, [before[0], { ...before[1], target: 'new-node' }])).not.toThrow();
		expect(() => assertRewireAcyclic(before, before)).not.toThrow();
		expect(before[1].target).toBe('inner-c');
		expect(after[1].target).toBe('inner-a');
	});
	it('accepts only Alt+S within the canvas keyboard scope', () => {
		const key = { key: 's', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
		expect(canvasShortcut(key, true)).toBe('switchInputs');
		expect(canvasShortcut({ ...key, key: 'S' }, true)).toBe('switchInputs');
		expect(canvasShortcut(key, false)).toBeNull();
		for (const modifier of ['ctrlKey', 'metaKey', 'shiftKey'] as const) expect(canvasShortcut({ ...key, [modifier]: true }, true)).toBeNull();
		expect(canvasShortcut({ ...key, altKey: false }, true)).toBeNull();
	});
	it('cycles a single linked input through compatible sockets top to bottom, wrapping', () => {
		const target = {
			...ports(['sidechain', 'R', 'L', null]),
			handles: [
				{ id: 'R', y: 20 },
				{ id: 'sidechain', y: 0 },
				{ id: 'L', y: 10 },
				{ id: null, y: 30 }
			]
		};
		const before = [edge('a', 'L')];
		const next = switchInputs(target, before);
		expect(next[0].targetHandle).toBe('R');
		expect(switchInputs(target, next)).toEqual(before);
		expect(before[0].targetHandle).toBe('L');
	});

	it('swaps two linked input bundles including fan-in and explicit L/R crossing', () => {
		const original = [edge('a', 'L'), edge('b', 'L'), edge('c', 'R'), edge('unrelated', 'ch1', 'other', 'outside')];
		const next = switchInputs(ports(['L', 'R', 'ch3']), original);
		expect(next.map((e) => e.targetHandle)).toEqual(['R', 'R', 'L', 'ch1']);
		expect(next.map((e) => e.id)).toEqual(original.map((e) => e.id));
		expect(next.map((e) => e.sourceHandle)).toEqual(original.map((e) => e.sourceHandle));
		expect(next[3]).toBe(original[3]);
		expect(switchInputs(ports(['L', 'R', 'ch3']), next)).toEqual(original);
	});

	it('moves all fan-in together when only one port is linked', () => {
		expect(switchInputs(ports(['ch1', 'ch2']), [edge('a'), edge('b')]).map((e) => e.targetHandle)).toEqual(['ch2', 'ch2']);
	});

	it('rotates more than two occupied inputs deterministically, ignoring empty sockets', () => {
		const original = [edge('c', 'ch4'), edge('a', 'ch1'), edge('b', 'ch2'), edge('b2', 'ch2')];
		const target = ports(['ch1', 'ch2', 'ch3', 'ch4']);
		const next = switchInputs(target, original);
		expect(next.map((e) => e.targetHandle)).toEqual(['ch1', 'ch2', 'ch4', 'ch4']);
		expect(switchInputs(target, switchInputs(target, next))).toEqual(original);
	});

	it('resolves stable group port semantics while following display order', () => {
		const target: AudioPorts = {
			id: 'node',
			handles: [],
			ordered: [
				{ id: 'right', handle: 'R' },
				{ id: 'audio', handle: null },
				{ id: 'left', handle: 'L' },
				{ id: 'key', handle: 'sidechain' }
			]
		};
		const original = [edge('a', 'right'), edge('bus', 'audio'), edge('key', 'key')];
		expect(switchInputs(target, original).map((e) => e.targetHandle)).toEqual(['left', 'audio', 'key']);
	});

	it('keeps bus, sidechain and unknown input roles separate from individual channels', () => {
		const original = [edge('a', 'main'), edge('b', 'sidechain'), edge('c', 'peer:p:0'), edge('d', 'missing')];
		expect(switchInputs(ports(['main', 'sidechain', 'peer:p:0', 'ch1', 'ch2']), original)).toBe(original);
		expect(switchInputs(ports([null, 'main']), [edge('a', null)])[0].targetHandle).toBe('main');
	});

	it('honors capacity and protects group boundary mappings', () => {
		const original = [edge('a'), { ...edge('boundary', 'ch2', '$group-input'), deletable: false }];
		expect(switchInputs(ports(['ch1', 'ch2']), original)).toBe(original);
		expect(switchInputs({ ...ports(['ch1', 'ch2']), channels: { max: 1, min: 1, selfGrowing: false } }, [edge('a')])[0].targetHandle).toBe('ch1');
	});

	it('rejects switches that would strand a pass-through output and keeps existing missing inputs', () => {
		const output: AudioPorts = { ...ports(['ch1']), channels: { max: 8, min: 0, selfGrowing: false } };
		const original = [edge('a'), edge('out', 'ch1', 'node', 'speaker'), edge('orphan', 'missing')];
		expect(switchInputs(ports(['ch1', 'ch2']), original, output)).toBe(original);
		expect(switchInputs(ports(['ch1', 'ch2']), [...original, edge('b', 'ch2')], output).map((e) => e.targetHandle)).toEqual([
			'ch2',
			'ch1',
			'missing',
			'ch1'
		]);
	});

	it('retains IDs, metadata and even duplicate tuples without losing edges', () => {
		const original = [edge('a'), { ...edge('b', 'ch1', 'a'), data: { custom: true }, selected: true }];
		const copy = structuredClone(original);
		const next = switchInputs(ports(['ch1', 'ch2']), original);
		expect(next).toHaveLength(original.length);
		expect(next[1]).toEqual({ ...original[1], targetHandle: 'ch2' });
		expect(original).toEqual(copy);
		expect(switchInputs(ports([]), original)).toBe(original);
	});
});

describe('detach and deliberate shake', () => {
	it('removes all incident wires including internal selected-group edges, without healing routes', () => {
		const wires = [
			edge('in', 'ch1', 'outside', 'a'),
			edge('internal', 'ch1', 'a', 'b'),
			edge('out', 'ch1', 'b', 'speaker'),
			edge('unrelated', 'ch1', 'x', 'y')
		];
		const next = detachNodes(wires, [
			{ id: 'a', type: 'gain' },
			{ id: 'b', type: 'group' }
		]);
		expect(next).toEqual([wires[3]]);
		expect(wires).toHaveLength(4);
	});

	it('excludes boundary nodes and preserves noneditable group port mappings', () => {
		const wires = [{ ...edge('port', 'ch1', '$group-input', 'a'), deletable: false }, edge('other', 'ch1', 'x', 'y')];
		expect(detachNodes(wires, [{ id: '$group-input', type: 'groupBoundary' }])).toEqual(wires);
		expect(detachNodes(wires, [{ id: 'a', type: 'gain' }])).toEqual(wires);
	});

	it('requires three 24px reversals and triggers only once on either axis', () => {
		for (const axis of ['x', 'y'] as const) {
			const detect = shakeDetector({ x: 0, y: 0 }, 0);
			const values = [30, -10, 30, -10, 30, -10];
			expect(values.map((v, i) => detect({ x: 0, y: 0, [axis]: v }, 100 * (i + 1)))).toEqual([false, false, false, true, false, false]);
		}
	});

	it('ignores jitter, a single correction and slow direction changes', () => {
		for (const [values, interval] of [
			[Array.from({ length: 60 }, (_, i) => (i % 2 ? 4 : -4)), 10],
			[[50, 100, 70, 60, 20], 80],
			[[40, -40, 40, -40, 40], 800]
		] as const) {
			const detect = shakeDetector({ x: 0, y: 0 }, 0);
			expect(values.some((x, i) => detect({ x, y: 0 }, (i + 1) * interval))).toBe(false);
		}
	});

	it('resets on modifiers, pauses and backwards time', () => {
		for (const interruption of ['modifier', 'pause', 'clock']) {
			const detect = shakeDetector({ x: 0, y: 0 }, 0);
			expect(detect({ x: 40, y: 0 }, 100)).toBe(false);
			expect(detect({ x: -40, y: 0 }, 200)).toBe(false);
			const t = interruption === 'pause' ? 1100 : interruption === 'clock' ? 0 : 300;
			expect(detect({ x: 40, y: 0 }, t, interruption !== 'modifier')).toBe(false);
			expect(detect({ x: -40, y: 0 }, t + 100)).toBe(false);
			expect(detect({ x: 40, y: 0 }, t + 200)).toBe(false);
		}
	});
});
