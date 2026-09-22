<script lang="ts">
	import { getContext, onMount, tick } from 'svelte';
	import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/svelte';
	import Wrapper from './node.svelte';
	import { Dismiss } from '$lib/components/icons';
	import type { GroupPort } from '$lib/modules/pipeline/groups';
	import { GROUP_ACTIONS } from '../utils/group_view';
	import { NEW_GROUP_PORT, type PortSide } from '../utils/group_ports';
	let { id, data }: NodeProps = $props();
	const actions = getContext<{
		boundaryPort: (side: PortSide, id: string, action: string, label?: string) => void;
		addBoundaryPort: (side: PortSide) => void;
		reorderBoundaryPort: (side: PortSide, id: string, target: string) => void;
	}>(GROUP_ACTIONS);
	let ports = $derived(data.ports as GroupPort[]);
	let side: PortSide = $derived(data.side === 'source' ? 'inputs' : 'outputs');
	let editing = $state<string>();
	let label = $state('');
	let list: HTMLDivElement;
	let drag = $state<{ id: string; target: string; pointer: number; y: number; moved: boolean }>();
	const updateNodeInternals = useUpdateNodeInternals();
	$effect(() => {
		ports;
		editing;
		updateNodeInternals(id);
	});
	$effect(() => {
		ports;
		drag = undefined;
	});
	onMount(() => {
		const cancel = (e: KeyboardEvent) => {
			if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && ['z', 'y'].includes(e.key.toLowerCase()))) drag = undefined;
		};
		window.addEventListener('keydown', cancel, true);
		return () => window.removeEventListener('keydown', cancel, true);
	});
	function edit(port: GroupPort) {
		drag = undefined;
		label = port.label;
		editing = port.id;
	}
	function commitLabel() {
		const port = ports.find((p) => p.id === editing);
		editing = undefined;
		if (port && label.trim() && label.trim() !== port.label) actions.boundaryPort(side, port.id, 'label', label);
	}
	function focusLabel(input: HTMLInputElement) {
		void tick().then(() => {
			input.focus();
			input.select();
		});
	}
	function startDrag(e: PointerEvent, port: GroupPort) {
		if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		drag = { id: port.id, target: port.id, pointer: e.pointerId, y: e.clientY, moved: false };
	}
	function moveDrag(e: PointerEvent) {
		if (!drag || drag.pointer !== e.pointerId) return;
		if (!drag.moved && Math.abs(e.clientY - drag.y) < 5) return;
		drag.moved = true;
		const rows = [...list.querySelectorAll<HTMLElement>('[data-port-row]')];
		const distance = (row: HTMLElement) => {
			const rect = row.getBoundingClientRect();
			return Math.abs(e.clientY - rect.top - rect.height / 2);
		};
		const nearest = rows.reduce((best, row) => (distance(row) < distance(best) ? row : best));
		drag.target = nearest.dataset.portRow!;
	}
	function finishDrag(e: PointerEvent) {
		if (!drag || drag.pointer !== e.pointerId) return;
		const done = drag;
		drag = undefined;
		if (done.moved && done.id !== done.target) actions.reorderBoundaryPort(side, done.id, done.target);
	}
</script>

<svelte:window onblur={() => (drag = undefined)} />

<Wrapper label={String(data.name)}>
	<div bind:this={list} class="w-40">
		{#each ports as port (port.id)}
			<div
				class="group/port relative flex min-h-7 items-center rounded text-[11px]"
				data-port-row={port.id}
				class:text-neutral-700={port.disconnected}
				class:drop-target={drag?.moved && drag.target === port.id && drag.id !== port.id}
				class:opacity-50={drag?.moved && drag.id === port.id}>
				<Handle
					class="handle"
					isConnectable={!!port.disconnected}
					id={port.id}
					type={data.side === 'source' ? 'source' : 'target'}
					position={data.side === 'source' ? Position.Right : Position.Left} />
				{#if editing === port.id}
					<input
						use:focusLabel
						class="nodrag nopan mx-2 w-full min-w-0 rounded bg-neutral-100 px-1 py-1"
						aria-label="Port label"
						bind:value={label}
						onblur={commitLabel}
						onkeydown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								commitLabel();
							}
							if (e.key === 'Escape') {
								e.stopPropagation();
								editing = undefined;
							}
						}} />
				{:else}
					<button
						class="nodrag nopan min-w-0 flex-1 cursor-ns-resize truncate px-2 py-1.5 text-left select-none"
						title={`${port.label}${port.disconnected ? ' · Disconnected' : ''}\nDrag to reorder · Double-click to rename · Alt+↑/↓ to reorder`}
						ondblclickcapture={(e) => {
							e.preventDefault();
							e.stopPropagation();
							edit(port);
						}}
						onpointerdown={(e) => startDrag(e, port)}
						onpointermove={moveDrag}
						onpointerup={finishDrag}
						onpointercancel={() => (drag = undefined)}
						onlostpointercapture={() => (drag = undefined)}
						onkeydown={(e) => {
							if (e.key === 'Enter' || e.key === 'F2') {
								e.preventDefault();
								edit(port);
							}
							if (e.altKey && ['ArrowUp', 'ArrowDown'].includes(e.key)) {
								e.preventDefault();
								e.stopPropagation();
								actions.boundaryPort(side, port.id, e.key === 'ArrowUp' ? 'up' : 'down');
							}
						}}>{port.label}</button>
					<button
						class="nodrag nopan mr-1 rounded p-0.5 opacity-0 group-hover/port:opacity-100 focus:opacity-100"
						aria-label={`Remove port ${port.label}`}
						title="Remove unused port"
						onclick={() => actions.boundaryPort(side, port.id, 'remove')}><Dismiss class="size-3" /></button>
				{/if}
			</div>
		{/each}
		<div class="relative mt-1 rounded border border-dashed border-neutral-600 text-[11px] text-neutral-1100">
			<Handle
				class="handle"
				id={NEW_GROUP_PORT}
				type={data.side === 'source' ? 'source' : 'target'}
				position={data.side === 'source' ? Position.Right : Position.Left}
				aria-label={side === 'inputs' ? 'New group input' : 'New group output'} />
			<button class="nodrag nopan w-full px-2 py-1.5 text-left hover:bg-neutral-200" onclick={() => actions.addBoundaryPort(side)}
				>+ {side === 'inputs' ? 'Input' : 'Output'}</button>
		</div>
	</div>
</Wrapper>

<style>
	.drop-target {
		outline: 1px solid var(--color-primary);
		background: var(--color-neutral-200);
	}
</style>
