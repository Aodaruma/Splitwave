<script lang="ts">
	import Gauge from '$lib/components/icons/gauge.svelte';
	import { methods } from '../methods';
	import { audioStore } from '../stores.svelte';

	let latencyMs = $state<number | null>(null);

	$effect(() => {
		if (!audioStore.isRunning) {
			latencyMs = null;
			return;
		}
		let cancelled = false;
		const poll = async () => {
			const v = await methods.getOutputLatency().catch(() => null);
			if (!cancelled) latencyMs = v;
		};
		void poll();
		const id = setInterval(() => void poll(), 500);
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	});
</script>

{#if latencyMs !== null && latencyMs > 0}
	<span class="badge-header" title="Total latency (input + all nodes + output buffer)">
		<Gauge class="size-4 shrink-0 text-neutral-500" />
		<span class="min-w-[6ch] text-right">{latencyMs} ms</span>
	</span>
{/if}
