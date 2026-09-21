<script lang="ts">
	import { appSettings } from '$lib/modules/settings/stores.svelte';
	import { Pulse } from '$lib/components/icons';
	import { formatHz } from '$lib/components/format';

	let rateFormatted = $derived(formatHz(appSettings.pipelineSampleRate));
</script>

<span
	class="badge-header"
	title="Pipeline sample rate: {appSettings.pipelineSampleRate.toLocaleString()} Hz. Internal effects, mixing, and routing process at this rate.">
	<Pulse class="size-4 shrink-0 text-neutral-500" />
	<span>{rateFormatted}</span>
</span>
