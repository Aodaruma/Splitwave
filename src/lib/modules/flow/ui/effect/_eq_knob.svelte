<script lang="ts">
	import { clamp } from '$lib/modules/pipeline/eq';
	let {
		label,
		value,
		min,
		max,
		step = 0.1,
		unit = '',
		logarithmic = false,
		disabled = false,
		defaultValue,
		onChange
	}: {
		label: string;
		value: number;
		min: number;
		max: number;
		step?: number;
		unit?: string;
		logarithmic?: boolean;
		disabled?: boolean;
		defaultValue: number;
		onChange: (v: number) => void;
	} = $props();
	const position = (v: number) => (logarithmic ? Math.log(clamp(v, min, max) / min) / Math.log(max / min) : (v - min) / (max - min));
	const fromPosition = (t: number) => (logarithmic ? min * (max / min) ** clamp(t, 0, 1) : min + clamp(t, 0, 1) * (max - min));
	let angle = $derived(-135 + 270 * position(value));
	let drag: { id: number; y: number; position: number } | null = null;
	function change(v: number) {
		if (!disabled && Number.isFinite(v)) onChange(clamp(Math.round(v / step) * step, min, max));
	}
	function reset() {
		change(defaultValue);
	}
	function key(e: KeyboardEvent) {
		e.stopPropagation();
		if (disabled) return;
		const direction = ['ArrowUp', 'ArrowRight'].includes(e.key) ? 1 : ['ArrowDown', 'ArrowLeft'].includes(e.key) ? -1 : 0;
		if (direction) {
			e.preventDefault();
			change(logarithmic ? value * 2 ** (direction * (e.shiftKey ? 0.01 : 0.1)) : value + direction * step * (e.shiftKey ? 1 : 10));
		} else if (['Home', 'End', 'Enter'].includes(e.key)) {
			e.preventDefault();
			change(e.key === 'Home' ? min : e.key === 'End' ? max : defaultValue);
		}
	}
	function down(e: PointerEvent) {
		if (disabled || e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		const el = e.currentTarget as HTMLDivElement;
		el.focus();
		el.setPointerCapture(e.pointerId);
		drag = { id: e.pointerId, y: e.clientY, position: position(value) };
	}
	function move(e: PointerEvent) {
		if (!drag || drag.id !== e.pointerId) return;
		const next = clamp(drag.position + (drag.y - e.clientY) / (e.shiftKey ? 1600 : 160), 0, 1);
		change(fromPosition(next));
		drag = { ...drag, y: e.clientY, position: next };
	}
	function end(e: PointerEvent) {
		const el = e.currentTarget as HTMLDivElement;
		if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
		drag = null;
	}
</script>

<div class="nodrag nopan nowheel flex min-w-0 flex-1 flex-col items-center gap-1" class:opacity-40={disabled}>
	<span class="text-[10px] text-neutral-800">{label}</span>
	<div
		class="nodrag nopan nowheel relative h-10 w-10 cursor-ns-resize rounded-full border-2 border-neutral-400 bg-neutral-200 focus-visible:outline-2 focus-visible:outline-amber-500"
		style="touch-action: none"
		role="slider"
		tabindex={disabled ? -1 : 0}
		aria-label={label}
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={value}
		aria-valuetext={disabled ? 'Not applicable' : `${value} ${unit}`}
		aria-disabled={disabled}
		onpointerdown={down}
		onpointermove={move}
		onpointerup={end}
		onpointercancel={end}
		onlostpointercapture={() => (drag = null)}
		onkeydown={key}
		ondblclick={reset}>
		<div class="pointer-events-none absolute inset-0" style:transform="rotate({angle}deg)">
			<div class="absolute top-1 left-1/2 h-3 w-0.5 -translate-x-1/2 rounded bg-amber-500"></div>
		</div>
	</div>
	<div class="flex w-full items-center justify-center gap-1">
		<input
			class="nodrag nopan nowheel w-16 rounded border border-neutral-300 bg-neutral-100 px-1 text-center font-mono text-[10px] tabular-nums"
			type="number"
			aria-label="{label} value"
			{min}
			{max}
			{step}
			{disabled}
			value={Number(value.toFixed(2))}
			onchange={(e) => {
				change(e.currentTarget.valueAsNumber);
				e.currentTarget.value = String(value);
			}}
			onkeydown={(e) => e.stopPropagation()}
			ondblclick={reset} />
		<span class="text-[9px] text-neutral-700">{unit}</span>
	</div>
</div>
