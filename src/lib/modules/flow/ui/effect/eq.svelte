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
	const W = 328,
		H = 144;
	const yPosition = (db: number) => (18 - clamp(db, -18, 18)) / 36;
	let frequencies = $derived(parametric ? eq.bands.map((b) => b.frequency) : GRAPHIC_FREQUENCIES);
	let curve = $derived.by(() =>
		Array.from({ length: 241 }, (_, i) => {
			const t = i / 240,
				db = responseDb(eq, positionFrequency(t, max), sr);
			return `${i ? 'L' : 'M'}${(t * W).toFixed(2)},${(yPosition(db) * H).toFixed(2)}`;
		}).join(' ')
	);
	const filters: { value: EqFilter; label: string }[] = [
		{ value: 'bell', label: 'Bell' },
		{ value: 'lowShelf', label: 'Low shelf' },
		{ value: 'highShelf', label: 'High shelf' },
		{ value: 'lowCut', label: 'Low cut · 12 dB/oct' },
		{ value: 'highCut', label: 'High cut · 12 dB/oct' }
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
		class="nodrag nopan nowheel flex w-[360px] flex-col gap-2"
		onkeydown={(e) => e.stopPropagation()}
		role="toolbar"
		tabindex="-1"
		aria-label="EQ controls">
		<PresetBar kind="eq" data={eq} onApply={applyPreset} />
		<label class="flex items-center justify-between text-[10px] text-neutral-800"
			>Mode
			<select
				class="nodrag nopan nowheel rounded border border-neutral-400 bg-neutral-100 p-1 text-neutral-1000"
				aria-label="EQ mode"
				value={eq.mode}
				onchange={(e) => switchMode(e.currentTarget.value as EqData['mode'])}>
				<option value="parametric">Parametric · 8 bands</option><option value="graphic">Graphic (legacy) · 10 bands</option>
			</select>
		</label>
		<p class="text-[9px] leading-snug text-neutral-700">
			{parametric
				? 'Drag a point to set frequency / gain. Q controls bandwidth or resonance.'
				: 'Fixed frequencies preserve the legacy crossover sound. Drag points to set gain.'} Modes keep separate settings; switching changes the sound.
		</p>
		<div class="rounded border border-neutral-400 bg-neutral-100 px-4 pt-3 pb-1">
			<div bind:this={plot} class="relative h-36">
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
							stroke-opacity={db === 0 ? 0.4 : 0.15}
							stroke-width="0.6" />
						<text x="2" y={yPosition(db) * H - 2} font-size="7" fill="currentColor" opacity="0.6">{db > 0 ? '+' : ''}{db}</text>
					{/each}
					{#each [100, 1000, 10000].filter((f) => f < max) as f}
						<line
							x1={frequencyPosition(f, max) * W}
							y1="0"
							x2={frequencyPosition(f, max) * W}
							y2={H}
							stroke="currentColor"
							stroke-opacity="0.15"
							stroke-width="0.6" />
					{/each}
					<path d={curve} stroke="rgb(245 158 11)" stroke-width="1.5" fill="none" opacity={eq.bypassed ? 0.4 : 1} />
				</svg>
				{#each frequencies as freq, i}
					{@const b = parametric ? eq.bands[i] : null}
					{@const gain = b ? (['lowCut', 'highCut'].includes(b.filter) ? 0 : b.gainDb) : eq.gainsDb[i]}
					<button
						type="button"
						class="nodrag nopan nowheel absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border font-mono text-[9px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 {selected ===
						i
							? 'border-amber-600 bg-amber-500 text-black'
							: 'border-neutral-600 bg-neutral-200 text-neutral-1000'}"
						style="left:{frequencyPosition(freq, max) * 100}%;top:{yPosition(gain) * 100}%;touch-action:none;opacity:{b && !b.enabled ? 0.45 : 1}"
						aria-label="Band {i + 1}, {Math.round(Math.min(freq, max))} Hz, {gain.toFixed(1)} dB{b
							? `, Q ${b.q}, ${b.filter}, ${b.enabled ? 'enabled' : 'disabled'}`
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
						ondblclick={() => resetBand(i)}>{i + 1}</button>
				{/each}
			</div>
			<div class="relative mt-3 h-3 font-mono text-[8px] text-neutral-700">
				<span class="absolute left-0">20 Hz</span>
				{#each [100, 1000, 10000].filter((f) => f < max / 1.5) as f}
					<span class="absolute -translate-x-1/2" style:left={frequencyPosition(f, max) * 100 + '%'}>{formatFreq(f)}</span>
				{/each}
				<span class="absolute right-0">{formatFreq(max)}</span>
			</div>
		</div>
		<div class="flex gap-1" role="group" aria-label="Select EQ band">
			{#each frequencies as _, i}<button
					type="button"
					class="nodrag nopan nowheel flex-1 rounded border py-0.5 text-[10px] {selected === i
						? 'border-amber-500 text-amber-700'
						: 'border-neutral-400 text-neutral-800'}"
					aria-label="Select band {i + 1}"
					aria-pressed={selected === i}
					onclick={() => (selected = i)}>{i + 1}</button
				>{/each}
		</div>
		{#if parametric}
			<div class="flex items-center justify-between gap-2 text-[10px]">
				<label class="flex items-center gap-1"
					><input
						class="nodrag nopan nowheel"
						type="checkbox"
						checked={band.enabled}
						onchange={(e) => setBand(selected, { enabled: e.currentTarget.checked })} />Band {selected + 1}</label>
				<select
					class="nodrag nopan nowheel rounded border border-neutral-400 bg-neutral-100 p-1"
					aria-label="Band filter type"
					value={band.filter}
					onchange={(e) => setBand(selected, { filter: e.currentTarget.value as EqFilter })}
					>{#each filters as f}<option value={f.value}>{f.label}</option>{/each}</select>
			</div>
		{/if}
		<div class="flex gap-3">
			<Knob
				label="Freq"
				value={parametric ? Math.min(band.frequency, max) : frequencies[selected]}
				min={20}
				max={parametric ? max : 20000}
				step={1}
				unit="Hz"
				logarithmic
				disabled={!parametric}
				defaultValue={BAND_FREQUENCIES[Math.min(selected, 7)]}
				onChange={(v) => setBand(selected, { frequency: v })} />
			<Knob
				label="Gain"
				value={cut ? 0 : parametric ? band.gainDb : eq.gainsDb[selected]}
				min={-18}
				max={18}
				step={0.1}
				unit="dB"
				disabled={cut}
				defaultValue={0}
				onChange={(v) => setGain(selected, v)} />
			<Knob
				label="Q"
				value={parametric ? band.q : Math.SQRT1_2}
				min={0.1}
				max={12}
				step={0.01}
				logarithmic
				disabled={!parametric}
				defaultValue={1}
				onChange={(v) => setBand(selected, { q: v })} />
		</div>
		{#if cut}<p class="text-[9px] text-neutral-700">Gain is not applicable to cut filters. Q sets resonance.</p>{/if}
		{#if parametric && eq.bands.some((b) => b.frequency > max)}<p class="text-[9px] text-amber-700">
				Frequencies above {Math.round(max)} Hz are limited to 49% of this sample rate. Saved values are retained.
			</p>{/if}
		{#if !parametric && sr <= 22628}<p role="alert" class="text-[9px] text-red-600">
				Legacy EQ requires a sample rate above 22628 Hz. Select Parametric for this rate.
			</p>{/if}
		<p id="{id}-eq-help" class="text-[9px] text-neutral-700">
			Shift: fine adjustment · Arrows: frequency / gain · Double-click or Home: reset point · Knobs: ↑↓ / ←→, Enter to reset
		</p>
		{#if error}<p role="alert" class="text-[9px] text-red-600">{error}</p>{/if}
	</div>
</Wrapper>
