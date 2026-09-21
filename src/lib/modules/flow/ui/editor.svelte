<script lang="ts">
	import { Background, Controls, SvelteFlow, useSvelteFlow, type Edge as XyEdge, type Node as XyNode } from '@xyflow/svelte';
	import { createId } from '@paralleldrive/cuid2';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { flushSync, onDestroy, onMount, untrack } from 'svelte';
	import { platform } from '@tauri-apps/plugin-os';
	import { modalManager } from '$lib/modules/overlay/modal';
	import { copyGraph, offsetOrigin, pasteGraph } from '../utils/clipboard';
	import { planAutoConnect, type AudioPorts } from '../utils/auto_connect';
	import { canvasShortcut } from '../utils/shortcuts';
	import type { NodeKind, Pipeline } from '$lib/modules/pipeline/types';
	import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
	import { appSettings } from '$lib/modules/settings/stores.svelte';
	import { methods as pipelineMethods } from '$lib/modules/pipeline/methods';
	import { audioStore } from '$lib/modules/audio/stores.svelte';
	import { methods as audioMethods } from '$lib/modules/audio/methods';
	import { DND_MIME, defaultDataFor, emitNodeAction, fromXyEdges, fromXyNodes, nodeTypes, parseHandle, registry, toXyEdges, toXyNodes } from '../utils';
	import Sidebar from './sidebar.svelte';
	import ChannelEdge from './_channel_edge.svelte';
	import ConnectionLine from './_connection_line.svelte';
	import EdgeRectSelect from './_edge_rect_select.svelte';
	import OrphanEdges from './_orphan_edges.svelte';
	const edgeTypes = { channel: ChannelEdge };
	import { Backspace, Copy, ClipboardPaste, Delete, Folder, KeyCommand, Loop, Refresh, Rewind } from '$lib/components/icons';
	import { channelCaps, channelPorts, channelSelection } from '../stores.svelte';
	import { edgeSettings } from '../edge_settings.svelte';
	import { Menu, MenuItem as OverlayMenuItem } from '$lib/modules/overlay/ui';
	import type { Component } from 'svelte';

	let { pipeline }: { pipeline: Pipeline } = $props();

	const flow = useSvelteFlow();
	const isMac = platform() === 'macos';
	let scrollPans = $derived(appSettings.canvasScroll === 'pan' || (appSettings.canvasScroll === 'auto' && isMac));
	let editorElement: HTMLDivElement;

	function sanitizeEdges(xyNodes: XyNode[], xyEdges: XyEdge[]): XyEdge[] {
		const ids = new Set(xyNodes.map((n) => n.id));
		return xyEdges.filter((e) => ids.has(e.source) && ids.has(e.target));
	}

	let nodes = $state.raw<XyNode[]>(untrack(() => toXyNodes(pipeline.nodes)));
	let edges = $state.raw<XyEdge[]>(
		untrack(() => {
			const n = toXyNodes(pipeline.nodes);
			return sanitizeEdges(n, toXyEdges(pipeline.edges));
		})
	);

	// Fresh edges only: an already-wired armed channel would re-fire the fan-out.
	// Not `onbeforeconnect` -- xyflow 1.5.2 throws on pointer-up when it is set.
	let seenEdgeIds = new Set<string>(untrack(() => edges.map((e) => e.id)));
	$effect(() => {
		const current = edges;
		const armed = channelSelection.channels;
		const from = channelSelection.nodeId;

		untrack(() => {
			const fresh = current.filter((e) => !seenEdgeIds.has(e.id));
			seenEdgeIds = new Set(current.map((e) => e.id));
			if (!from || armed.length < 2 || fresh.length === 0) return;

			const seed = fresh.find((e) => {
				const ch = e.sourceHandle ? parseHandle(e.sourceHandle) : null;
				return e.source === from && ch !== null && armed.includes(ch);
			});
			const seedCh = seed?.sourceHandle ? parseHandle(seed.sourceHandle) : null;
			if (!seed?.targetHandle || seedCh === null) return;

			const dropped = parseHandle(seed.targetHandle) ?? 1;
			// The target may refuse the whole set: mono recording takes one channel.
			const cap = channelCaps.get(seed.target) ?? Infinity;
			// Sequential from the drop point, occupied or not: the user chose that
			// channel as the anchor, existing wiring there yields.
			const run = Array.from({ length: armed.length }, (_, i) => dropped + i).filter((ch) => ch <= cap);
			if (run.length === 0) return;

			const added: XyEdge[] = [];
			// Which physical channel was dragged from doesn't matter: mapping is
			// always ascending armed[i] -> run[i], anchored at the drop point.
			const retargeted = current.map((e) => (e.id === seed.id ? { ...e, targetHandle: `ch${run[armed.indexOf(seedCh)]}` } : e));
			armed.forEach((ch, i) => {
				if (ch === seedCh || run[i] === undefined) return;
				added.push({
					id: createId(),
					source: seed.source,
					sourceHandle: `ch${ch}`,
					target: seed.target,
					targetHandle: `ch${run[i]}`,
					animated: edgeSettings.animated,
					type: 'channel'
				});
			});
			edges = [...retargeted, ...added];
			added.forEach((e) => seenEdgeIds.add(e.id));
			channelSelection.clear();
		});
	});

	type MenuItem = {
		label: string;
		icon?: Component;
		shortcut?: string;
		danger?: boolean;
		disabled?: boolean;
		action: () => void;
	};

	type ContextMenu =
		| { kind: 'node'; nodeId: string; x: number; y: number; items: MenuItem[] }
		| { kind: 'edge'; edgeId: string; x: number; y: number; items: MenuItem[] }
		| { kind: 'pane'; x: number; y: number; flowX: number; flowY: number; items: MenuItem[] };

	let contextMenu = $state<ContextMenu | null>(null);

	function onDragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		const kind = event.dataTransfer?.getData(DND_MIME) as NodeKind | undefined;
		if (!kind || !(kind in registry)) return;
		const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
		addNode(kind, position);
	}

	function addNode(kind: NodeKind, position?: { x: number; y: number }) {
		addNodeWithData(kind, defaultDataFor(kind), position);
	}

	function addNodeWithData(kind: NodeKind, data: Record<string, unknown>, position?: { x: number; y: number }) {
		const fallback = { x: 100 + nodes.length * 40, y: 100 + nodes.length * 40 };
		const size = registry[kind].defaultSize;
		nodes = [
			...nodes,
			{
				id: createId(),
				type: kind,
				position: position ?? fallback,
				data,
				...(size ?? {})
			}
		];
	}

	function deleteNode(nodeId: string) {
		nodes = nodes.filter((n) => n.id !== nodeId);
		edges = edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
	}

	function deleteEdge(edgeId: string) {
		edges = edges.filter((e) => e.id !== edgeId);
	}

	function copyEntry(group: XyNode[]) {
		return copyGraph(
			group.map((n) => ({ ...n, data: $state.snapshot(n.data) })),
			edges
		);
	}

	function copyNodes(group: XyNode[]) {
		const entry = copyEntry(group);
		if (entry) pipelineStore.clipboard = entry;
	}

	function copySelection() {
		copyNodes(nodes.filter((n) => n.selected));
	}

	function selectAllNodes() {
		nodes = nodes.map((n) => (n.selected ? n : { ...n, selected: true }));
	}

	function insertCopy(entry: NonNullable<typeof pipelineStore.clipboard>, origin: { x: number; y: number }) {
		const graph = pasteGraph(
			$state.snapshot(entry),
			origin,
			entry.nodes.map(() => createId()),
			entry.edges.map(() => createId()),
			appSettings.snapToGrid ? appSettings.gridSize : undefined
		);
		editGraph(() => {
			nodes = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...graph.nodes];
			// Programmatic copies must not trigger the armed-handle fan-out.
			graph.edges.forEach((e) => seenEdgeIds.add(e.id));
			edges = [...edges.map((e) => (e.selected ? { ...e, selected: false } : e)), ...graph.edges];
		});
	}

	function duplicateSelection() {
		const entry = copyEntry(nodes.filter((n) => n.selected));
		if (!entry) return;
		insertCopy(entry, offsetOrigin(entry.origin, appSettings.snapToGrid ? appSettings.gridSize : undefined));
	}

	function pasteAt(position?: { x: number; y: number }) {
		const c = pipelineStore.clipboard;
		if (!c || c.nodes.length === 0) return;
		const origin = position ?? offsetOrigin(c.origin, appSettings.snapToGrid ? appSettings.gridSize : undefined);
		insertCopy(c, origin);
		pipelineStore.clipboard = { ...c, origin };
	}

	function toggleGrid() {
		appSettings.snapToGrid = !appSettings.snapToGrid;
		appSettings.persist();
	}

	const INTERACTIVE =
		'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="button"]:not(.svelte-flow__node):not(.svelte-flow__selection-wrapper), [role="slider"], [role="combobox"], .nodrag, .nopan:not(.svelte-flow__node), .svelte-flow__handle, .svelte-flow__resize-control';
	let connectDrag = $state<{ source: string; pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);
	let connectNotice = $state('');

	function bodyNode(target: EventTarget | null): HTMLElement | null {
		if (!(target instanceof Element) || target.closest(INTERACTIVE)) return null;
		const node = target.closest<HTMLElement>('.svelte-flow__node');
		return node && editorElement.contains(node) ? node : null;
	}

	function onEditorPointerDown(event: PointerEvent) {
		const target = event.target;
		if (event.button !== 0 || !(target instanceof Element) || target.closest(INTERACTIVE) || modalManager.isOpen) return;
		editorElement.focus({ preventScroll: true });
		const node = bodyNode(target);
		if (!event.altKey || !node?.dataset.id || !event.isPrimary) return;
		event.preventDefault();
		event.stopPropagation();
		closeContextMenu();
		connectNotice = '';
		const rect = editorElement.getBoundingClientRect();
		connectDrag = {
			source: node.dataset.id,
			pointerId: event.pointerId,
			startX: event.clientX - rect.left,
			startY: event.clientY - rect.top,
			x: event.clientX - rect.left,
			y: event.clientY - rect.top
		};
		editorElement.setPointerCapture(event.pointerId);
	}

	function onConnectMove(event: PointerEvent) {
		if (!connectDrag || connectDrag.pointerId !== event.pointerId) return;
		const rect = editorElement.getBoundingClientRect();
		connectDrag = { ...connectDrag, x: event.clientX - rect.left, y: event.clientY - rect.top };
	}

	function cancelConnect() {
		if (!connectDrag) return;
		const { pointerId } = connectDrag;
		connectDrag = null;
		if (editorElement.hasPointerCapture(pointerId)) editorElement.releasePointerCapture(pointerId);
	}

	function audioPorts(id: string, side: 'source' | 'target'): AudioPorts {
		const handles = flow.getInternalNode(id)?.internals.handleBounds?.[side] ?? [];
		return { id, handles: handles.map((h) => ({ id: h.id ?? null, y: h.y })), channels: channelPorts.get(id)?.[side] };
	}

	function onConnectEnd(event: PointerEvent) {
		if (!connectDrag || connectDrag.pointerId !== event.pointerId) return;
		const source = connectDrag.source;
		const moved = Math.hypot(connectDrag.x - connectDrag.startX, connectDrag.y - connectDrag.startY) >= 3;
		const target = bodyNode(document.elementFromPoint(event.clientX, event.clientY))?.dataset.id;
		cancelConnect();
		if (!moved || !target) return;
		const planned = planAutoConnect(audioPorts(source, 'source'), audioPorts(target, 'target'), edges);
		if (!planned.length) {
			connectNotice = 'No new compatible audio connections (already connected, unavailable channels, or a cycle).';
			return;
		}
		editGraph(() => {
			const added = planned.map((connection) => ({ ...connection, id: createId(), type: 'channel', animated: edgeSettings.animated }));
			added.forEach((e) => seenEdgeIds.add(e.id));
			edges = [...edges, ...added];
		});
	}

	function patchNodeData(nodeId: string, patch: Record<string, unknown>) {
		flow.updateNodeData(nodeId, patch);
	}

	function nodeMenuItems(node: XyNode): MenuItem[] {
		const items: MenuItem[] = [];
		const id = node.id;
		const data = (node.data ?? {}) as Record<string, unknown>;
		const kind = node.type as NodeKind | undefined;

		switch (kind) {
			case 'audioFile':
				items.push({
					label: 'Choose file...',
					icon: Folder,
					action: () => emitNodeAction(id, 'chooseFile')
				});
				items.push({
					label: 'Rewind',
					icon: Rewind,
					disabled: !audioStore.isRunning || !data.filePath,
					action: () => audioMethods.seekAudioFile(id, 0).catch(() => {})
				});
				items.push({
					label: data.loopEnabled ? 'Loop off' : 'Loop on',
					icon: Loop,
					action: () => patchNodeData(id, { loopEnabled: !data.loopEnabled })
				});
				break;
			case 'microphone':
			case 'appAudio':
			case 'speaker':
				items.push({
					label: 'Refresh',
					icon: Refresh,
					action: () => emitNodeAction(id, 'refresh')
				});
				break;
			case 'fileRecording':
				items.push({
					label: 'Choose file...',
					icon: Folder,
					action: () => emitNodeAction(id, 'chooseFile')
				});
				break;
			case 'mute':
				items.push({
					label: data.muted ? 'Unmute' : 'Mute',
					action: () => {
						const patch = { muted: !data.muted };
						patchNodeData(id, patch);
						audioMethods.updateEffect(id, patch).catch(() => {});
					}
				});
				break;
			case 'levelMeter':
				items.push({
					label: 'Reset peaks',
					action: () => emitNodeAction(id, 'resetPeaks')
				});
				break;
			case 'gain':
			case 'channelBalance':
			case 'saturator':
			case 'eq':
			case 'limiter':
			case 'compressor':
			case 'noiseGate':
			case 'delay':
			case 'reverb':
			case 'noiseSuppressor':
				items.push({
					label: data.bypassed ? 'Engage' : 'Bypass',
					action: () => {
						const patch = { bypassed: !data.bypassed };
						patchNodeData(id, patch);
						audioMethods.updateEffect(id, patch).catch(() => {});
					}
				});
				break;
		}

		items.push({
			label: 'Copy',
			icon: Copy,
			shortcut: '⌘C',
			action: () => copyNodes(node.selected ? nodes.filter((n) => n.selected) : [node])
		});
		items.push({
			label: 'Delete',
			icon: Delete,
			shortcut: '⌫',
			danger: true,
			action: () => deleteNode(id)
		});
		return items;
	}

	function paneMenuItems(flowX: number, flowY: number): MenuItem[] {
		return [
			{
				label: 'Paste',
				icon: ClipboardPaste,
				shortcut: '⌘V',
				disabled: pipelineStore.clipboard === null,
				action: () => pasteAt({ x: flowX, y: flowY })
			}
		];
	}

	function onNodeContextMenu({ node, event }: { node: XyNode; event: MouseEvent }) {
		event.preventDefault();
		contextMenu = {
			kind: 'node',
			nodeId: node.id,
			x: event.clientX,
			y: event.clientY,
			items: nodeMenuItems(node)
		};
	}

	function onEdgeContextMenu({ edge, event }: { edge: XyEdge; event: MouseEvent }) {
		event.preventDefault();
		contextMenu = {
			kind: 'edge',
			edgeId: edge.id,
			x: event.clientX,
			y: event.clientY,
			items: [
				{
					label: 'Delete',
					icon: Delete,
					shortcut: '⌫',
					danger: true,
					action: () => deleteEdge(edge.id)
				}
			]
		};
	}

	function onPaneContextMenu({ event }: { event: MouseEvent | TouchEvent }) {
		if (!(event instanceof MouseEvent)) return;
		event.preventDefault();
		const flowPos = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
		contextMenu = {
			kind: 'pane',
			x: event.clientX,
			y: event.clientY,
			flowX: flowPos.x,
			flowY: flowPos.y,
			items: paneMenuItems(flowPos.x, flowPos.y)
		};
	}

	function closeContextMenu() {
		contextMenu = null;
	}

	function runMenuItem(item: MenuItem) {
		if (item.disabled) return;
		item.action();
		contextMenu = null;
	}

	function getSnapshot(): Pipeline {
		return {
			id: pipeline.id,
			name: pipeline.name,
			createdAt: pipeline.createdAt,
			nodes: fromXyNodes(nodes),
			edges: fromXyEdges(edges),
			updatedAt: Date.now()
		};
	}

	function revertToSnapshot(p: Pipeline) {
		const n = toXyNodes(p.nodes);
		nodes = n;
		edges = sanitizeEdges(n, toXyEdges(p.edges));
	}

	// Capture on the debounced save tick when enough time has passed --
	// piggy-backs on real edits, no blind interval.
	const SNAPSHOT_MIN_SPACING_MS = 30_000;
	let lastSnapshotSig = '';
	let lastSnapshotAt = 0;
	function snapshotSignature(p: Pipeline): string {
		return JSON.stringify({ nodes: p.nodes, edges: p.edges });
	}

	// Undo/redo history. Cursor points at the current state inside `history`;
	// undo decrements, redo increments. New edits truncate forward history.
	const MAX_HISTORY = 50;
	let history = $state.raw<Pipeline[]>([untrack(() => getSnapshot())]);
	let cursor = $state(0);
	let canUndo = $derived(cursor > 0);
	let canRedo = $derived(cursor < history.length - 1);

	function captureIfChanged(snap: Pipeline) {
		const sig = snapshotSignature(snap);
		const currentSig = snapshotSignature(history[cursor]);
		if (sig === currentSig) return;
		const next = history.slice(0, cursor + 1);
		next.push(snap);
		const trimmed = next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
		history = trimmed;
		cursor = trimmed.length - 1;
	}

	function commit(snap: Pipeline) {
		pipelineStore.save(snap);
		const sig = snapshotSignature(snap);
		const now = Date.now();
		if (sig !== lastSnapshotSig && now - lastSnapshotAt >= SNAPSHOT_MIN_SPACING_MS) {
			pipelineMethods.addSnapshot(snap).then(() => {
				lastSnapshotSig = sig;
				lastSnapshotAt = now;
			});
		}
		captureIfChanged(snap);
	}

	function flushPendingCommit() {
		if (saveTimer === undefined) return;
		clearTimeout(saveTimer);
		saveTimer = undefined;
		untrack(() => commit(getSnapshot()));
	}

	function editGraph(edit: () => void) {
		flushPendingCommit();
		captureIfChanged(getSnapshot());
		// Settle data derived from newly grown sockets inside the same undo step.
		flushSync(edit);
		clearTimeout(saveTimer);
		saveTimer = undefined;
		commit(getSnapshot());
	}

	function undo() {
		flushPendingCommit();
		if (cursor === 0) return;
		cursor -= 1;
		revertToSnapshot(history[cursor]);
	}

	function redo() {
		flushPendingCommit();
		if (cursor >= history.length - 1) return;
		cursor += 1;
		revertToSnapshot(history[cursor]);
	}

	pipelineStore.editorActions = {
		addNode,
		addNodeWithData,
		getSnapshot,
		revertToSnapshot,
		undo,
		redo,
		copySelection,
		paste: () => pasteAt(undefined),
		selectAll: selectAllNodes,
		canUndo: () => canUndo,
		canRedo: () => canRedo
	};

	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => {
		nodes;
		edges;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = undefined;
			untrack(() => commit(getSnapshot()));
		}, 500);
		return () => clearTimeout(saveTimer);
	});

	onMount(() => {
		lastSnapshotSig = snapshotSignature(getSnapshot());
		// First edit always snapshots -- pretend the previous capture was
		// just past the spacing window.
		lastSnapshotAt = Date.now() - SNAPSHOT_MIN_SPACING_MS - 1;
	});

	// Every node's data (minus canvas geometry) and every edge with its handles.
	// The backend reconcile classifies the resend, so a live-param-only change is
	// a no-op there and needs no field-by-field gate here.
	function routingSignature(): string {
		return JSON.stringify({
			nodes: nodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
			edges: edges.map((e) => ({
				id: e.id,
				source: e.source,
				sourceHandle: e.sourceHandle ?? null,
				target: e.target,
				targetHandle: e.targetHandle ?? null
			}))
		});
	}

	let lastRoutingSig = untrack(routingSignature);
	let restartTimer: ReturnType<typeof setTimeout> | undefined;
	// No teardown on re-run: node measurement re-fires this effect constantly and
	// would cancel the pending reconcile before it ever reaches the backend.
	$effect(() => {
		const sig = routingSignature();
		if (sig === lastRoutingSig) return;
		lastRoutingSig = sig;
		if (!audioStore.isRunning) return;
		clearTimeout(restartTimer);
		restartTimer = setTimeout(() => {
			untrack(async () => {
				try {
					await audioStore.restartPipeline({
						nodes: fromXyNodes(nodes),
						edges: fromXyEdges(edges)
					});
				} catch (e) {
					audioStore.reportError(e);
				}
			});
		}, 400);
	});

	// The Tauri WebView (and historic browser behavior) treats Backspace outside
	// of editable fields as "navigate back". XYFlow also defaults `deleteKey` to
	// Backspace, so we explicitly accept Delete too and swallow the default
	// navigation in case the press lands outside the flow.
	function onWindowKeyDown(e: KeyboardEvent) {
		const t = e.target as HTMLElement | null;
		const tag = t?.tagName?.toLowerCase();
		const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable;
		const onCanvas = !!t && editorElement.contains(t) && !t.closest(INTERACTIVE) && !modalManager.isOpen && !contextMenu;

		if (e.key === 'Escape') {
			cancelConnect();
			connectNotice = '';
		}
		const shortcut = canvasShortcut(e, onCanvas && !connectDrag && !e.defaultPrevented);
		if (shortcut) {
			e.preventDefault();
			if (!e.repeat) {
				if (shortcut === 'toggleGrid') toggleGrid();
				else duplicateSelection();
			}
			return;
		}

		if (e.key === 'Escape' && channelSelection.nodeId) {
			channelSelection.clear();
			return;
		}

		if (e.key === 'Backspace' || e.key === 'Delete') {
			if (inField) return;
			e.preventDefault();
			return;
		}

		const mod = e.metaKey || e.ctrlKey;
		if (!mod || inField || modalManager.isOpen) return;

		if (e.key === 'c' || e.key === 'C') {
			if (!nodes.some((n) => n.selected)) return;
			e.preventDefault();
			copySelection();
		} else if (e.key === 'v' || e.key === 'V') {
			if (!pipelineStore.clipboard) return;
			e.preventDefault();
			pasteAt(undefined);
		} else if (e.key === 'a' || e.key === 'A') {
			e.preventDefault();
			selectAllNodes();
		}
	}

	// Auto-stop the pipeline when every AudioFile source has reached EOF and
	// no live capture (mic / system / app) is running. Mixed graphs keep
	// running so live recording survives the file finishing.
	const LIVE_INPUT_TYPES = ['microphone', 'systemAudio', 'appAudio'];
	let audioFileDone = $state<Record<string, boolean>>({});

	$effect(() => {
		if (!audioStore.isRunning) {
			audioFileDone = {};
		}
	});

	interface AudioFileProgress {
		nodeId: string;
		stopped: boolean;
	}

	function onBeforeUnload() {
		flushPendingCommit();
	}

	let unlistenAudioFile: UnlistenFn | undefined;
	onMount(() => {
		window.addEventListener('keydown', onWindowKeyDown, { capture: true });
		window.addEventListener('beforeunload', onBeforeUnload);
		listen<AudioFileProgress>('audio://audio_file_progress', (e) => {
			const { nodeId, stopped } = e.payload;
			if (!audioStore.isRunning) return;
			audioFileDone[nodeId] = stopped;
			if (!stopped) return;
			const hasLive = nodes.some((n) => LIVE_INPUT_TYPES.includes(n.type ?? ''));
			if (hasLive) return;
			const audioFiles = nodes.filter((n) => n.type === 'audioFile');
			if (audioFiles.length === 0) return;
			if (audioFiles.every((n) => audioFileDone[n.id])) {
				audioMethods.stopPipeline().catch(() => {});
			}
		}).then((fn) => {
			unlistenAudioFile = fn;
		});
		return () => {
			window.removeEventListener('keydown', onWindowKeyDown, { capture: true });
			window.removeEventListener('beforeunload', onBeforeUnload);
		};
	});

	onDestroy(() => {
		flushPendingCommit();
		clearTimeout(restartTimer);
		unlistenAudioFile?.();
		if (pipelineStore.editorActions?.getSnapshot === getSnapshot) {
			pipelineStore.editorActions = null;
		}
	});
</script>

<svelte:window onmousedown={closeContextMenu} onpointermove={onConnectMove} onpointerup={onConnectEnd} onpointercancel={cancelConnect} onblur={cancelConnect} />

<div class="flex h-full w-full">
	<div
		bind:this={editorElement}
		class="flow-editor relative flex-1"
		class:connecting={connectDrag !== null}
		role="region"
		aria-label="Flow editor"
		tabindex="-1"
		onpointerdowncapture={onEditorPointerDown}
		onlostpointercapture={cancelConnect}
		onmousedowncapture={(e) => {
			if (connectDrag) {
				e.preventDefault();
				e.stopPropagation();
			}
		}}
		ondragover={onDragOver}
		ondrop={onDrop}>
		<SvelteFlow
			proOptions={{ hideAttribution: true }}
			class="!bg-background"
			bind:nodes
			bind:edges
			{nodeTypes}
			{edgeTypes}
			defaultEdgeOptions={{ animated: edgeSettings.animated, type: 'channel' }}
			connectionLineComponent={ConnectionLine}
			deleteKey={['Delete', 'Backspace']}
			selectionOnDrag
			panOnDrag={[1]}
			panActivationKey={null}
			panOnScroll={scrollPans}
			zoomOnScroll={!scrollPans}
			zoomOnPinch
			noPanClass="nowheel"
			onnodecontextmenu={onNodeContextMenu}
			onedgecontextmenu={onEdgeContextMenu}
			onpanecontextmenu={onPaneContextMenu}
			onpaneclick={closeContextMenu}
			onnodedragstart={closeContextMenu}
			onselectionstart={closeContextMenu}
			onmovestart={closeContextMenu}
			snapGrid={appSettings.snapToGrid ? [appSettings.gridSize, appSettings.gridSize] : undefined}
			fitView>
			<Background gap={appSettings.gridSize} patternClass="fill-neutral-200" />
			<Controls />
			<EdgeRectSelect />
			<OrphanEdges onDelete={deleteEdge} />
		</SvelteFlow>

		<button
			type="button"
			class="absolute top-3 right-3 z-10 rounded-lg border border-neutral-400 bg-neutral-100 px-3 py-1.5 text-xs text-neutral-1000 shadow-sm"
			aria-pressed={appSettings.snapToGrid}
			title="Snap to grid (Shift+Tab on canvas)"
			onclick={toggleGrid}>
			Grid {appSettings.snapToGrid ? `ON · ${appSettings.gridSize}` : 'OFF'}
		</button>
		{#if connectDrag}
			<svg class="pointer-events-none absolute inset-0 z-20 h-full w-full" aria-hidden="true">
				<line
					x1={connectDrag.startX}
					y1={connectDrag.startY}
					x2={connectDrag.x}
					y2={connectDrag.y}
					stroke="currentColor"
					stroke-width="2"
					stroke-dasharray="5 4" />
			</svg>
		{/if}
		{#if connectNotice}
			<p
				role="status"
				class="pointer-events-none absolute top-14 right-3 z-10 max-w-xs rounded-lg border border-neutral-400 bg-neutral-100 p-2 text-xs text-neutral-1000">
				{connectNotice}
			</p>
		{/if}

		{#if channelSelection.channels.length > 0}
			<div
				class="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-neutral-400 bg-neutral-100 px-3 py-1.5 text-[11px] text-neutral-1000 shadow-sm">
				<span class="font-mono tabular-nums">{channelSelection.channels.length}</span>
				channels armed &mdash; drag any one to connect them all, Esc to clear
			</div>
		{/if}
	</div>
	<Sidebar />
</div>

{#if contextMenu}
	<div
		class="fixed z-50"
		style="top: {contextMenu.y}px; left: {contextMenu.x}px"
		oncontextmenu={(e) => e.preventDefault()}
		onmousedown={(e) => e.stopPropagation()}>
		<Menu>
			{#each contextMenu.items as item (item.label)}
				<OverlayMenuItem label={item.label} icon={item.icon} danger={item.danger} disabled={item.disabled} onclick={() => runMenuItem(item)}>
					{#snippet shortcut()}
						{#if item.shortcut}
							{#each [...item.shortcut] as ch, i (i)}
								{#if ch === '⌘'}
									<KeyCommand class="h-3 w-3" />
								{:else if ch === '⌫'}
									<Backspace class="h-3 w-3" />
								{:else}
									<span>{ch}</span>
								{/if}
							{/each}
						{/if}
					{/snippet}
				</OverlayMenuItem>
			{/each}
		</Menu>
	</div>
{/if}

<style>
	.flow-editor :global(.svelte-flow__pane),
	.flow-editor :global(.svelte-flow__node.draggable) {
		cursor: default;
	}
	/* Selected groups must not cover node bodies or the background with a drag surface. */
	.flow-editor :global(.svelte-flow__selection-wrapper),
	.flow-editor :global(.svelte-flow__selection-wrapper .svelte-flow__selection) {
		pointer-events: none;
	}
	.flow-editor :global(.svelte-flow__node.draggable.dragging) {
		cursor: move;
	}
	.flow-editor :global(.svelte-flow__pane.dragging) {
		cursor: grabbing;
	}
	.flow-editor.connecting :global(.svelte-flow__node) {
		cursor: crosshair;
	}
</style>
