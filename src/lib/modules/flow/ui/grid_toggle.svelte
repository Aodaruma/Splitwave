<script lang="ts">
	import { Grid } from '$lib/components/icons';
	import { Tooltip } from '$lib/modules/overlay/ui';
	import { appSettings } from '$lib/modules/settings/stores.svelte';

	const descriptionId = $props.id();
	let description = $derived(`Snap to grid: ${appSettings.snapToGrid ? `on · ${appSettings.gridSize}` : 'off'} (Shift+Tab on canvas)`);

	function toggle() {
		appSettings.snapToGrid = !appSettings.snapToGrid;
		appSettings.persist();
	}
</script>

<Tooltip text={description} placement="bottom">
	<button
		type="button"
		class="button-header icon-only border border-transparent aria-pressed:border-primary aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/25"
		aria-label="Snap to grid"
		aria-describedby={descriptionId}
		aria-pressed={appSettings.snapToGrid}
		aria-keyshortcuts="Shift+Tab"
		title={description}
		onclick={toggle}>
		<Grid />
	</button>
</Tooltip>
<span id={descriptionId} class="sr-only">{description}</span>
