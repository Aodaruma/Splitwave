<script lang="ts">
	import { getContext } from 'svelte';
	import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/svelte';
	import Wrapper from './node.svelte';
	import { Layers, ChevronDown, Copy, Checkmark } from '$lib/components/icons';
	import { Popover, Menu, MenuItem } from '$lib/modules/overlay/ui';
	import type { GroupPort } from '$lib/modules/pipeline/groups';
	import { GROUP_ACTIONS } from '../utils/group_view';
	let { id, data }: NodeProps = $props();
	const actions = getContext<{
		rename: (id: string, name: string) => void;
		usage: (id: string) => number;
		choices: () => { id: string; name: string }[];
		refresh: () => Promise<void>;
		select: (id: string, definition: string) => void;
		independent: (id: string) => void;
	}>(GROUP_ACTIONS);
	let open = $state(false);
	let uses = $derived(actions.usage(String(data.definition)));
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
		<div class="nodrag nopan flex min-w-0 rounded border border-neutral-400 bg-neutral-100">
			<Popover
				bind:open
				onOpenChange={(value) => {
					if (value) void actions.refresh();
				}}>
				{#snippet trigger()}
					<button
						class="rounded-l border-r border-neutral-400 px-1.5 hover:bg-neutral-200"
						aria-label="Choose group"
						aria-expanded={open}
						title="Choose group">
						<ChevronDown class="size-3.5" />
					</button>
				{/snippet}
				<Menu class="nodrag nopan nowheel w-64">
					<div class="max-h-56 overflow-y-auto">
						{#each actions.choices() as choice (choice.id)}
							<MenuItem
								icon={choice.id === data.definition ? Checkmark : Layers}
								onclick={() => {
									if (choice.id !== data.definition) actions.select(id, choice.id);
									open = false;
								}}><span class="block truncate" title={choice.name}>{choice.name}</span></MenuItem>
						{/each}
					</div>
					<div class="my-1 border-t border-neutral-400"></div>
					<MenuItem
						icon={Copy}
						label="Make independent copy"
						onclick={() => {
							actions.independent(id);
							open = false;
						}} />
					<p class="px-3 py-1 text-[10px] text-neutral-900">Choosing a group shares its definition.</p>
				</Menu>
			</Popover>
			<input
				class="w-full min-w-0 rounded-r px-2 py-1 text-xs"
				aria-label="Group name"
				title={uses > 1 ? `Shared by ${uses} uses. Renaming applies to all.` : 'Group name'}
				value={String(data.name)}
				onblur={(e) => {
					if (e.currentTarget.value.trim() && e.currentTarget.value.trim() !== data.name) actions.rename(id, e.currentTarget.value);
					else e.currentTarget.value = String(data.name);
				}}
				onkeydown={(e) => {
					if (e.key === 'Escape') {
						e.stopPropagation();
						e.currentTarget.value = String(data.name);
						e.currentTarget.blur();
					}
					if (e.key === 'Enter') {
						e.preventDefault();
						e.currentTarget.blur();
					}
				}} />
			{#if uses > 1}
				<button
					class="shrink-0 rounded-r border-l border-neutral-400 px-2 text-xs tabular-nums hover:bg-neutral-200"
					title={`${uses} uses · Click to make this group independent`}
					aria-label={`Make independent copy (${uses} uses)`}
					onclick={() => actions.independent(id)}>{uses}</button>
			{/if}
		</div>
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
						<span class="min-w-0 truncate px-2" class:text-right={side === 'outputs'} title={port.label}>{port.label}</span>
					</div>
				{/each}
			{/each}
		</div>
	</div>
</Wrapper>
