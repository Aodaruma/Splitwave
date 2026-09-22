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
		editing;
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
		<div class="grid grid-cols-2 gap-x-3 gap-y-1">
			{#each [['inputs', inputs], ['outputs', outputs]] as const as [side, ports], column}
				{#each ports as port, row (port.id)}
					<div
						class="relative flex min-h-6 min-w-0 items-center gap-1 text-[10px]"
						class:justify-end={side === 'outputs'}
						style:grid-column={column + 1}
						style:grid-row={row + 1}>
						<Handle
							class="handle"
							id={port.id}
							type={side === 'inputs' ? 'target' : 'source'}
							position={side === 'inputs' ? Position.Left : Position.Right} />
						{#if editing}
							<input
								class="nodrag nopan min-w-0 flex-1 rounded bg-neutral-100 px-1"
								aria-label={`${side === 'inputs' ? 'Input' : 'Output'} port label`}
								value={port.label}
								onchange={(e) => actions.port(id, side as 'inputs' | 'outputs', port.id, 'label', e.currentTarget.value)} />
							<button class="nodrag nopan" aria-label="Move port up" onclick={() => actions.port(id, side as 'inputs' | 'outputs', port.id, 'up')}
								>↑</button>
							<button
								class="nodrag nopan"
								aria-label="Move port down"
								onclick={() => actions.port(id, side as 'inputs' | 'outputs', port.id, 'down')}>↓</button>
							<button
								class="nodrag nopan"
								aria-label="Remove unused port"
								onclick={() => actions.port(id, side as 'inputs' | 'outputs', port.id, 'remove')}>×</button>
						{:else}<span class="min-w-0 truncate px-2" class:text-right={side === 'outputs'} title={port.label}>{port.label}</span>{/if}
					</div>
				{/each}
			{/each}
		</div>
		<button class="nodrag nopan text-left text-[10px] text-neutral-900" onclick={() => (editing = !editing)}
			>{editing ? 'Done' : 'Edit port labels / order'}</button>
	</div>
</Wrapper>
