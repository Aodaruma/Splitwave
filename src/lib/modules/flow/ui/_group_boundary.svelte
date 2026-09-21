<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import Wrapper from './node.svelte';
	import type { GroupPort } from '$lib/modules/pipeline/groups';
	let { data }: NodeProps = $props();
</script>

<Wrapper label={String(data.name)}>
	{#each data.ports as GroupPort[] as port (port.id)}
		<div class="relative min-h-6 px-2 text-[10px]">
			<Handle
				class="handle"
				isConnectable={false}
				id={port.id}
				type={data.side === 'source' ? 'source' : 'target'}
				position={data.side === 'source' ? Position.Right : Position.Left} />
			{port.label}
		</div>
	{/each}
	<p class="max-w-40 text-[10px] text-neutral-900">Expose more ports from an interior node’s menu.</p>
</Wrapper>
