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
		helpId,
		description = label,
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
		helpId?: string;
		description?: string;
		defaultValue: number;
		onChange: (v: number) => void;
	} = $props();
	const position = (v: number) => (logarithmic ? Math.log(clamp(v, min, max) / min) / Math.log(max / min) : (v - min) / (max - min));
	const fromPosition = (t: number) => (logarithmic ? min * (max / min) ** clamp(t, 0, 1) : min + clamp(t, 0, 1) * (max - min));
	let angle = $derived(-135 + 270 * position(value));
	let arcStart = $derived(min < 0 ? position(0) : 0);
	let arcValue = $derived(clamp(position(value), 0, 1));
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
		if (disabled || !drag || drag.id !== e.pointerId) return;
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

<div class="nodrag nopan nowheel flex shrink-0 items-center gap-1" class:opacity-50={disabled} class:grayscale={disabled}>
	<div
		class="nodrag nopan nowheel size-10 shrink-0 cursor-ns-resize rounded-full focus-visible:outline-2 focus-visible:outline-offset-2"
		style:color="var(--eq-accent)"
		style="touch-action: none"
		style:cursor={disabled ? 'default' : 'ns-resize'}
		role="slider"
		tabindex={disabled ? -1 : 0}
		aria-label={label}
		aria-describedby={helpId}
		aria-orientation="vertical"
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={value}
		aria-valuetext={`${value} ${unit}${disabled ? ', disabled' : ''}`}
		aria-disabled={disabled}
		title="{description} — {disabled
			? 'Disabled while the band is off or EQ is bypassed'
			: 'Drag or use arrow keys; Shift: fine; Enter or double-click: reset'}"
		onpointerdown={down}
		onpointermove={move}
		onpointerup={end}
		onpointercancel={end}
		onlostpointercapture={() => (drag = null)}
		onkeydown={key}
		ondblclick={reset}>
		<svg viewBox="0 0 52 52" class="pointer-events-none size-full" fill="none" aria-hidden="true">
			<path d="M10.444 41.556A22 22 0 1 1 41.556 41.556" class="stroke-neutral-400" stroke-width="3" stroke-linecap="round" />
			<path
				d="M10.444 41.556A22 22 0 1 1 41.556 41.556"
				pathLength="100"
				stroke="currentColor"
				stroke-width="3"
				stroke-linecap="round"
				stroke-dasharray="{Math.abs(arcValue - arcStart) * 100} 100"
				stroke-dashoffset={-Math.min(arcStart, arcValue) * 100} />
			<circle cx="26" cy="26" r="16" class="fill-neutral-200 stroke-neutral-500" fill-opacity={disabled ? 0.25 : 1} stroke-opacity={disabled ? 0.4 : 1} />
			<path d="M26 14V21" transform="rotate({angle} 26 26)" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
		</svg>
	</div>
	<div class="shrink-0">
		<span class="mb-1 block text-[10px] font-medium text-neutral-1200" title={description}>{label}</span>
		<div class="flex h-6 items-center rounded border border-neutral-500 bg-neutral-50 focus-within:border-amber-600 dark:focus-within:border-amber-400">
			<input
				class="nodrag nopan nowheel min-w-0 rounded bg-transparent px-1 py-1 text-center font-mono text-[11px] text-neutral-1200 tabular-nums focus-visible:outline-2 focus-visible:outline-amber-600 dark:focus-visible:outline-amber-400"
				style:width="7ch"
				type="number"
				aria-label="{label} value{unit ? ` (${unit})` : ''}"
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
			{#if unit}<span class="pr-1 text-[9px] text-neutral-1100" aria-hidden="true">{unit}</span>{/if}
		</div>
	</div>
</div>

<style>
	input[type='number'] {
		appearance: textfield;
		-moz-appearance: textfield;
	}
	input::-webkit-inner-spin-button,
	input::-webkit-outer-spin-button {
		-webkit-appearance: none;
		margin: 0;
	}
</style>
