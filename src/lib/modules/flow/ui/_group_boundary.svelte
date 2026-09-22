<script lang="ts">
	import { getContext } from 'svelte';
	import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/svelte';
	import Wrapper from './node.svelte';
	import type { GroupPort } from '$lib/modules/pipeline/groups';
	import { GROUP_ACTIONS } from '../utils/group_view';
	import { NEW_GROUP_PORT, type PortSide } from '../utils/group_ports';
	let { id, data }: NodeProps = $props();
	let editing = $state(false);
	const actions = getContext<{ boundaryPort: (side: PortSide, id: string, action: string, label?: string) => void }>(GROUP_ACTIONS);
	let ports = $derived(data.ports as GroupPort[]);
	let side: PortSide = $derived(data.side === 'source' ? 'inputs' : 'outputs');
	const updateNodeInternals = useUpdateNodeInternals();
	$effect(() => {
		ports;
		editing;
		updateNodeInternals(id);
	});
</script>

<Wrapper label={String(data.name)}>
	{#each ports as port (port.id)}
		<div class="relative flex min-h-6 items-center gap-1 px-2 text-[10px]">
			<Handle
				class="handle"
				isConnectable={false}
				id={port.id}
				type={data.side === 'source' ? 'source' : 'target'}
				position={data.side === 'source' ? Position.Right : Position.Left} />
			{#if editing}
				<input
					class="nodrag nopan w-28 min-w-0 rounded bg-neutral-100 px-1"
					aria-label="Port label"
					value={port.label}
					onchange={(e) => actions.boundaryPort(side, port.id, 'label', e.currentTarget.value)} />
				<button class="nodrag nopan" aria-label="Move port up" onclick={() => actions.boundaryPort(side, port.id, 'up')}>↑</button>
				<button class="nodrag nopan" aria-label="Move port down" onclick={() => actions.boundaryPort(side, port.id, 'down')}>↓</button>
				<button class="nodrag nopan" aria-label="Remove unused port" onclick={() => actions.boundaryPort(side, port.id, 'remove')}>×</button>
			{:else}{port.label}{/if}
		</div>
	{/each}
	<div class="relative mt-1 min-h-6 rounded border border-dashed border-neutral-600 px-2 py-1 text-[10px] text-neutral-1100">
		<Handle
			class="handle"
			id={NEW_GROUP_PORT}
			type={data.side === 'source' ? 'source' : 'target'}
			position={data.side === 'source' ? Position.Right : Position.Left}
			aria-label={side === 'inputs' ? 'New group input' : 'New group output'} />
		+ {side === 'inputs' ? 'Input' : 'Output'}
	</div>
	{#if ports.length}
		<button class="nodrag nopan mt-2 text-left text-[10px] text-neutral-1000" onclick={() => (editing = !editing)}
			>{editing ? 'Done' : 'Edit ports'}</button>
	{/if}
</Wrapper>
