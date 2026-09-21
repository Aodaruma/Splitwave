<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
	import { Checkmark } from '$lib/components/icons';
	import { relativeTime } from '$lib/utils/time';

	let now = $state(Date.now());
	let timer: ReturnType<typeof setInterval> | undefined;
	onMount(() => {
		timer = setInterval(() => (now = Date.now()), 1000);
	});
	onDestroy(() => {
		if (timer !== undefined) clearInterval(timer);
	});

	let label = $derived.by(() => {
		now;
		const ms = pipelineStore.lastSavedAt;
		if (ms === 0) return '—';
		if (Date.now() - ms < 2000) return 'just now';
		return relativeTime(ms);
	});
</script>

<div class="flex h-7 shrink-0 items-center gap-1.5 text-[13px] leading-none whitespace-nowrap text-neutral-900" title="Saved {label}">
	<Checkmark class="size-4 shrink-0 text-green-600" />
	<span class="font-mono tabular-nums">Saved {label}</span>
</div>
