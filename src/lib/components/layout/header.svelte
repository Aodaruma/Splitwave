<script lang="ts">
	import type { Snippet } from 'svelte';
	import { slide } from 'svelte/transition';
	import { themeStore, type ThemePref } from '$lib/modules/theme/stores';
	import { platform } from '@tauri-apps/plugin-os';
	import { getCurrentWindow } from '@tauri-apps/api/window';
	import { modalManager } from '$lib/modules/overlay/modal';
	import { AboutModal } from '$lib/modules/about/ui';
	import { checkForUpdates } from '$lib/modules/updater';
	import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
	import { audioStore } from '$lib/modules/audio/stores.svelte';
	import { Popover } from '$lib/modules/overlay/ui';
	import { AnnouncementBanner } from '$lib/modules/announcements';
	import { Dismiss, Maximize, Minus, Navigation, ThemeIcon } from '$lib/components/icons';

	interface Props {
		left?: Snippet;
		toolbar?: Snippet;
		right?: Snippet;
	}

	let { left, toolbar, right }: Props = $props();

	// macOS keeps its native menu + overlay traffic lights. Linux and Windows run
	// decoration-less, so the header carries the window controls and the menu
	// actions that would otherwise live in the native menu bar.
	const customTitlebar = platform() === 'linux' || platform() === 'windows';
	const win = customTitlebar ? getCurrentWindow() : null;

	let menuOpen = $state(false);
	let nextTheme: ThemePref = $derived($themeStore === 'light' ? 'dark' : $themeStore === 'dark' ? 'system' : 'light');
	let themeLabel = $derived(`Theme: ${$themeStore}. Switch to ${nextTheme}`);

	function about() {
		menuOpen = false;
		modalManager.open('', AboutModal, { canClose: true });
	}
	function checkUpdates() {
		menuOpen = false;
		checkForUpdates().catch(() => {});
	}
	function cycleTheme() {
		$themeStore = nextTheme;
	}
	function undo() {
		menuOpen = false;
		pipelineStore.editorActions?.undo();
	}
	function redo() {
		menuOpen = false;
		pipelineStore.editorActions?.redo();
	}
</script>

<header
	data-tauri-drag-region
	class:editor-header={!!toolbar}
	class={['z-500 flex h-10 w-full shrink-0 flex-row items-center gap-2 border-b border-theme/5 bg-background px-1.5', customTitlebar ? 'pl-3' : 'pl-20']}>
	<div data-tauri-drag-region class="header-content flex min-w-0 flex-1 items-center gap-3 overflow-x-auto py-1">
		{@render left?.()}
		{#if toolbar}
			<div data-tauri-drag-region class="editor-toolbar flex min-w-max flex-1 items-center gap-3">
				<div class="flex shrink-0 items-center gap-2">{@render toolbar()}</div>
				{#if right}
					<div class="ml-auto shrink-0">{@render right()}</div>
				{/if}
			</div>
		{:else if right}
			<div class="ml-auto shrink-0">{@render right()}</div>
		{/if}
	</div>

	<div class="window-actions flex shrink-0 flex-row items-center gap-2">
		<button type="button" class="button-header icon-only" aria-label={themeLabel} title={themeLabel} onclick={cycleTheme}>
			{#key $themeStore}
				<span class="theme-icon flex size-4"><ThemeIcon theme={$themeStore} /></span>
			{/key}
		</button>

		{#if customTitlebar}
			<Popover bind:open={menuOpen} placement="bottom-end" offsetPx={6}>
				{#snippet trigger()}
					<button type="button" class="button-header icon-only" aria-label="Menu" title="Menu" aria-expanded={menuOpen}>
						<Navigation />
					</button>
				{/snippet}

				<div class="min-w-48 overflow-hidden rounded-lg border border-neutral-400 bg-neutral-100 py-1 shadow-lg">
					<button type="button" class="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-200" onclick={about}>About Splitwave</button>
					<button type="button" class="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-200" onclick={checkUpdates}
						>Check for Updates…</button>
					<div class="my-1 border-t border-neutral-300"></div>
					<button type="button" class="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-200" onclick={undo}>Undo</button>
					<button type="button" class="block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-200" onclick={redo}>Redo</button>
				</div>
			</Popover>

			<div class="flex shrink-0 items-center gap-0.5">
				<button type="button" class="button-header icon-only" aria-label="Minimize" title="Minimize" onclick={() => win?.minimize()}>
					<Minus class="size-4" />
				</button>
				<button type="button" class="button-header icon-only" aria-label="Maximize" title="Maximize" onclick={() => win?.toggleMaximize()}>
					<Maximize />
				</button>
				<button
					type="button"
					class="button-header icon-only hover:!bg-red-500 hover:!text-white"
					aria-label="Close"
					title="Close"
					onclick={() => win?.close()}>
					<Dismiss />
				</button>
			</div>
		{/if}
	</div>
</header>

{#if audioStore.safeMode}
	<div
		transition:slide={{ duration: 150 }}
		class="relative z-40 flex w-full items-center justify-between border-b border-amber-500/20 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-600 dark:text-amber-400">
		<div class="flex items-center gap-2">
			<span class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wider uppercase">Safe Mode</span>
			<span>Auto-starting audio pipeline was skipped because Splitwave crashed last time.</span>
		</div>
		<button type="button" class="btn-warning px-3 py-0.5 text-xs" onclick={() => (audioStore.safeMode = false)}> Dismiss </button>
	</div>
{/if}

<AnnouncementBanner />

<style>
	.editor-header {
		column-gap: 1.5rem;
	}

	.header-content {
		scrollbar-width: none;
	}
	.header-content::-webkit-scrollbar {
		display: none;
	}

	@media (max-width: 1199px) {
		.editor-header {
			display: grid;
			height: auto;
			min-height: 2.5rem;
			grid-template-columns: minmax(0, 1fr) auto;
			row-gap: 0;
			padding-block: 0.375rem;
		}

		.editor-header .header-content {
			display: contents;
		}

		.editor-toolbar {
			grid-column: 1 / -1;
			grid-row: 2;
			min-width: 0;
			flex-wrap: wrap;
			padding-top: 0.5rem;
		}

		.editor-header .window-actions {
			grid-column: 2;
			grid-row: 1;
		}
	}
</style>
