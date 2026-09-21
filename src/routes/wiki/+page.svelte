<script lang="ts">
	import Header from '$lib/components/layout/header.svelte';
	import HeaderNav from '$lib/components/layout/header_nav.svelte';

	const ENTRIES = [
		{
			title: 'Multi-select channels with Option',
			video: '/wiki/alt_connect.mp4',
			body: 'Hold Option (Alt on Windows/Linux) while picking channels to select several at once, then drag them together as one connection.'
		},
		{
			title: 'Select, copy and paste nodes',
			video: '/wiki/ctrl_copy_paste.mp4',
			body: 'Press Ctrl+A (Cmd+A) to select every node on the canvas. Copy with Ctrl+C and paste with Ctrl+V (Cmd on macOS). Ctrl/Cmd+D duplicates the selected nodes nearby immediately, including their sizes, settings and internal audio connections, without replacing the clipboard. Each duplicate is one undo step. Copies clear mute hotkeys and recording destinations; choose a new recording path. Plugin copies keep the saved state: close the plugin editor first to capture its latest settings. Live peer connections are not copied.'
		},
		{
			title: 'Select and move on the canvas',
			video: '/wiki/shift_select.mp4',
			body: 'Left-drag the background to box-select, left-drag a node body to move it, and middle-drag to pan. Right-click opens the context menu. On macOS, scroll pans and pinch zooms; on Windows/Linux, the wheel zooms. Settings → Canvas lets you choose Pan for a trackpad or Zoom for a mouse.'
		},
		{
			title: 'Connect node bodies with Alt + right-drag',
			video: null,
			body: 'Hold Alt (Option on macOS) and right-drag a node body onto another node body. Audio flows from the dragged node to the destination, without moving either node. Normal audio channels connect together in one undo step, preserving L/R and channel numbers within the available capacity. Inputs can still mix several sources. Existing wires remain; duplicate connections, cycles, self-connections, sidechains and individual peer routes are skipped. Channels must be available on the source. Controls and sockets keep their own gestures. Escape, releasing outside a node, or switching windows cancels.'
		},
		{
			title: 'Cut, detach and switch connections',
			video: null,
			body: 'Ctrl + right-drag across cables to cut them on release. Alt (Option) + left-drag a node body, or deliberately shake it while dragging, to detach its connections and move it. Escape cancels; one Undo restores the move and cables. Alt+S switches the inputs of one selected node: a single input advances, two exchange, and more rotate through the connected compatible inputs. Group boundary mappings are protected.'
		},
		{
			title: 'Toggle the snap grid',
			video: null,
			body: 'Click Grid ON/OFF in the editor or press Shift+Tab while the canvas has focus. Settings uses the same saved switch and spacing. Enabling snap does not move existing nodes. Shift+Tab in forms, dialogs and buttons still moves focus backward.'
		},
		{
			title: 'Delete multiple connections at once',
			video: '/wiki/shift_delete_edges.mp4',
			body: 'Hold Shift and click each connection you want to remove, then press Delete to drop them all at once.'
		}
	];
</script>

<Header>
	{#snippet left()}
		<HeaderNav />
	{/snippet}
</Header>

<div class="min-h-0 flex-1 overflow-y-auto p-8">
	<div class="flex max-w-2xl flex-col gap-8">
		{#each ENTRIES as entry (entry.title)}
			<section class="flex flex-col gap-3">
				<div>
					<h2 class="text-sm font-semibold text-theme">{entry.title}</h2>
					<p class="text-xs text-neutral-900">{entry.body}</p>
				</div>

				{#if entry.video}
					<video autoplay loop muted playsinline class="w-full rounded-xl border border-neutral-400 bg-neutral-100">
						<source src={entry.video} type="video/mp4" />
						<source src={entry.video.replace('.mp4', '.webm')} type="video/webm" />
					</video>
				{/if}
			</section>
		{/each}
	</div>
</div>
