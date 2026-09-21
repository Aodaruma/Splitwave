<script lang="ts">
	import { audioStore } from '../stores.svelte';
	import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
	import { Play, Stop } from '$lib/components/icons';

	let { pipelineId }: { pipelineId: string } = $props();

	let busy = $state(false);
	let label = $derived(audioStore.isRunning ? 'Stop' : 'Activate');

	async function toggle() {
		if (busy) return;
		busy = true;
		try {
			if (audioStore.isRunning) {
				await audioStore.deactivatePipeline();
			} else {
				const snapshot = pipelineStore.editorActions?.getSnapshot();
				if (!snapshot) {
					audioStore.reportError('No pipeline loaded');
					return;
				}
				await audioStore.activatePipeline(pipelineId, { nodes: snapshot.nodes, edges: snapshot.edges });
			}
		} catch (e) {
			audioStore.reportError(e);
		} finally {
			busy = false;
		}
	}
</script>

<button
	type="button"
	class={['button-header', audioStore.isRunning ? 'red' : 'green']}
	aria-label={label}
	aria-busy={busy}
	title={label}
	disabled={busy}
	onclick={toggle}>
	{#if audioStore.isRunning}
		<Stop class="size-4 shrink-0" />
	{:else}
		<Play class="size-4 shrink-0" />
	{/if}
	<span class="grid">
		<span class="invisible col-start-1 row-start-1" aria-hidden="true">Activate</span>
		<span class="col-start-1 row-start-1">{label}</span>
	</span>
</button>
