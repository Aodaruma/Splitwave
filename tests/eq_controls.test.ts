import { describe, expect, test } from 'bun:test';
import * as eqMath from '../src/lib/modules/pipeline/eq';
import type { EqNodeData } from '../src/lib/modules/pipeline/types';

const eqSource = await Bun.file(new URL('../src/lib/modules/flow/ui/effect/eq.svelte', import.meta.url)).text();
const knobSource = await Bun.file(new URL('../src/lib/modules/flow/ui/effect/_eq_knob.svelte', import.meta.url)).text();

// Execute the component's actual handlers with reactive inputs, without a DOM or audio services.
function handlers<Name extends string>(source: string, start: string, scope: object, names: Name[]) {
	const script = source.slice(source.indexOf(start), source.indexOf('</script>'));
	const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(script);
	return new Function('scope', `with (scope) { ${code}; return { ${names.join(',')} }; }`)(scope) as Record<Name, (...args: any[]) => void>;
}
const event = (key = '', shiftKey = false) => ({
	key,
	shiftKey,
	button: 0,
	pointerId: 1,
	clientX: 100,
	clientY: 100,
	preventDefault() {},
	stopPropagation() {},
	currentTarget: { focus() {}, setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} }
});
function node(data: EqNodeData = { ...eqMath.defaultEq(), eqGuide: 'voice' }) {
	const updates: unknown[] = [];
	const audio: unknown[] = [];
	const scope = {
		...eqMath,
		data,
		id: 'eq',
		selection: 0,
		runningRate: null,
		error: '',
		max: 20000,
		get eq(): ReturnType<typeof eqMath.readEq> {
			return eqMath.readEq(this.data);
		},
		get parametric(): boolean {
			return this.eq.mode === 'parametric';
		},
		get channel(): boolean {
			return eqMath.isChannelEq(this.eq);
		},
		get frequencies(): number[] {
			return this.parametric ? this.eq.bands.map((b) => b.frequency) : eqMath.GRAPHIC_FREQUENCIES;
		},
		flow: { updateNodeData: (_id: string, next: unknown) => updates.push(next) },
		audioMethods: {
			updateEffect: async (_id: string, next: unknown) => {
				audio.push(next);
				return null;
			}
		},
		plot: { getBoundingClientRect: () => ({ width: 538, height: 224 }) }
	};
	return {
		scope,
		updates,
		audio,
		...handlers(eqSource, 'function patch(', scope, [
			'patch',
			'initialize',
			'setGuide',
			'toggleBand',
			'setBand',
			'setGain',
			'resetBand',
			'applyPreset',
			'down',
			'move',
			'end',
			'key'
		])
	};
}

describe('EQ editing guards', () => {
	test('off bands remain selectable and enableable while every parameter path is blocked', () => {
		const eq = node();
		const original = structuredClone(eq.scope.data);
		eq.down(1, event());
		expect(eq.scope.selection).toBe(1);
		eq.move({ ...event(), clientX: 200, clientY: 0 });
		eq.setBand(1, { frequency: 500, q: 3 });
		eq.setGain(1, 8);
		eq.resetBand(1);
		for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home']) eq.key(1, event(key));
		expect(eq.scope.data).toEqual(original);
		expect(eq.updates).toHaveLength(0);
		expect(eq.audio).toHaveLength(0);
		eq.toggleBand(1);
		expect(eq.scope.data.bands[1].enabled).toBe(true);
		eq.setGain(1, 8);
		expect(eq.scope.data.bands[1].gainDb).toBe(8);
	});
	test('bypass blocks graph, numeric, reset, toggle, preset and initialization paths, including mid-drag', () => {
		for (const data of [eqMath.defaultEq(), eqMath.readEq({})]) {
			const eq = node(data);
			eq.down(2, event());
			eq.scope.data = { ...eq.scope.data, bypassed: true };
			const original = structuredClone(eq.scope.data);
			eq.move({ ...event(), clientX: 200, clientY: 0 });
			eq.setBand(2, { frequency: 500, q: 3 });
			eq.setGain(2, 8);
			eq.resetBand(2);
			eq.toggleBand(2);
			eq.initialize();
			eq.applyPreset(eqMath.readEq({}));
			for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home']) eq.key(2, event(key));
			expect(eq.scope.data).toEqual(original);
			expect(eq.updates).toHaveLength(0);
			expect(eq.audio).toHaveLength(0);
			eq.patch({ bypassed: false });
			expect(eq.scope.data.bypassed).toBe(false);
		}
	});
	test('keyboard fine adjustment works and cuts never gain a hidden gain edit', () => {
		const eq = node();
		eq.key(2, event('ArrowUp', true));
		expect(eq.scope.data.bands[2].gainDb).toBeCloseTo(0.1);
		eq.key(2, event('ArrowRight', true));
		expect(eq.scope.data.bands[2].frequency).toBeCloseTo(100 * 2 ** 0.01);
		eq.toggleBand(0);
		eq.key(0, event('ArrowUp'));
		expect(eq.scope.data.bands[0].gainDb).toBe(0);
	});
	test('guide changes skip audio updates and survive parameter edits, presets and explicit initialization', () => {
		for (const data of [eqMath.readEq({}), eqMath.readEq({ mode: 'parametric' })]) {
			const eq = node(data);
			eq.setGuide('voice');
			expect(eq.scope.data).toEqual({ ...data, eqGuide: 'voice' });
			expect(eq.audio).toHaveLength(0);
			eq.setGain(2, 5);
			expect(eq.scope.data.eqGuide).toBe('voice');
			eq.applyPreset({ mode: 'parametric' });
			expect(eq.scope.data).toEqual({ ...eqMath.readEq({ mode: 'parametric' }), eqGuide: 'voice' });
			const calls = eq.audio.length;
			eq.initialize();
			expect(eq.scope.data).toEqual({ ...eqMath.defaultEq(), eqGuide: 'voice' });
			expect(eq.audio).toHaveLength(calls + 1);
		}
	});
});

describe('EQ knob disabled paths', () => {
	test('disabled blocks numeric entry, reset, keyboard, pointer drag and a drag disabled midway', () => {
		const changes: number[] = [];
		const scope = {
			clamp: eqMath.clamp,
			disabled: true,
			value: 3,
			min: -18,
			max: 18,
			step: 0.1,
			logarithmic: false,
			defaultValue: 0,
			$derived: (value: number) => value,
			onChange: (v: number) => changes.push(v)
		};
		const knob = handlers(knobSource, 'const position =', scope, ['change', 'reset', 'key', 'down', 'move', 'end']);
		knob.change(10);
		knob.reset();
		for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter']) knob.key(event(key));
		knob.down(event());
		knob.move({ ...event(), clientY: 0 });
		expect(changes).toEqual([]);
		scope.disabled = false;
		knob.down(event());
		scope.disabled = true;
		knob.move({ ...event(), clientY: 0 });
		knob.end(event());
		expect(changes).toEqual([]);
		scope.disabled = false;
		knob.key(event('ArrowUp', true));
		expect(changes).toEqual([3.1]);
	});
	test('native numeric input is disabled and slider is removed from keyboard focus', () => {
		expect(knobSource).toMatch(/<input\s[^>]*\{disabled\}/s);
		expect(knobSource).toContain('tabindex={disabled ? -1 : 0}');
		expect(knobSource).toContain('aria-disabled={disabled}');
		expect(knobSource).toContain('change(e.currentTarget.valueAsNumber)');
		expect(eqSource.match(/<Knob\s+label="[^"]+"\s+\{disabled\}/g)).toHaveLength(3);
		expect(eqSource).not.toContain('line-through');
	});
});
