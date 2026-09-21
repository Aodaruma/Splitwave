<script lang="ts">
	import { Background, Controls, SvelteFlow, useSvelteFlow, type Edge as XyEdge, type Node as XyNode } from '@xyflow/svelte';
	import { createId } from '@paralleldrive/cuid2';
	import { flushSync, onDestroy, onMount, setContext, untrack } from 'svelte';
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
	import { DND_MIME, defaultDataFor, emitNodeAction, nodeTypes, parseHandle, registry } from '../utils';
	import Sidebar from './sidebar.svelte';
	import Group from './group.svelte';
	import GroupBoundary from './_group_boundary.svelte';
	import { ConfirmModal } from '$lib/modules/overlay/ui';
	import {
		definition,
		dependencies,
		documentFor,
		expand,
		materialize,
		scopeAt,
		groupSelection,
		ungroup,
		makeIndependent,
		copyDefinition,
		assertReusableInstance,
		copyInstanceState,
		capturePluginStates,
		assertLiveRestore,
		patchRuntimeNode as patchRuntime,
		runtimeId,
		type GroupDocument
	} from '$lib/modules/pipeline/groups';
	import { assertFresh, definitionContent, usageCount, validateSharedRoutes, type GroupLibrary } from '$lib/modules/pipeline/group_library';
	import { GROUP_ACTIONS, groupView, saveGroupView } from '../utils/group_view';
	const editorNodeTypes = { ...nodeTypes, group: Group, groupBoundary: GroupBoundary };
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
	let groupDocument = $state.raw<GroupDocument>(untrack(() => documentFor($state.snapshot(pipeline))));
	let groupPath = $state.raw<string[]>([]);
	let groupLibrary = $state.raw<GroupLibrary>({ version: 3, pipelines: {}, definitions: {} });
	let chooserOpen = $state(false);
	let chooserId = $state('');
	let chooserLinked = $state(false);
	let chooserItems = $derived(Object.values(groupLibrary.definitions));

	const flow = useSvelteFlow();
	const isMac = platform() === 'macos';
	let scrollPans = $derived(appSettings.canvasScroll === 'pan' || (appSettings.canvasScroll === 'auto' && isMac));
	let editorElement: HTMLDivElement;

	let nodes = $state.raw<XyNode[]>(untrack(() => groupView(groupDocument, []).nodes));
	let edges = $state.raw<XyEdge[]>(untrack(() => groupView(groupDocument, []).edges));

	function localNodeId(id: string) {
		const d = scopeAt(groupDocument, groupPath);
		return d.nodes.find((n) => (n.kind === 'group' ? n.id === id : runtimeId(groupDocument, groupPath, n.id) === id))?.id ?? id;
	}
	function showScope() {
		const view = groupView(groupDocument, groupPath);
		nodes = view.nodes;
		edges = view.edges;
		seenEdgeIds = new Set(edges.map((e) => e.id));
		channelSelection.clear();
	}
	function documentEdit(edit: (doc: GroupDocument) => void) {
		try {
			const next = documentFor(getSnapshot());
			edit(next);
			expand(next);
			const all = { ...groupLibrary.definitions, ...next.definitions };
			for (const p of Object.values(groupLibrary.pipelines))
				if (p.id !== pipeline.id && p.groups) expand({ ...structuredClone(p.groups), definitions: all });
			editGraph(() => {
				groupDocument = next;
				showScope();
			});
		} catch (error) {
			audioStore.reportError(error);
		}
	}
	function navigate(path: string[]) {
		try {
			groupDocument = documentFor(getSnapshot());
			scopeAt(groupDocument, path);
			groupPath = path;
			showScope();
			closeContextMenu();
			void flow.fitView();
		} catch (error) {
			audioStore.reportError(error);
		}
	}
	function openGroup(id: string) {
		navigate([...groupPath, id]);
	}
	function collapseSelection() {
		const ids = nodes.filter((n) => n.selected && n.type !== 'groupBoundary').map((n) => localNodeId(n.id));
		if (ids.length) documentEdit((doc) => groupSelection(doc, groupPath, ids));
	}
	function groupUsage(id: string) {
		const p = getSnapshot();
		return usageCount({ ...groupLibrary, pipelines: { ...groupLibrary.pipelines, [p.id]: p } }, id);
	}
	setContext(GROUP_ACTIONS, {
		open: openGroup,
		usage: groupUsage,
		rename: (id: string, name: string) =>
			documentEdit((doc) => {
				const n = scopeAt(doc, groupPath).nodes.find((n) => n.id === id);
				if (n?.kind === 'group' && name.trim()) definition(doc, n.data.definition).name = name.trim();
			}),
		port: (id: string, side: 'inputs' | 'outputs', port: string, action: string, label?: string) =>
			documentEdit((doc) => {
				const n = scopeAt(doc, groupPath).nodes.find((n) => n.id === id);
				if (n?.kind !== 'group') return;
				const ports = definition(doc, n.data.definition)[side];
				const index = ports.findIndex((p) => p.id === port);
				if (index < 0) return;
				if (action === 'label') ports[index].label = label?.trim() || 'Audio';
				else if (action === 'remove') ports.splice(index, 1);
				else {
					const to = index + (action === 'up' ? -1 : 1);
					if (to >= 0 && to < ports.length) [ports[index], ports[to]] = [ports[to], ports[index]];
				}
			})
	});
	async function openChooser() {
		try {
			groupLibrary = await pipelineMethods.library();
			chooserId = Object.keys(groupLibrary.definitions)[0] ?? '';
			chooserOpen = true;
		} catch (error) {
			audioStore.reportError(error);
		}
	}
	function insertGroup() {
		if (!chooserId) return;
		documentEdit((doc) => {
			const available = { ...groupLibrary.definitions, ...doc.definitions };
			const chosen = dependencies({ ...doc, definitions: available }, chooserId);
			for (const [id, d] of Object.entries(chosen)) doc.definitions[id] ??= structuredClone(d);
			assertReusableInstance(doc, chooserId);
			const id = chooserLinked ? chooserId : copyDefinition(doc, chooserId);
			const d = definition(doc, id);
			if (!d.inputs.length && !d.outputs.length) {
				for (const n of d.nodes) {
					if (n.kind === 'group') continue;
					const category = registry[n.kind].category;
					const side = category === 'input' ? 'outputs' : category === 'output' ? 'inputs' : null;
					if (!side) continue;
					const wired = d.edges
						.filter((e) => (side === 'inputs' ? e.target === n.id : e.source === n.id))
						.map((e) => (side === 'inputs' ? e.targetHandle : e.sourceHandle));
					const handles = [...new Set(wired)];
					for (const handle of handles)
						d[side].push({ id: createId(), label: registry[n.kind].label + ' · ' + (handle ?? 'Audio'), node: n.id, handle });
				}
			}
			const instance = createId();
			scopeAt(doc, groupPath).nodes.push({ id: instance, kind: 'group', data: { definition: id }, position: { x: 150, y: 150 } });
			const source = Object.values(groupLibrary.pipelines).find((p) => p.groups?.root === chooserId);
			if (source?.groups) copyInstanceState(source.groups, [], doc, [...groupPath, instance]);
		});
		chooserOpen = false;
	}

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
		documentEdit((doc) => {
			const d = scopeAt(doc, groupPath),
				local = localNodeId(nodeId);
			if ([...d.inputs, ...d.outputs].some((p) => p.node === local)) throw new Error('Remove the exposed group port before deleting this node.');
			d.nodes = d.nodes.filter((n) => n.id !== local);
			d.edges = d.edges.filter((e) => e.source !== local && e.target !== local);
		});
	}

	function deleteEdge(edgeId: string) {
		edges = edges.filter((e) => e.id !== edgeId);
	}

	function copyEntry(group: XyNode[]) {
		const entry = copyGraph(
			group.filter((n) => n.type !== 'groupBoundary').map((n) => ({ ...n, data: $state.snapshot(n.data) })),
			edges
		);
		if (entry) {
			const p = getSnapshot();
			entry.groupDocument = structuredClone(p.groups!);
			entry.groupPaths = {};
			group
				.filter((n) => n.type !== 'groupBoundary')
				.forEach((n, index) => {
					if (n.type === 'group') entry.groupPaths![index] = [...groupPath, n.id];
					if (n.type === 'plugin') entry.nodes[index].data = structuredClone(p.nodes.find((node) => node.id === n.id)!.data);
				});
		}
		return entry;
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

	function insertCopy(entry: NonNullable<typeof pipelineStore.clipboard>, origin: { x: number; y: number }, linked = false) {
		const graph = pasteGraph(
			$state.snapshot(entry),
			origin,
			entry.nodes.map(() => createId()),
			entry.edges.map(() => createId()),
			appSettings.snapToGrid ? appSettings.gridSize : undefined
		);
		const plain = $state.snapshot(entry);
		const next = documentFor(getSnapshot());
		Object.assign(next.definitions, Object.fromEntries(Object.entries(plain.groupDocument?.definitions ?? {}).filter(([id]) => !next.definitions[id])));
		for (const node of graph.nodes)
			if (node.type === 'group') {
				const source = { ...next, definitions: { ...next.definitions, ...plain.groupDocument?.definitions } };
				assertReusableInstance(source, String(node.data.definition));
				const id = linked ? String(node.data.definition) : copyDefinition(source, String(node.data.definition));
				for (const [key, d] of Object.entries(source.definitions)) if (!next.definitions[key]) next.definitions[key] = d;
				const d = definition(next, id);
				node.data = { definition: d.id, name: d.name, inputs: d.inputs, outputs: d.outputs };
			}
		editGraph(() => {
			groupDocument = next;
			nodes = [...nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...graph.nodes];
			// Programmatic copies must not trigger the armed-handle fan-out.
			graph.edges.forEach((e) => seenEdgeIds.add(e.id));
			edges = [...edges.map((e) => (e.selected ? { ...e, selected: false } : e)), ...graph.edges];
			const complete = documentFor(getSnapshot());
			graph.nodes.forEach((node, index) => {
				const sourcePath = plain.groupPaths?.[index];
				if (sourcePath && plain.groupDocument) copyInstanceState(plain.groupDocument, sourcePath, complete, [...groupPath, node.id]);
			});
			groupDocument = complete;
		});
	}

	function duplicateSelection(linked = false) {
		try {
			const entry = copyEntry(nodes.filter((n) => n.selected));
			if (!entry) return;
			insertCopy(entry, offsetOrigin(entry.origin, appSettings.snapToGrid ? appSettings.gridSize : undefined), linked);
		} catch (error) {
			audioStore.reportError(error);
		}
	}

	function pasteAt(position?: { x: number; y: number }) {
		try {
			const c = pipelineStore.clipboard;
			if (!c || c.nodes.length === 0) return;
			const origin = position ?? offsetOrigin(c.origin, appSettings.snapToGrid ? appSettings.gridSize : undefined);
			insertCopy(c, origin);
			pipelineStore.clipboard = { ...c, origin };
		} catch (error) {
			audioStore.reportError(error);
		}
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
		const node = scopeAt(groupDocument, groupPath).nodes.find((n) => n.id === id);
		const portSide = side === 'source' ? 'outputs' : 'inputs';
		function semantic(d: ReturnType<typeof scopeAt>, nodeId: string, handle?: string): string | null {
			const child = d.nodes.find((n) => n.id === nodeId);
			if (child?.kind !== 'group') return handle ?? null;
			const inner = definition(groupDocument, child.data.definition);
			const port = inner[portSide].find((p) => p.id === handle);
			return port ? semantic(inner, port.node, port.handle) : null;
		}
		const d = node?.kind === 'group' ? definition(groupDocument, node.data.definition) : null;
		const ordered = d?.[portSide].map((p) => ({ id: p.id, handle: semantic(d, p.node, p.handle) }));
		return { id, handles: handles.map((h) => ({ id: h.id ?? null, y: h.y })), channels: channelPorts.get(id)?.[side], ordered };
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
		const kind = node.type as NodeKind | 'group' | undefined;

		if (kind === 'group')
			items.push(
				{ label: 'Open group', action: () => openGroup(id) },
				{ label: 'Ungroup', action: () => documentEdit((doc) => ungroup(doc, groupPath, id)) },
				{ label: 'Make Independent', action: () => documentEdit((doc) => makeIndependent(doc, groupPath, id)) }
			);
		items.push(
			{ label: 'Group selected nodes', shortcut: '⌘G', action: collapseSelection },
			{
				label: 'Duplicate',
				shortcut: '⌘D',
				action: () => {
					if (!node.selected) nodes = nodes.map((n) => ({ ...n, selected: n.id === id }));
					duplicateSelection();
				}
			},
			{
				label: 'Duplicate linked group',
				shortcut: 'Alt+D',
				disabled: kind !== 'group',
				action: () => {
					nodes = nodes.map((n) => ({ ...n, selected: n.id === id }));
					duplicateSelection(true);
				}
			}
		);
		if (groupPath.length && node.type !== 'groupBoundary')
			for (const [side, type] of [
				['inputs', 'target'],
				['outputs', 'source']
			] as const) {
				for (const handle of flow.getInternalNode(id)?.internals.handleBounds?.[type] ?? [])
					items.push({
						label: 'Expose ' + (side === 'inputs' ? 'input' : 'output') + ' · ' + (handle.id ?? 'Audio'),
						action: () =>
							documentEdit((doc) => {
								const d = scopeAt(doc, groupPath),
									local = localNodeId(id);
								if (!d[side].some((p) => p.node === local && p.handle === (handle.id ?? undefined)))
									d[side].push({
										id: createId(),
										node: local,
										handle: handle.id ?? undefined,
										label: (kind === 'group' ? 'Group' : (registry[kind as NodeKind]?.label ?? 'Audio')) + ' · ' + (handle.id ?? 'Audio')
									});
							})
					});
			}
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
		const doc = structuredClone(groupDocument);
		saveGroupView(
			doc,
			groupPath,
			nodes.map((n) => ({ ...n, data: $state.snapshot(n.data) })),
			edges
		);
		const snapshot = materialize({ ...$state.snapshot(pipeline), updatedAt: Date.now() }, doc);
		validateSharedRoutes({ ...groupLibrary, pipelines: { ...groupLibrary.pipelines, [snapshot.id]: snapshot } });
		groupDocument.runtimeIds = { ...doc.runtimeIds };
		groupDocument.definitions = doc.definitions;
		return snapshot;
	}
	async function restoreSnapshot(p: Pipeline): Promise<boolean> {
		try {
			await commitQueue;
			const library = await pipelineMethods.library();
			p = structuredClone($state.snapshot(p));
			if (!p.groups) {
				const root = groupDocument.root;
				if (usageCount(library, root) > 1)
					throw new Error('This legacy snapshot predates shared groups and cannot replace a pipeline used by other groups.');
				p = materialize(p);
			}
			for (const d of Object.values(p.groups?.definitions ?? {}))
				if (usageCount(library, d.id) <= 1 && library.definitions[d.id]) {
					d.revision = library.definitions[d.id].revision;
					acknowledged.set(d.id, d.revision);
				}
			assertFresh(p, library.definitions);
			if (audioStore.isRunning && audioStore.runningPipelineId === p.id && !audioStore.shuttingDown) assertLiveRestore(getSnapshot(), p);
			const changed = Object.values(p.groups?.definitions ?? {}).filter(
				(d) => library.definitions[d.id] && definitionContent(d) !== definitionContent(library.definitions[d.id])
			);
			const shared = changed.filter(
				(d) => usageCount(library, d.id) > 1 || Object.values(library.pipelines).some((other) => other.id !== p.id && other.groups?.definitions[d.id])
			);
			if (
				shared.length &&
				(await modalManager.open('', ConfirmModal, {
					message: 'Restore shared groups: ' + shared.map((d) => d.name).join(', ') + '? This changes every linked use in this local library.',
					confirmLabel: 'Restore all linked uses',
					canClose: true
				})) !== true
			)
				return false;
			groupDocument = documentFor(capturePluginStates(p));
			try {
				scopeAt(groupDocument, groupPath);
			} catch {
				groupPath = [];
			}
			showScope();
			return true;
		} catch (error) {
			audioStore.reportError(error);
			return false;
		}
	}
	function revertToSnapshot(p: Pipeline) {
		void restoreSnapshot(p);
	}
	function patchRuntimeNode(id: string, patch: Record<string, unknown>) {
		groupDocument = documentFor(patchRuntime(getSnapshot(), id, patch));
		showScope();
	}

	// Capture on the debounced save tick when enough time has passed --
	// piggy-backs on real edits, no blind interval.
	const SNAPSHOT_MIN_SPACING_MS = 30_000;
	let lastSnapshotSig = '';
	let lastSnapshotAt = 0;
	function snapshotSignature(p: Pipeline): string {
		return JSON.stringify({ nodes: p.nodes, edges: p.edges, groups: p.groups && Object.values(p.groups.definitions).map(definitionContent) });
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

	const acknowledged = new Map<string, number>();
	let commitQueue: Promise<void> = Promise.resolve();
	function commit(snap: Pipeline) {
		const saved = commitQueue.then(async () => {
			for (const d of Object.values(snap.groups?.definitions ?? {})) {
				const rev = acknowledged.get(d.id);
				if (rev !== undefined) d.revision = rev;
			}
			const saved = await pipelineStore.save(snap);
			for (const d of Object.values(saved.groups?.definitions ?? {})) {
				acknowledged.set(d.id, d.revision);
				if (groupDocument.definitions[d.id]) groupDocument.definitions[d.id].revision = d.revision;
				for (const h of history) if (h.groups?.definitions[d.id]) h.groups.definitions[d.id].revision = d.revision;
			}
			groupLibrary = await pipelineMethods.library();
			const sig = snapshotSignature(saved),
				now = Date.now();
			if (sig !== lastSnapshotSig && now - lastSnapshotAt >= SNAPSHOT_MIN_SPACING_MS) {
				await pipelineMethods.addSnapshot(saved);
				lastSnapshotSig = sig;
				lastSnapshotAt = now;
			}
		});
		commitQueue = saved.catch((error) => audioStore.reportError(error));

		captureIfChanged(snap);
		return saved;
	}

	function flushPendingCommit() {
		if (saveTimer === undefined) return;
		clearTimeout(saveTimer);
		saveTimer = undefined;
		untrack(() => {
			try {
				commit(getSnapshot());
			} catch (error) {
				audioStore.reportError(error);
			}
		});
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

	async function undo() {
		flushPendingCommit();
		if (cursor === 0) return;
		if (await restoreSnapshot(history[cursor - 1])) cursor -= 1;
	}

	async function redo() {
		flushPendingCommit();
		if (cursor >= history.length - 1) return;
		if (await restoreSnapshot(history[cursor + 1])) cursor += 1;
	}

	pipelineStore.editorActions = {
		pipelineId: untrack(() => pipeline.id),
		addNode,
		addNodeWithData,
		getSnapshot,
		save: () => {
			clearTimeout(saveTimer);
			saveTimer = undefined;
			return commit(getSnapshot());
		},
		patchRuntimeNode,
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
			untrack(() => {
				try {
					commit(getSnapshot());
				} catch (error) {
					audioStore.reportError(error);
				}
			});
		}, 500);
		return () => clearTimeout(saveTimer);
	});

	onMount(() => {
		lastSnapshotSig = snapshotSignature(getSnapshot());
		// First edit always snapshots -- pretend the previous capture was
		// just past the spacing window.
		lastSnapshotAt = Date.now() - SNAPSHOT_MIN_SPACING_MS - 1;
	});

	// Navigation must never turn the visible scope into the engine graph.
	function routingSignature(): string {
		try {
			const p = getSnapshot();
			return JSON.stringify({ nodes: p.nodes.map((n) => ({ id: n.id, kind: n.kind, data: n.data })), edges: p.edges });
		} catch {
			return '';
		}
	}

	let lastRoutingSig = untrack(routingSignature);
	let restartTimer: ReturnType<typeof setTimeout> | undefined;
	// No teardown on re-run: node measurement re-fires this effect constantly and
	// would cancel the pending reconcile before it ever reaches the backend.
	$effect(() => {
		const sig = routingSignature();
		if (sig === lastRoutingSig) return;
		lastRoutingSig = sig;
		if (!audioStore.isRunning || audioStore.runningPipelineId !== pipeline.id) return;
		clearTimeout(restartTimer);
		restartTimer = setTimeout(() => {
			untrack(async () => {
				try {
					await audioStore.restartPipeline(getSnapshot());
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
		if (
			onCanvas &&
			!e.repeat &&
			e.altKey &&
			!e.ctrlKey &&
			!e.metaKey &&
			e.key.toLowerCase() === 'd' &&
			nodes.some((n) => n.selected && n.type === 'group')
		) {
			e.preventDefault();
			duplicateSelection(true);
			return;
		}
		if (onCanvas && !e.repeat && !e.altKey) {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'g') {
				e.preventDefault();
				collapseSelection();
				return;
			}
			if (e.key === 'Enter') {
				const n = nodes.find((n) => n.selected && n.type === 'group');
				if (n) {
					e.preventDefault();
					openGroup(n.id);
					return;
				}
			}
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

	function onBeforeUnload() {
		flushPendingCommit();
	}

	onMount(() => {
		window.addEventListener('keydown', onWindowKeyDown, { capture: true });
		window.addEventListener('beforeunload', onBeforeUnload);
		void pipelineMethods
			.library()
			.then((value) => (groupLibrary = value))
			.catch((error) => audioStore.reportError(error));
		return () => {
			window.removeEventListener('keydown', onWindowKeyDown, { capture: true });
			window.removeEventListener('beforeunload', onBeforeUnload);
		};
	});

	onDestroy(() => {
		flushPendingCommit();
		clearTimeout(restartTimer);
		// Keep runtime controls on the latest document until its save reaches the root store.
		void commitQueue.then(() => {
			if (pipelineStore.editorActions?.getSnapshot === getSnapshot) pipelineStore.editorActions = null;
		});
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
		ondblclick={(event) => {
			const id = bodyNode(event.target)?.dataset.id;
			if (id && nodes.some((n) => n.id === id && n.type === 'group')) {
				event.preventDefault();
				openGroup(id);
			}
		}}
		ondragover={onDragOver}
		ondrop={onDrop}>
		<SvelteFlow
			proOptions={{ hideAttribution: true }}
			class="!bg-background"
			bind:nodes
			bind:edges
			nodeTypes={editorNodeTypes}
			onbeforedelete={async ({ nodes: deleted, edges: deletedEdges }) => {
				const d = scopeAt(groupDocument, groupPath);
				if (deleted.some((n) => [...d.inputs, ...d.outputs].some((p) => p.node === localNodeId(n.id)))) {
					audioStore.reportError(new Error('Remove the group port before deleting its node. Connected ports cannot be removed.'));
					return false;
				}
				return { nodes: deleted.filter((n) => n.type !== 'groupBoundary'), edges: deletedEdges.filter((e) => !e.id.startsWith('$group-')) };
			}}
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

		<div class="absolute top-3 left-3 z-10 flex max-w-[70%] flex-wrap items-center gap-2 rounded border border-neutral-400 bg-neutral-100 p-2 text-xs">
			<button onclick={() => navigate([])}>{pipeline.name}</button>
			{#each groupPath as id, index}
				<span>/</span><button onclick={() => navigate(groupPath.slice(0, index + 1))}
					>{scopeAt(groupDocument, groupPath.slice(0, index + 1)).name}</button>
			{/each}
			{#if groupPath.length}<button onclick={() => navigate(groupPath.slice(0, -1))}>← Back</button>{/if}
			{#if groupUsage(scopeAt(groupDocument, groupPath).id) > 1}<span>Editing {groupUsage(scopeAt(groupDocument, groupPath).id)} linked uses</span>{/if}
			<button onclick={collapseSelection}>Group selected</button>
			<button onclick={openChooser}>Add reusable group…</button>
		</div>
		{#if chooserOpen}
			<div class="absolute top-16 left-3 z-20 flex max-w-sm flex-col gap-2 rounded border border-neutral-400 bg-neutral-100 p-3 text-xs">
				<label
					>Local groups and saved pipelines
					<select class="mt-1 w-full rounded border border-neutral-400 bg-neutral-100 p-1" bind:value={chooserId}>
						{#each chooserItems as d (d.id)}<option value={d.id}>{d.name}</option>{/each}
					</select>
				</label>
				<label><input type="checkbox" bind:checked={chooserLinked} /> Linked reference — edits apply to every use</label>
				<p>Inputs, microphones and recording destinations are kept. All groups run inside this pipeline.</p>
				<div class="flex gap-3">
					<button disabled={!chooserId} onclick={insertGroup}>Add {chooserLinked ? 'linked' : 'independent'} group</button><button
						onclick={() => (chooserOpen = false)}>Cancel</button>
				</div>
			</div>
		{/if}
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
