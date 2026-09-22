<script lang="ts">
	import { getContext } from 'svelte';
	import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/svelte';
	import Wrapper from './node.svelte';
	import { Layers } from '$lib/components/icons';
	import type { GroupPort } from '$lib/modules/pipeline/groups';
	import { GROUP_ACTIONS } from '../utils/group_view';
	let { id, data }: NodeProps = $props();
	const actions = getContext<{
		rename: (id: string, name: string) => void;
		port: (id: string, side: 'inputs' | 'outputs', port: string, action: string, label?: string) => void;
		usage: (id: string) => number;
	}>(GROUP_ACTIONS);
	let editing = $state(false);
	let inputs = $derived((data.inputs ?? []) as GroupPort[]);
	let outputs = $derived((data.outputs ?? []) as GroupPort[]);
	const updateNodeInternals = useUpdateNodeInternals();
	$effect(() => {
		inputs;
		outputs;
		updateNodeInternals(id);
	});
</script>

<Wrapper label="Node group" variant="group" icon={Layers}>
	<div class="flex w-52 flex-col gap-2">
		<input
			class="nodrag nopan rounded border border-neutral-400 bg-neutral-100 px-2 py-1 text-xs"
			aria-label="Group name"
			value={String(data.name)}
			onchange={(e) => actions.rename(id, e.currentTarget.value)} />
		<p class="text-[10px] text-neutral-900">
			{actions.usage(String(data.definition)) > 1 ? `Shared · ${actions.usage(String(data.definition))} uses. Edits apply to all.` : 'Independent group'}
		</p>
		{#each [['inputs', inputs], ['outputs', outputs]] as const as [side, ports]}
			{#each ports as port (port.id)}
				<div class="relative flex min-h-6 items-center gap-1 text-[10px]">
					<Handle
						class="handle"
						id={port.id}
						type={side === 'inputs' ? 'target' : 'source'}
						position={side === 'inputs' ? Position.Left : Position.Right} />
					{#if editing}
						<input
							class="nodrag nopan min-w-0 flex-1 rounded bg-neutral-100 px-1"
							aria-label="Port label"
							value={port.label}
							onchange={(e) => actions.port(id, side as 'inputs' | 'outputs', port.id, 'label', e.currentTarget.value)} />
						<button class="nodrag nopan" aria-label="Move port up" onclick={() => actions.port(id, side as 'inputs' | 'outputs', port.id, 'up')}
							>↑</button>
						<button class="nodrag nopan" aria-label="Move port down" onclick={() => actions.port(id, side as 'inputs' | 'outputs', port.id, 'down')}
							>↓</button>
						<button
							class="nodrag nopan"
							aria-label="Remove unused port"
							onclick={() => actions.port(id, side as 'inputs' | 'outputs', port.id, 'remove')}>×</button>
					{:else}<span class="px-2">{side === 'inputs' ? '→' : '←'} {port.label}</span>{/if}
				</div>
			{/each}
		{/each}
		<button class="nodrag nopan text-left text-[10px] text-neutral-900" onclick={() => (editing = !editing)}
			>{editing ? 'Done' : 'Edit port labels / order'}</button>
	</div>
</Wrapper>
