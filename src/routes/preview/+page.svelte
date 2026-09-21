<script lang="ts">
	import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
	import '$lib/modules/theme/stores';
	import Grid from './_grid.svelte';
	import { defaultDataFor } from '$lib/modules/flow/utils';
	import type { Pipeline } from '$lib/modules/pipeline/types';
	import { PIPELINE_VERSION } from '$lib/modules/pipeline/version';
	import { Flow } from '$lib/modules/flow/ui';
	import Header from '$lib/components/layout/header.svelte';
	import { UndoRedo, SavedIndicator, SnapshotHistory } from '$lib/modules/flow/ui';
	import { ActivationButton } from '$lib/modules/audio/ui';
	import { ArrowLeft } from '$lib/components/icons';
	import { methods as pipelineMethods } from '$lib/modules/pipeline/methods';
	import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
	let interactive = $state(false);

	const SPLITWAVE_DEVICE = { id: 'splitwave', name: 'Splitwave' };
	window.__TAURI_OS_PLUGIN_INTERNALS__ ??= {
		platform: 'windows',
		os_type: 'windows',
		family: 'windows',
		arch: 'x86_64',
		version: '11',
		eol: '\r\n',
		exe_extension: 'exe'
	};
	mockWindows('main');
	const demo: Pipeline = {
		id: 'preview',
		name: 'Editor preview',
		createdAt: 0,
		updatedAt: 0,
		version: PIPELINE_VERSION,
		nodes: [
			{ id: 'preview-input', kind: 'microphone', data: { ...defaultDataFor('microphone'), deviceId: 'splitwave' }, position: { x: 0, y: 0 } },
			{ id: 'preview-eq', kind: 'eq', data: defaultDataFor('eq'), position: { x: 320, y: 0 } },
			{ id: 'preview-gain', kind: 'gain', data: defaultDataFor('gain'), position: { x: 760, y: 200 } },
			{ id: 'preview-output', kind: 'speaker', data: { ...defaultDataFor('speaker'), deviceId: 'splitwave' }, position: { x: 1050, y: 0 } }
		],
		edges: [1, 2].map((ch) => ({
			id: `preview-edge-${ch}`,
			source: 'preview-input',
			sourceHandle: `ch${ch}`,
			target: 'preview-eq',
			targetHandle: `ch${ch}`
		}))
	};
	let displayedDemo = $state.raw(demo);
	async function openDemo() {
		displayedDemo = (await pipelineMethods.get(demo.id)) ?? demo;
		interactive = true;
	}
	async function closeDemo() {
		const snapshot = pipelineStore.editorActions?.getSnapshot();
		if (snapshot) await pipelineStore.save(snapshot);
		interactive = false;
	}
	const values = new Map<string, unknown>([['pipeline:preview', demo]]);
	mockIPC(
		(cmd, args) => {
			const payload = args as Record<string, unknown> | undefined;
			if (cmd === 'list_input_devices') return [{ ...SPLITWAVE_DEVICE, kind: 'input' }];
			if (cmd === 'list_output_devices') return [{ ...SPLITWAVE_DEVICE, kind: 'output' }];
			if (cmd === 'device_info' || cmd === 'capture_device_info') return { sampleRate: 48000, channels: 2, sampleFormat: 'f32' };
			if (cmd === 'get_device_volume') return 0.75;
			if (cmd === 'scan_plugins') return [];
			if (cmd.startsWith('list_')) return [];
			if (cmd === 'get_app_icons') return {};
			if (cmd === 'is_pipeline_running') return false;
			if (cmd === 'plugin:store|entries') return [...values.entries()];
			if (cmd === 'plugin:store|get') return [values.get(String(payload?.key)), values.has(String(payload?.key))];
			if (cmd === 'plugin:store|set') values.set(String(payload?.key), JSON.parse(JSON.stringify(payload?.value)));
			if (cmd === 'plugin:store|delete') return values.delete(String(payload?.key));
			return undefined;
		},
		{ shouldMockEvents: true }
	);
</script>

<svelte:head>
	<style>
		:root {
			color-scheme: light;
		}
		html.dark {
			color-scheme: dark;
		}
	</style>
</svelte:head>

{#if interactive}
	<Header>
		{#snippet left()}
			<button class="button-header" onclick={closeDemo}><ArrowLeft class="size-4" /> Back</button>
			<span class="text-[13px]">Editor preview</span>
		{/snippet}
		{#snippet right()}
			<div class="flex items-center gap-2">
				<UndoRedo /><SnapshotHistory pipelineId={demo.id} /><SavedIndicator /><ActivationButton pipelineId={demo.id} />
			</div>
		{/snippet}
	</Header>
	<div class="flex min-h-0 w-full flex-1"><Flow pipeline={displayedDemo} /></div>
{:else}
	<button class="button-main primary m-4 self-start" onclick={openDemo}>Open interactive editor demo</button>
	<div class="min-h-0 flex-1 overflow-auto"><Grid /></div>
{/if}
