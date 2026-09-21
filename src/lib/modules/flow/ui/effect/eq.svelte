<script lang="ts">
	import { onMount } from 'svelte';
	import { useSvelteFlow, type Node, type NodeProps } from '@xyflow/svelte';
	import type { EqNodeData } from '$lib/modules/pipeline/types';
	import type { EqData } from '$lib/modules/pipeline/generated/EqData';
	import type { EqBand } from '$lib/modules/pipeline/generated/EqBand';
	import type { EqFilter } from '$lib/modules/pipeline/generated/EqFilter';
	import { methods as audioMethods } from '$lib/modules/audio/methods';
	import { appSettings } from '$lib/modules/settings/stores.svelte';
	import {
		readEq,
		GRAPHIC_FREQUENCIES,
		BAND_FREQUENCIES,
		responseDb,
		maxFrequency,
		clamp,
		frequencyPosition,
		positionFrequency
	} from '$lib/modules/pipeline/eq';
	import Wrapper from '../node.svelte';
	import Knob from './_eq_knob.svelte';
	import { Sliders } from '$lib/components/icons';
	import { PresetBar } from '$lib/modules/preset/ui';
	import type { PresetData } from '$lib/modules/preset';
	import { formatFreq } from '$lib/components/format';

	let { id, data }: NodeProps<Node<EqNodeData, 'eq'>> = $props();
	const flow = useSvelteFlow();
	let eq = $derived(readEq(data));
	let parametric = $derived(eq.mode === 'parametric');
	let runningRate = $state<number | null>(null);
	let sr = $derived(runningRate ?? appSettings.pipelineSampleRate);
	onMount(() => {
		let disposed = false;
		const refresh = () =>
			audioMethods
				.updateEffect(id, {})
				.then((rate) => {
					if (!disposed) runningRate = rate;
				})
				.catch((e) => {
					if (!disposed) error = String(e);
				});
		void refresh();
		const timer = setInterval(refresh, 1000);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	});
	let max = $derived(maxFrequency(sr));
	let selected = $state(0);
	let band = $derived(eq.bands[Math.min(selected, 7)]);
	let cut = $derived(parametric && ['lowCut', 'highCut'].includes(band.filter));
	let error = $state('');
	let plot: HTMLDivElement;
	const W = 418,
		H = 224;
	const yPosition = (db: number) => (18 - clamp(db, -18, 18)) / 36;
	let frequencies = $derived(parametric ? eq.bands.map((b) => b.frequency) : GRAPHIC_FREQUENCIES);
	let curve = $derived.by(() =>
		Array.from({ length: 241 }, (_, i) => {
			const t = i / 240,
				db = responseDb(eq, positionFrequency(t, max), sr);
			return `${i ? 'L' : 'M'}${(t * W).toFixed(2)},${(yPosition(db) * H).toFixed(2)}`;
		}).join(' ')
	);
	const filters: { value: EqFilter; label: string; path: string }[] = [
		{ value: 'bell', label: 'Bell', path: 'M2 15H7C12 15 10 5 16 5S20 15 25 15H30' },
		{ value: 'lowShelf', label: 'Low shelf', path: 'M2 6H10C16 6 16 15 22 15H30' },
		{ value: 'highShelf', label: 'High shelf', path: 'M2 15H10C16 15 16 6 22 6H30' },
		{ value: 'lowCut', label: 'Low cut · 12 dB/oct', path: 'M2 20C10 20 9 6 17 6H30' },
		{ value: 'highCut', label: 'High cut · 12 dB/oct', path: 'M2 6H15C23 6 22 20 30 20' }
	];

	function patch(p: Partial<EqData>) {
		const next = { ...eq, ...p };
		data = next;
		flow.updateNodeData(id, next);
		error = '';
		// Algorithm changes are picked up by the editor's structural reconcile.
		if (p.mode !== undefined) return;
		audioMethods
			.updateEffect(id, next)
			.then((rate) => (runningRate = rate))
			.catch((e) => (error = String(e)));
	}
	function switchMode(mode: EqData['mode']) {
		selected = 0;
		patch({ mode });
	}
	function setBand(i: number, p: Partial<EqBand>) {
		const bands = eq.bands.map((b, j) => (j === i ? { ...b, ...p } : b)) as EqData['bands'];
		patch({ bands });
	}
	function setGain(i: number, gain: number) {
		if (!Number.isFinite(gain)) return;
		gain = Math.round(clamp(gain, -18, 18) * 10) / 10;
		if (parametric) {
			if (!['lowCut', 'highCut'].includes(eq.bands[i].filter)) setBand(i, { gainDb: gain });
		} else {
			const gains = eq.gainsDb.slice() as EqData['gainsDb'];
			gains[i] = gain;
			patch({ gainsDb: gains });
		}
	}
	function resetBand(i: number) {
		if (parametric) setBand(i, { frequency: Math.min(BAND_FREQUENCIES[i], max), gainDb: 0, q: 1 });
		else setGain(i, 0);
	}
	function applyPreset(p: PresetData<'eq'>) {
		const next = readEq(p);
		selected = 0;
		const modeChanged = next.mode !== eq.mode;
		const { bypassed: _, mode, ...params } = next;
		patch(modeChanged ? { ...params, mode } : params);
	}
	let drag: { id: number; band: number; x: number; y: number; frequency: number; gain: number } | null = null;
	function down(i: number, e: PointerEvent) {
		if (e.button !== 0) return;
		e.preventDefault();
		e.stopPropagation();
		selected = i;
		const el = e.currentTarget as HTMLButtonElement;
		el.focus();
		el.setPointerCapture(e.pointerId);
		drag = { id: e.pointerId, band: i, x: e.clientX, y: e.clientY, frequency: frequencies[i], gain: parametric ? eq.bands[i].gainDb : eq.gainsDb[i] };
	}
	function move(e: PointerEvent) {
		if (!drag || drag.id !== e.pointerId) return;
		const rect = plot.getBoundingClientRect(),
			scale = e.shiftKey ? 0.1 : 1;
		const frequency = positionFrequency(frequencyPosition(drag.frequency, max) + ((e.clientX - drag.x) / rect.width) * scale, max);
		const gain = clamp(drag.gain - ((e.clientY - drag.y) / rect.height) * 36 * scale, -18, 18);
		if (parametric)
			setBand(drag.band, {
				frequency: Math.round(frequency),
				...(['lowCut', 'highCut'].includes(eq.bands[drag.band].filter) ? {} : { gainDb: Math.round(gain * 10) / 10 })
			});
		else setGain(drag.band, gain);
		drag = { ...drag, x: e.clientX, y: e.clientY, frequency, gain };
	}
	function end(e: PointerEvent) {
		const el = e.currentTarget as HTMLButtonElement;
		if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
		drag = null;
	}
	function key(i: number, e: KeyboardEvent) {
		e.stopPropagation();
		if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home'].includes(e.key)) e.preventDefault();
		if (e.key === 'Home') resetBand(i);
		else if (e.key === 'ArrowUp' || e.key === 'ArrowDown')
			setGain(i, (parametric ? eq.bands[i].gainDb : eq.gainsDb[i]) + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.1 : 1));
		else if (parametric && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
			setBand(i, { frequency: clamp(eq.bands[i].frequency * 2 ** ((e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.01 : 0.1)), 20, max) });
	}
</script>

{#snippet filterShape(filter: EqFilter)}
	<svg viewBox="0 0 32 24" class="h-5 w-7 shrink-0" fill="none" aria-hidden="true">
		<path d="M2 15H30" stroke="currentColor" stroke-opacity="0.2" />
		<path d={filters.find((f) => f.value === filter)?.path} stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
	</svg>
{/snippet}

<Wrapper
	label="EQ"
	icon={Sliders}
	accent="effect"
	hasInput
	hasOutput
	channelIo
	nodeId={id}
	wide
	bypassed={eq.bypassed}
	onBypass={() => patch({ bypassed: !eq.bypassed })}>
	<div
		class="nodrag nopan nowheel flex w-[460px] flex-col gap-2"
		onkeydown={(e) => e.stopPropagation()}
		role="toolbar"
		tabindex="-1"
		aria-label="EQ controls">
		<div class="flex items-center gap-2">
			<div class="min-w-0 flex-1"><PresetBar kind="eq" data={eq} onApply={applyPreset} /></div>
			<select
				class="nodrag nopan nowheel h-7 rounded border border-neutral-400 bg-neutral-100 px-1.5 text-[10px] text-neutral-1200 focus-visible:outline-2 focus-visible:outline-amber-600 dark:focus-visible:outline-amber-400"
				aria-label="EQ mode"
				aria-describedby="{id}-eq-mode-help"
				title="Modes keep separate settings; switching changes the sound."
				value={eq.mode}
				onchange={(e) => switchMode(e.currentTarget.value as EqData['mode'])}>
				<option value="parametric">Parametric · 8</option><option value="graphic">Graphic (legacy) · 10</option>
			</select>
		</div>
		<p id="{id}-eq-mode-help" class="sr-only">
			Modes keep separate settings; switching changes the sound. Graphic mode uses fixed frequencies and preserves the legacy crossover sound.
		</p>
		<div class="rounded-lg border border-neutral-400 bg-neutral-50 px-5 pt-4 pb-2">
			<div bind:this={plot} class="relative h-56 text-neutral-1100">
				<svg
					viewBox="0 0 {W} {H}"
					class="absolute h-full w-full overflow-visible"
					preserveAspectRatio="none"
					role="img"
					aria-label="EQ target frequency response at {sr} Hz">
					{#each [12, 6, 0, -6, -12] as db}
						<line
							x1="0"
							y1={yPosition(db) * H}
							x2={W}
							y2={yPosition(db) * H}
							stroke="currentColor"
							stroke-opacity={db === 0 ? 0.4 : 0.13}
							stroke-width={db === 0 ? 1 : 0.6} />
						<text x="2" y={yPosition(db) * H - 4} font-size="9" fill="currentColor">{db > 0 ? '+' : ''}{db}</text>
					{/each}
					<text x="2" y="8" font-size="9" fill="currentColor">dB</text>
					{#each [50, 100, 200, 500, 1000, 2000, 5000, 10000].filter((f) => f < max) as f}
						<line
							x1={frequencyPosition(f, max) * W}
							y1="0"
							x2={frequencyPosition(f, max) * W}
							y2={H}
							stroke="currentColor"
							stroke-opacity="0.15"
							stroke-width="0.6" />
					{/each}
					<path d="{curve} L{W},{H / 2} L0,{H / 2} Z" class="fill-amber-600/10 dark:fill-amber-400/10" />
					<path d={curve} class="stroke-amber-700 dark:stroke-amber-400" stroke-width="2" vector-effect="non-scaling-stroke" fill="none" />
				</svg>
				{#each frequencies as freq, i}
					{@const b = parametric ? eq.bands[i] : null}
					{@const gain = b ? (['lowCut', 'highCut'].includes(b.filter) ? 0 : b.gainDb) : eq.gainsDb[i]}
					<button
						type="button"
						class="nodrag nopan nowheel absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border font-mono text-[10px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 dark:focus-visible:outline-amber-400 {selected ===
						i
							? 'z-10 border-amber-700 bg-amber-500 text-black ring-2 ring-amber-600/25 dark:border-amber-400 dark:ring-amber-400/25'
							: 'border-neutral-800 bg-neutral-100 text-neutral-1200 hover:border-amber-600 dark:hover:border-amber-400'}"
						class:border-dashed={b && !b.enabled}
						style="left:{frequencyPosition(freq, max) * 100}%;top:{yPosition(gain) * 100}%;touch-action:none"
						title="Band {i + 1} · {formatFreq(freq)}{b && !b.enabled ? ' · Off' : ''} — {parametric
							? 'Drag frequency / gain'
							: 'Drag gain'}; Shift: fine; double-click: reset"
						aria-label="Band {i + 1}, {Math.round(Math.min(freq, max))} Hz, {gain.toFixed(1)} dB{b
							? `, Q ${b.q}, ${filters.find((f) => f.value === b.filter)?.label}, ${b.enabled ? 'enabled' : 'disabled'}`
							: ''}"
						aria-pressed={selected === i}
						aria-describedby="{id}-eq-help"
						onfocus={() => (selected = i)}
						onclick={() => (selected = i)}
						onpointerdown={(e) => down(i, e)}
						onpointermove={move}
						onpointerup={end}
						onpointercancel={end}
						onlostpointercapture={() => (drag = null)}
						onkeydown={(e) => key(i, e)}
						ondblclick={() => resetBand(i)}><span class:line-through={b && !b.enabled}>{i + 1}</span></button>
				{/each}
			</div>
			<div class="relative mt-4 h-3 font-mono text-[9px] text-neutral-1100 tabular-nums">
				<span class="absolute left-0">20 Hz</span>
				{#each [100, 1000, 10000].filter((f) => f < max / 1.5) as f}
					<span class="absolute -translate-x-1/2" style:left={frequencyPosition(f, max) * 100 + '%'}>{formatFreq(f)}</span>
				{/each}
				<span class="absolute right-0">{formatFreq(max)}</span>
			</div>
		</div>
		<div class="flex gap-1" role="group" aria-label="Select EQ band">
			{#each frequencies as freq, i}
				{@const enabled = !parametric || eq.bands[i].enabled}
				<button
					type="button"
					class="nodrag nopan nowheel flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded border font-mono text-[10px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 dark:focus-visible:outline-amber-400 {selected ===
					i
						? 'border-amber-600 bg-amber-500/15 text-amber-900 dark:border-amber-400 dark:text-amber-200'
						: 'border-neutral-400 bg-neutral-100 text-neutral-1200 hover:bg-neutral-300'}"
					class:border-dashed={!enabled}
					title="Band {i + 1} · {formatFreq(freq)}{enabled ? '' : ' · Off'}"
					aria-label="Select band {i + 1}, {formatFreq(freq)}{parametric ? `, ${enabled ? 'enabled' : 'disabled'}` : ''}"
					aria-pressed={selected === i}
					onclick={() => (selected = i)}>
					<span class:line-through={!enabled}>{i + 1}</span>
					{#if parametric}{@render filterShape(eq.bands[i].filter)}{/if}
				</button>
			{/each}
		</div>
		<div class="rounded-lg border border-neutral-400 bg-neutral-100 px-2 py-2" role="group" aria-label="Band {selected + 1} controls">
			<div class="flex items-center justify-between gap-2">
				{#if parametric}
					<button
						type="button"
						class="eq-icon nodrag nopan nowheel {band.enabled ? 'text-amber-800 dark:text-amber-300' : 'text-neutral-1100'}"
						aria-label="Enable band {selected + 1}"
						aria-pressed={band.enabled}
						title="Band {selected + 1}: {band.enabled ? 'on — click to disable' : 'off — click to enable'}"
						onclick={() => setBand(selected, { enabled: !band.enabled })}>
						<svg viewBox="0 0 24 24" class="size-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
							<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" />
						</svg>
					</button>
					<div class="flex gap-1" role="group" aria-label="Band {selected + 1} filter type">
						{#each filters as f}
							<button
								type="button"
								class="eq-icon nodrag nopan nowheel w-11 {band.filter === f.value
									? 'border-amber-600! bg-amber-500/15 text-amber-900 dark:border-amber-400! dark:text-amber-200'
									: 'text-neutral-1200'}"
								aria-label={f.label}
								aria-pressed={band.filter === f.value}
								title={f.label}
								onclick={() => setBand(selected, { filter: f.value })}>
								{@render filterShape(f.value)}
							</button>
						{/each}
					</div>
				{:else}
					<span class="px-1 font-mono text-[11px] text-neutral-1200 tabular-nums" title="Fixed legacy band frequency"
						>{formatFreq(frequencies[selected])}</span>
				{/if}
				<button
					type="button"
					class="eq-icon nodrag nopan nowheel text-neutral-1200"
					aria-label="Reset band {selected + 1}"
					title="Reset band {selected + 1} {parametric ? 'frequency, gain and Q' : 'gain'}"
					onclick={() => resetBand(selected)}>
					<svg
						viewBox="0 0 24 24"
						class="size-4"
						fill="none"
						stroke="currentColor"
						stroke-width="1.8"
						stroke-linecap="round"
						stroke-linejoin="round"
						aria-hidden="true">
						<path d="M4 4v6h6M4 10a8 8 0 1 1 .7 6" />
					</svg>
				</button>
			</div>
			<div class="flex justify-center gap-3 pt-3 pb-1">
				{#if parametric}
					<Knob
						label="Frequency"
						value={Math.min(band.frequency, max)}
						min={20}
						{max}
						step={1}
						unit="Hz"
						logarithmic
						helpId="{id}-eq-knob-help"
						defaultValue={BAND_FREQUENCIES[Math.min(selected, 7)]}
						onChange={(v) => setBand(selected, { frequency: v })} />
				{/if}
				{#if !cut}
					<Knob
						label="Gain"
						value={parametric ? band.gainDb : eq.gainsDb[selected]}
						min={-18}
						max={18}
						step={0.1}
						unit="dB"
						helpId="{id}-eq-knob-help"
						defaultValue={0}
						onChange={(v) => setGain(selected, v)} />
				{/if}
				{#if parametric}
					<Knob
						label="Q"
						value={band.q}
						min={0.1}
						max={12}
						step={0.01}
						logarithmic
						helpId="{id}-eq-knob-help"
						description={cut ? 'Resonance' : 'Bandwidth / resonance'}
						defaultValue={1}
						onChange={(v) => setBand(selected, { q: v })} />
				{/if}
			</div>
		</div>
		{#if parametric && eq.bands.some((b) => b.frequency > max)}<p class="text-[10px] text-amber-900 dark:text-amber-200">
				Frequencies above {Math.round(max)} Hz are limited to 49% of this sample rate. Saved values are retained.
			</p>{/if}
		{#if !parametric && sr <= 22628}<p role="alert" class="text-[10px] text-red-700 dark:text-red-300">
				Legacy EQ requires a sample rate above 22628 Hz. Select Parametric for this rate.
			</p>{/if}
		<p id="{id}-eq-help" class="sr-only">
			{parametric
				? 'Drag or use Left / Right for frequency; Up / Down for gain. Cut filters have no gain control.'
				: 'Drag or use Up / Down for gain. Frequencies are fixed.'}
			Hold Shift for fine adjustment. Double-click or Home to reset the band.
		</p>
		<p id="{id}-eq-knob-help" class="sr-only">
			Drag vertically or use arrow keys to adjust. Hold Shift for fine adjustment. Home: minimum; End: maximum; Enter or double-click: reset. Type an
			exact value in the adjacent field.
		</p>
		{#if error}<p role="alert" class="text-[10px] text-red-700 dark:text-red-300">{error}</p>{/if}
	</div>
</Wrapper>

<style>
	.eq-icon {
		display: flex;
		min-width: 30px;
		height: 30px;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--color-neutral-400);
		border-radius: 5px;
	}
	.eq-icon:hover {
		background-color: var(--color-neutral-300);
	}
	.eq-icon:focus-visible {
		outline: 2px solid currentColor;
		outline-offset: 2px;
	}
</style>
