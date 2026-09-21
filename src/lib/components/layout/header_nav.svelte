<script lang="ts">
	import { page } from '$app/state';
</script>

<div class="flex shrink-0 items-center gap-2">
	<a class:active={page.route.id === '/'} href="/" class="button-header" aria-label="Pipelines" title="Pipelines">Pipelines</a>
	<a class:active={page.route.id === '/virtual-devices'} href="/virtual-devices" class="button-header" aria-label="Virtual devices" title="Virtual devices"
		>Virtual devices</a>
	<a class:active={page.route.id === '/wiki'} href="/wiki" class="button-header" aria-label="Wiki" title="Wiki">Wiki</a>
	<a class:active={page.route.id === '/settings'} href="/settings" class="button-header" aria-label="Settings" title="Settings">Settings</a>
</div>
