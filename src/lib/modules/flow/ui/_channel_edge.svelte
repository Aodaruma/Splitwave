<script lang="ts">
	import { BaseEdge, getBezierPath, getSmoothStepPath, getStraightPath, useSvelteFlow, type EdgeProps } from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import { darken, handleColor } from '$lib/modules/flow/utils';
	import type { EdgeLayout } from '$lib/modules/pipeline/types';
	import { EDGE_ACTIONS, type EdgeActions } from '../utils/edge_actions';
	import { reroutePath } from '../utils/layout';
	import { edgeSettings } from '../edge_settings.svelte';

	let { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, sourceHandleId, selected, markerEnd, data }: EdgeProps = $props();
	const actions = getContext<EdgeActions | undefined>(EDGE_ACTIONS);
	const flow = useSvelteFlow();
	const PIN_W = 3;
	const PIN_H = 6;
	let color = $derived(handleColor(sourceHandleId));
	let points = $derived((data as EdgeLayout | undefined)?.reroutes ?? []);
	let editable = $derived(actions?.editable(id) ?? false);
	let pending = $derived(actions?.pending(id) ?? false);
	let path = $derived.by(() => {
		if (points.length) return reroutePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, points);
		const p = { sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition };
		switch (edgeSettings.shape) {
			case 'straight':
				return getStraightPath(p)[0];
			case 'step':
				return getSmoothStepPath({ ...p, borderRadius: 0 })[0];
			case 'smoothstep':
				return getSmoothStepPath(p)[0];
			default:
				return getBezierPath(p)[0];
		}
	});

	function add(event: MouseEvent) {
		if (!editable || event.button !== 0 || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
		event.preventDefault();
		event.stopPropagation();
		actions?.add(
			id,
			flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }),
			{ x: sourceX, y: sourceY },
			{ x: targetX, y: targetY }
		);
	}
	function menu(event: MouseEvent, index?: number) {
		if (!editable) return;
		event.preventDefault();
		event.stopPropagation();
		actions?.menu(id, event, { x: sourceX, y: sourceY }, { x: targetX, y: targetY }, index);
	}
</script>

<!-- Capture precedes the canvas d3 double-click zoom handler. -->
<BaseEdge {id} {path} style="stroke:transparent;stroke-width:6px" {markerEnd} ondblclickcapture={add} oncontextmenu={menu} />
<g class="pointer-events-none" opacity={selected ? 0.4 : 1}>
	{#if pending}<path d={path} fill="none" stroke="var(--color-amber-500, #f59e0b)" stroke-width="9" opacity="0.7" />{/if}
	<path d={path} fill="none" stroke={color} stroke-width="2" />
	{#if edgeSettings.pins}
		{#each [[sourceX, sourceY], [targetX, targetY]] as [x, y], end (end)}
			<rect x={x - PIN_W / 2} y={y - PIN_H / 2} width={PIN_W} height={PIN_H} rx="1" fill={color} stroke={darken(color)} stroke-width="0.5" />
		{/each}
	{/if}
</g>
{#if editable}
	{#each points as point, index (index)}
		<circle
			class="reroute-point nodrag nopan nowheel nokey"
			class:shown={selected}
			data-reroute-point={index}
			data-reroute-edge={id}
			cx={point.x}
			cy={point.y}
			r="7"
			fill={color}
			stroke="var(--color-neutral-100, white)"
			stroke-width="2"
			role="button"
			tabindex="0"
			aria-label={`Cable point ${index + 1}. Drag to move; Delete to remove.`}
			onpointerdown={(event) => actions?.start(id, index, event)}
			onmousedown={(event) => event.stopPropagation()}
			onclick={(event) => event.stopPropagation()}
			ondblclick={(event) => event.stopPropagation()}
			onkeydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					event.stopPropagation();
				}
			}}
			oncontextmenu={(event) => menu(event, index)} />
	{/each}
{/if}

<style>
	.reroute-point {
		opacity: 0.2;
		cursor: move;
		pointer-events: all;
	}
	:global(.svelte-flow__edge:hover) .reroute-point,
	.reroute-point.shown,
	.reroute-point:focus {
		opacity: 1;
	}
	.reroute-point:focus {
		outline: none;
		stroke-width: 4;
	}
</style>
