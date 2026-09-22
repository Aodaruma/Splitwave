<script lang="ts">
	import {
		Background,
		Controls,
		SvelteFlow,
		useSvelteFlow,
		useNodesInitialized,
		useViewportInitialized,
		type Edge as XyEdge,
		type Node as XyNode,
		type Connection
	} from '@xyflow/svelte';
	import { page } from '$app/state';
	import { pushState, replaceState } from '$app/navigation';
	import { createId } from '@paralleldrive/cuid2';
	import { flushSync, onDestroy, onMount, setContext, untrack } from 'svelte';
	import { platform } from '@tauri-apps/plugin-os';
	import { modalManager } from '$lib/modules/overlay/modal';
	import { copyGraph, offsetOrigin, pasteGraph } from '../utils/clipboard';
	import { createHistoryRestorer } from '../utils/history_restore';
	import { planAutoConnect, planGroupPorts, createsCycle, type AudioPorts } from '../utils/auto_connect';
	import { canvasShortcut } from '../utils/shortcuts';
	import { alignNodes, insertReroute, planBulkBypass, withReroutePoints, type AlignmentAxis } from '../utils/layout';
	import { insertionHandles, saveWireInsertion, planWireInsertion, wireHitsBounds } from '../utils/insertion';
	import { EDGE_ACTIONS, type EdgeActions } from '../utils/edge_actions';
	import {
		assertRewireAcyclic,
		assertRewireKeepsFeeds,
		crossesWire,
		detachNodes,
		editableWire,
		screenPath,
		shakeDetector,
		switchInputs,
		type Point
	} from '../utils/wiring';
	import type { EdgeLayout, NodeKind, Pipeline } from '$lib/modules/pipeline/types';
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
		replaceGroup,
		copyDefinition,
		assertReusableInstance,
		copyInstanceState,
		capturePluginStates,
		assertLiveRestore,
		patchRuntimeNode as patchRuntime,
		runtimeId,
		type GroupDocument
	} from '$lib/modules/pipeline/groups';
	import {
		assertFresh,
		definitionContent,
		findGroupInstance,
		inheritReplacementStates,
		usageCount,
		validateSharedRoutes,
		type GroupLibrary
	} from '$lib/modules/pipeline/group_library';
	import { GROUP_ACTIONS, BOUNDARY_INPUT, BOUNDARY_OUTPUT, groupView, saveGroupView } from '../utils/group_view';
	import {
		NEW_GROUP_PORT,
		boundaryPort,
		exposePort,
		editPort,
		addPort,
		reorderPort,
		cutGroupWires,
		survivingGroupPath,
		type PortSide
	} from '../utils/group_ports';
	import { groupPathFromPage, groupUrl } from '../utils/group_navigation';
	const editorNodeTypes = { ...nodeTypes, group: Group, groupBoundary: GroupBoundary };
	import ChannelEdge from './_channel_edge.svelte';
	import ConnectionLine from './_connection_line.svelte';
	import EdgeRectSelect from './_edge_rect_select.svelte';
	import OrphanEdges from './_orphan_edges.svelte';
	const edgeTypes = { channel: ChannelEdge };
	import { ArrowLeft, Backspace, Copy, ClipboardPaste, Delete, Folder, KeyCommand, Loop, Refresh, Rewind } from '$lib/components/icons';
	import { channelCaps, channelPorts, channelSelection } from '../stores.svelte';
	import { edgeSettings } from '../edge_settings.svelte';
	import { Menu, MenuItem as OverlayMenuItem } from '$lib/modules/overlay/ui';
	import type { Component } from 'svelte';

	let { pipeline }: { pipeline: Pipeline } = $props();
	let groupDocument = $state.raw<GroupDocument>(untrack(() => documentFor($state.snapshot(pipeline))));
	let groupPath = $state.raw<string[]>([]);
	let groupLibrary = $state.raw<GroupLibrary>({ version: 4, pipelines: {}, definitions: {} });
	let chooserOpen = $state(false);
	let chooserId = $state('');
	let chooserLinked = $state(false);
	let chooserItems = $derived(Object.values(groupLibrary.definitions));

	const flow = useSvelteFlow();
	const measuredNodes = useNodesInitialized();
	const viewportReady = useViewportInitialized();
	let fitRequested = $state(true);
	$effect(() => {
		if (fitRequested && measuredNodes.current && viewportReady.current) {
			fitRequested = false;
			untrack(() => {
				void flow.fitView();
			});
		}
	});
	const isMac = platform() === 'macos';
	let scrollPans = $derived(appSettings.canvasScroll === 'pan' || (appSettings.canvasScroll === 'auto' && isMac));
	let editorElement: HTMLDivElement = $state()!;

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
			const before = getSnapshot();
			const next = documentFor(before);
			edit(next);
			assertRewireAcyclic(before.edges, expand(next).edges);
			const all = { ...groupLibrary.definitions, ...next.definitions };
			for (const p of Object.values(groupLibrary.pipelines))
				if (p.id !== pipeline.id && p.groups)
					assertRewireAcyclic(expand(structuredClone(p.groups)).edges, expand({ ...structuredClone(p.groups), definitions: all }).edges);
			editGraph(() => {
				groupDocument = next;
				showScope();
			});
		} catch (error) {
			audioStore.reportError(error);
		}
	}
	function navigate(path: string[], fromHistory = false) {
		cancelGestures();
		try {
			flushPendingCommit();
			groupDocument = documentFor(getSnapshot());
			const previous = groupPath;
			groupPath = survivingGroupPath(groupDocument, path);
			showScope();
			if (groupPath.length < previous.length && groupPath.every((id, i) => id === previous[i]))
				nodes = nodes.map((n) => ({ ...n, selected: n.id === previous[groupPath.length] }));
			closeContextMenu();
			fitRequested = true;
			editorElement?.focus({ preventScroll: true });
			const url = groupUrl(page.url, groupPath);
			const state = { ...page.state, editorGroupPath: groupPath };
			if (!fromHistory) pushState(url, state);
			else if (groupPath.length !== path.length) replaceState(url, state);
		} catch (error) {
			audioStore.reportError(error);
		}
	}
	$effect(() => {
		const state = page.state;
		const path = groupPathFromPage(page.url, state);
		const url = page.url.href;
		queueMicrotask(() => {
			if (!destroying && page.url.href === url && page.state === state && JSON.stringify(path) !== JSON.stringify(groupPath)) navigate(path, true);
		});
	});
	function openGroup(id: string) {
		navigate([...groupPath, id]);
	}
	function collapseSelection() {
		const ids = nodes.filter((n) => n.selected && n.type !== 'groupBoundary').map((n) => localNodeId(n.id));
		if (ids.length) {
			let id: string | undefined;
			documentEdit((doc) => {
				id = groupSelection(doc, groupPath, ids);
			});
			if (id) {
				nodes = nodes.map((n) => ({ ...n, selected: n.id === id }));
				editorElement.focus({ preventScroll: true });
			}
		}
	}
	function groupUsage(id: string) {
		const d = scopeAt(groupDocument, groupPath);
		// Counts need current group references, including unsaved additions and deletions.
		const visible = nodes.filter((n) => n.type === 'group').map((n) => ({ ...n, kind: 'group' as const, data: { definition: String(n.data.definition) } }));
		const doc = { ...groupDocument, definitions: { ...groupDocument.definitions, [d.id]: { ...d, nodes: visible } } };
		const p = { ...pipeline, groups: doc };
		return usageCount({ ...groupLibrary, pipelines: { ...groupLibrary.pipelines, [p.id]: p } }, id);
	}
	setContext(GROUP_ACTIONS, {
		open: openGroup,
		usage: groupUsage,
		choices: () => {
			const doc = { ...groupDocument, definitions: { ...groupLibrary.definitions, ...groupDocument.definitions } };
			const parent = scopeAt(doc, groupPath).id;
			return Object.values(doc.definitions)
				.filter((d) => !dependencies(doc, d.id)[parent])
				.map((d) => ({ id: d.id, name: d.name }));
		},
		refresh: async () => {
			try {
				groupLibrary = await pipelineMethods.library();
			} catch (error) {
				audioStore.reportError(error);
			}
		},
		select: (id: string, chosen: string) =>
			documentEdit((doc) => {
				const available = { ...groupLibrary.definitions, ...doc.definitions };
				for (const [key, d] of Object.entries(dependencies({ ...doc, definitions: available }, chosen))) doc.definitions[key] ??= structuredClone(d);
				const source = { ...groupLibrary, pipelines: { ...groupLibrary.pipelines, [pipeline.id]: getSnapshot() } };
				const previous = structuredClone(doc.definitions);
				replaceGroup(doc, groupPath, id, chosen);
				inheritReplacementStates(source, doc, previous);
			}),
		independent: (id: string) =>
			documentEdit((doc) => {
				makeIndependent(doc, groupPath, id);
				scopeAt(doc, [...groupPath, id]).name += ' copy';
			}),
		rename: (id: string, name: string) =>
			documentEdit((doc) => {
				const n = scopeAt(doc, groupPath).nodes.find((n) => n.id === id);
				if (n?.kind === 'group' && name.trim()) definition(doc, n.data.definition).name = name.trim();
			}),
		addBoundaryPort: (side: PortSide) =>
			documentEdit((doc) => {
				addPort(scopeAt(doc, groupPath), side);
			}),
		reorderBoundaryPort: (side: PortSide, id: string, target: string) => documentEdit((doc) => reorderPort(scopeAt(doc, groupPath), side, id, target)),
		boundaryPort: (side: PortSide, port: string, action: string, label?: string) =>
			documentEdit((doc) => editPort(scopeAt(doc, groupPath), side, port, action, label))
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
			const source = findGroupInstance(groupLibrary, chooserId);
			if (source) copyInstanceState(source.doc, source.path, doc, [...groupPath, instance]);
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
		if (!kind || !(kind in registry) || modalManager.isOpen || chooserOpen) return;
		const point = { x: event.clientX, y: event.clientY };
		const paths = wirePaths(false, true);
		const hits = paths.filter((w) => wireHitsBounds(w.points, { x: point.x - 12, y: point.y - 12, width: 24, height: 24 })).map((w) => w.id);
		flushPendingCommit();
		const previousNodes = nodes,
			previousEdges = edges,
			doc = structuredClone(groupDocument);
		try {
			const before = getSnapshot();
			captureIfChanged(before);
			let id = '';
			// Mount first so insertion uses the node's real channel capacity, not a guessed registry default.
			flushSync(() => {
				id = addNodeWithData(kind, defaultDataFor(kind), flow.screenToFlowPosition(point));
			});
			const node = nodes.find((n) => n.id === id)!;
			const rect = editorElement.querySelector<HTMLElement>(`.svelte-flow__node[data-id="${id}"]`)?.getBoundingClientRect();
			if (rect)
				nodes = nodes.map((n) =>
					n.id === id ? { ...n, position: flow.screenToFlowPosition({ x: point.x - rect.width / 2, y: point.y - rect.height / 2 }) } : n
				);
			const plan = insertionPlan(node, hits, paths);
			flushSync(() => {
				if (plan) insertIntoWires(id, plan);
			});
			const after = getSnapshot();
			if (plan) validateInsertion(before, after);
			commit(after);
		} catch (error) {
			flushSync(() => {
				nodes = previousNodes;
				edges = previousEdges;
				groupDocument = doc;
			});
			audioStore.reportError(error);
		} finally {
			clearTimeout(saveTimer);
			saveTimer = undefined;
			wireGeometry.clear();
		}
	}

	function addNode(kind: NodeKind, position?: { x: number; y: number }) {
		addNodeWithData(kind, defaultDataFor(kind), position);
	}

	function addNodeWithData(kind: NodeKind, data: Record<string, unknown>, position?: { x: number; y: number }) {
		const fallback = { x: 100 + nodes.length * 40, y: 100 + nodes.length * 40 };
		const size = registry[kind].defaultSize;
		const id = createId();
		nodes = [
			...nodes,
			{
				id,
				type: kind,
				position: position ?? fallback,
				data,
				...(size ?? {})
			}
		];
		return id;
	}

	function deleteNode(nodeId: string) {
		documentEdit((doc) => {
			const d = scopeAt(doc, groupPath),
				local = localNodeId(nodeId);
			if ([...d.inputs, ...d.outputs].some((p) => !p.disconnected && p.node === local))
				throw new Error('Disconnect the exposed group port before deleting this node.');
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

	function alignSelection(axis?: AlignmentAxis) {
		const positions = alignNodes(
			nodes.map((n) => ({ ...n, measured: flow.getInternalNode(n.id)?.measured ?? n.measured })),
			axis
		);
		if (!positions.size) return;
		editGraph(() => {
			nodes = nodes.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)! } : n));
		});
	}

	function bypassSelection() {
		const plan = planBulkBypass(nodes, registry);
		if (!plan.length) return;
		editGraph(() => {
			const patches = new Map(plan.map((p) => [p.id, p.bypassed]));
			nodes = nodes.map((n) => (patches.has(n.id) ? { ...n, data: { ...n.data, bypassed: patches.get(n.id)! } } : n));
		});
		if (audioStore.isRunning && audioStore.runningPipelineId === pipeline.id)
			for (const patch of plan) audioMethods.updateEffect(patch.id, { bypassed: patch.bypassed }).catch((error) => audioStore.reportError(error));
	}

	function convenienceMenuItems(): MenuItem[] {
		const count = nodes.filter((n) => n.selected && n.type !== 'groupBoundary' && n.draggable !== false).length;
		const bypass = planBulkBypass(nodes, registry);
		return [
			{ label: 'Align / distribute automatically', shortcut: 'Shift+=', disabled: count < 2, action: () => alignSelection() },
			{ label: 'Align / distribute horizontally', disabled: count < 2, action: () => alignSelection('horizontal') },
			{ label: 'Align / distribute vertically', disabled: count < 2, action: () => alignSelection('vertical') },
			{
				label: bypass[0]?.bypassed === false ? 'Engage selected effects' : 'Bypass selected effects',
				shortcut: 'M',
				disabled: !bypass.length,
				action: bypassSelection
			}
		];
	}

	function toggleGrid() {
		appSettings.snapToGrid = !appSettings.snapToGrid;
		appSettings.persist();
	}

	const INTERACTIVE =
		'input, textarea, select, button, a, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="button"]:not(.svelte-flow__node):not(.svelte-flow__selection-wrapper), [role="slider"], [role="combobox"], .nodrag, .nopan:not(.svelte-flow__node), .svelte-flow__handle, .svelte-flow__resize-control';
	type ConnectFrame = { x: number; y: number; width: number; height: number };
	let connectDrag = $state.raw<{
		source: string;
		target?: string;
		pointerId: number;
		startX: number;
		startY: number;
		x: number;
		y: number;
		frames: ConnectFrame[];
		sockets: Point[];
	} | null>(null);
	let connectNotice = $state('');
	let cutDrag = $state.raw<{ pointerId: number; points: Point[]; hits: Set<string>; protectedHits: Set<string> } | null>(null);
	let pointMotion = $state.raw<{ pointerId: number; edgeId: string; index: number; points: Point[]; start: Point; origin: Point } | null>(null);
	let insertion = $state.raw<NonNullable<ReturnType<typeof planWireInsertion>> | null>(null);
	let suppressRightMenu = false;
	let deletingCablePoint = false;
	let destroying = false;
	const wireGeometry = new Map<SVGPathElement, { key: string; points: Point[] }>();
	let dragCandidate: { pointerId: number; shake: ReturnType<typeof shakeDetector>; detach: boolean } | null = null;
	let nodeMotion = $state.raw<{
		pointerId: number;
		shake: ReturnType<typeof shakeDetector>;
		moved: XyNode[];
		positions: Map<string, Point>;
		detach: boolean;
		cancelled: boolean;
	} | null>(null);

	function editableEdge(id: string) {
		const edge = edges.find((e) => e.id === id);
		return !!edge && editableWire(edge);
	}

	function setCablePoints(id: string, points: Point[]) {
		edges = withReroutePoints(edges, id, points);
	}

	function removeCablePoint(id: string, index: number) {
		if (!editableEdge(id) || pointMotion || nodeMotion || cutDrag || connectDrag || modalManager.isOpen || chooserOpen) return;
		const points = (edges.find((e) => e.id === id)?.data as EdgeLayout | undefined)?.reroutes ?? [];
		if (!points[index]) return;
		editGraph(() =>
			setCablePoints(
				id,
				points.filter((_, i) => i !== index)
			)
		);
		editorElement.focus({ preventScroll: true });
	}

	function addCablePoint(id: string, point: Point, source: Point, target: Point) {
		if (!editableEdge(id) || pointMotion || nodeMotion || cutDrag || connectDrag || modalManager.isOpen || chooserOpen) return;
		const points = (edges.find((e) => e.id === id)?.data as EdgeLayout | undefined)?.reroutes ?? [];
		editGraph(() => {
			setCablePoints(id, insertReroute(source, target, points, point));
			edges = edges.map((e) => ({ ...e, selected: e.id === id }));
		});
	}

	function startCablePoint(id: string, index: number, event: PointerEvent) {
		if (
			event.button !== 0 ||
			!event.isPrimary ||
			!editableEdge(id) ||
			nodeMotion ||
			pointMotion ||
			cutDrag ||
			connectDrag ||
			modalManager.isOpen ||
			chooserOpen
		)
			return;
		event.preventDefault();
		event.stopPropagation();
		closeContextMenu();
		flushPendingCommit();
		captureIfChanged(getSnapshot());
		const points = (edges.find((e) => e.id === id)?.data as EdgeLayout | undefined)?.reroutes ?? [];
		if (!points[index]) return;
		pointMotion = {
			pointerId: event.pointerId,
			edgeId: id,
			index,
			points,
			start: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false }),
			origin: points[index]
		};
		(event.currentTarget as SVGCircleElement).focus({ preventScroll: true });
		editorElement.setPointerCapture(event.pointerId);
	}

	function moveCablePoint(event: PointerEvent) {
		const motion = pointMotion;
		if (!motion || event.pointerId !== motion.pointerId) return;
		const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
		const points = motion.points;
		setCablePoints(
			motion.edgeId,
			points.map((p, i) => (i === motion.index ? { x: motion.origin.x + at.x - motion.start.x, y: motion.origin.y + at.y - motion.start.y } : p))
		);
	}

	function finishCablePoint(cancel = false) {
		const motion = pointMotion;
		if (!motion) return;
		flushSync(() => {
			if (cancel) setCablePoints(motion.edgeId, motion.points);
			pointMotion = null;
		});
		clearTimeout(saveTimer);
		saveTimer = undefined;
		if (editorElement.hasPointerCapture(motion.pointerId)) editorElement.releasePointerCapture(motion.pointerId);
		try {
			const snap = getSnapshot();
			// Peer disconnects can change the graph while point dragging pauses autosave.
			if (!cancel || snapshotSignature(snap) !== snapshotSignature(history[cursor])) commit(snap);
		} catch (error) {
			setCablePoints(motion.edgeId, motion.points);
			audioStore.reportError(error);
		}
	}

	setContext<EdgeActions>(EDGE_ACTIONS, {
		editable: editableEdge,
		pending: (id) => insertion?.bundle.some((e) => e.id === id) ?? false,
		add: addCablePoint,
		start: startCablePoint,
		menu: (id, event, source, target, index) => {
			if (!editableEdge(id) || pointMotion || nodeMotion || cutDrag || connectDrag || modalManager.isOpen || chooserOpen) return;
			const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: false });
			contextMenu = {
				kind: 'edge',
				edgeId: id,
				x: event.clientX,
				y: event.clientY,
				items:
					index === undefined
						? [
								{ label: 'Add editable cable point', action: () => addCablePoint(id, point, source, target) },
								{ label: 'Delete cable', danger: true, action: () => editWires(edges.filter((e) => e.id !== id)) }
							]
						: [{ label: 'Remove cable point', shortcut: 'Delete', action: () => removeCablePoint(id, index) }]
			};
		}
	});

	function updateInsertion() {
		insertion = null;
		const motion = nodeMotion;
		if (!motion || motion.cancelled || motion.detach || motion.moved.length !== 1) return;
		const node = nodes.find((n) => n.id === motion.moved[0].id);
		if (
			!node ||
			!['effect', 'monitor'].includes(registry[node.type as NodeKind]?.category) ||
			edges.some((e) => e.source === node.id || e.target === node.id)
		) {
			connectNotice = '';
			return;
		}
		const internal = flow.getInternalNode(node.id);
		const size = internal?.measured;
		if (!size?.width || !size.height) return;
		const position = internal!.internals.positionAbsolute;
		const a = flow.flowToScreenPosition(position);
		const b = flow.flowToScreenPosition({ x: position.x + size.width, y: position.y + size.height });
		const paths = wirePaths(false, true);
		const hits = paths.filter((w) => wireHitsBounds(w.points, { ...a, width: b.x - a.x, height: b.y - a.y })).map((w) => w.id);
		insertion = insertionPlan(node, hits, paths);
		connectNotice = insertion ? 'Release to insert into the highlighted channel bundle. Esc cancels.' : '';
	}

	function insertionPlan(node: XyNode, hits: string[], paths: { id: string }[]) {
		const plan = planWireInsertion(
			node,
			registry[node.type as NodeKind]?.category,
			audioPorts(node.id, 'target'),
			audioPorts(node.id, 'source'),
			nodes,
			edges,
			hits,
			insertionHandles(groupDocument, groupPath)
		);
		return plan?.bundle.some((e) => !paths.some((p) => p.id === e.id)) ? null : plan;
	}

	function insertIntoWires(id: string, plan: NonNullable<typeof insertion>) {
		const ids = plan.connections.map(() => createId());
		ids.forEach((id) => seenEdgeIds.add(id));
		edges = saveWireInsertion(
			groupDocument,
			groupPath,
			nodes.map((n) => ({ ...n, data: $state.snapshot(n.data) })),
			edges,
			id,
			plan,
			ids
		);
	}

	function validateInsertion(before: Pipeline, after: Pipeline) {
		assertRewireAcyclic(before.edges, after.edges);
		const definitions = { ...groupLibrary.definitions, ...after.groups!.definitions };
		for (const p of Object.values(groupLibrary.pipelines))
			if (p.id !== pipeline.id && p.groups)
				assertRewireAcyclic(expand(structuredClone(p.groups)).edges, expand({ ...structuredClone(p.groups), definitions }).edges);
	}

	function wirePaths(includeOrphans = true, includeProtected = false) {
		const byId = new Map(edges.map((e) => [e.id, e]));
		const selector = includeOrphans ? '.svelte-flow__edge-path, path[data-wire-id]' : '.svelte-flow__edge-path';
		return [...editorElement.querySelectorAll<SVGPathElement>(selector)].flatMap((path) => {
			const id = path.dataset.wireId ?? path.closest<HTMLElement>('.svelte-flow__edge')?.dataset.id;
			const edge = id ? byId.get(id) : undefined;
			const matrix = path.getScreenCTM();
			if (!edge || (!includeProtected && !editableWire(edge)) || edge.hidden || !matrix) return [];
			const key = `${path.getAttribute('d')}:${matrix.a},${matrix.b},${matrix.c},${matrix.d},${matrix.e},${matrix.f}`;
			let geometry = wireGeometry.get(path);
			if (geometry?.key !== key) {
				geometry = { key, points: screenPath(path, matrix) };
				wireGeometry.set(path, geometry);
			}
			return [{ id: edge.id, points: geometry.points, editable: editableWire(edge) || (includeProtected && !!boundaryPort(edge)) }];
		});
	}
	function traceCut(point: Point, paths = wirePaths(true, true)) {
		if (!cutDrag) return;
		const last = cutDrag.points[cutDrag.points.length - 1];
		if (point.x === last.x && point.y === last.y) return;
		for (const wire of paths) {
			const hits = wire.editable ? cutDrag.hits : cutDrag.protectedHits;
			if (!hits.has(wire.id) && crossesWire(last, point, wire.points)) hits.add(wire.id);
		}
		cutDrag.points.push(point);
	}

	function editWires(next: XyEdge[], keepFeeds = false) {
		if (next === edges || (next.length === edges.length && next.every((e, i) => e === edges[i]))) return;
		const previous = edges,
			doc = structuredClone(groupDocument);
		try {
			const before = getSnapshot();
			editGraph(() => {
				edges = next;
				const after = getSnapshot();
				assertRewireAcyclic(before.edges, after.edges);
				if (keepFeeds) assertRewireKeepsFeeds(before, after);
				const definitions = { ...groupLibrary.definitions, ...after.groups!.definitions };
				for (const p of Object.values(groupLibrary.pipelines))
					if (p.id !== pipeline.id && p.groups) {
						const prior = expand(structuredClone(p.groups));
						const updated = expand({ ...structuredClone(p.groups), definitions });
						assertRewireAcyclic(prior.edges, updated.edges);
						if (keepFeeds) assertRewireKeepsFeeds(prior, updated);
					}
			});
		} catch (error) {
			flushSync(() => {
				edges = previous;
				groupDocument = doc;
			});
			audioStore.reportError(error);
		}
	}

	function switchSelectedInputs() {
		const selected = nodes.filter((n) => n.selected);
		if (selected.length !== 1 || selected[0].type === 'groupBoundary') return;
		const id = selected[0].id;
		const next = switchInputs(audioPorts(id, 'target'), edges, audioPorts(id, 'source'));
		connectNotice = next === edges ? 'No compatible input switch (unavailable inputs, group boundary, or an output would lose its feed).' : '';
		editWires(next, true);
	}

	function cancelCut() {
		if (!cutDrag) return;
		const { pointerId } = cutDrag;
		cutDrag = null;
		wireGeometry.clear();
		if (editorElement.hasPointerCapture(pointerId)) editorElement.releasePointerCapture(pointerId);
	}

	function onGestureMove(event: PointerEvent) {
		onConnectMove(event);
		if (modalManager.isOpen || chooserOpen) {
			cancelGestures();
			return;
		}
		if (pointMotion?.pointerId === event.pointerId) {
			if (!(event.buttons & 1)) finishCablePoint(true);
			else moveCablePoint(event);
		}
		const point = { x: event.clientX, y: event.clientY };
		if (cutDrag?.pointerId === event.pointerId) {
			if (!(event.buttons & 2)) {
				cancelCut();
				return;
			}
			const paths = wirePaths(true, true);
			const samples = event.getCoalescedEvents?.() ?? [];
			for (const sample of [...samples, event]) traceCut({ x: sample.clientX, y: sample.clientY }, paths);
			cutDrag = { ...cutDrag };
		}
		if (
			nodeMotion?.pointerId === event.pointerId &&
			!nodeMotion.cancelled &&
			!nodeMotion.detach &&
			nodeMotion.shake(point, event.timeStamp, !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey)
		) {
			nodeMotion.detach = true;
			insertion = null;
			connectNotice = 'Release to detach all editable connections and move. Esc cancels.';
		}
	}

	function onGestureEnd(event: PointerEvent) {
		if (modalManager.isOpen || chooserOpen) {
			cancelGestures();
			return;
		}
		if (pointMotion?.pointerId === event.pointerId && event.button === 0) {
			moveCablePoint(event);
			finishCablePoint();
		}
		if (cutDrag?.pointerId === event.pointerId && event.button === 2) {
			// Include the final segment even when no pointermove was delivered before release.
			traceCut({ x: event.clientX, y: event.clientY });
			const hits = cutDrag.hits;
			const protectedCount = cutDrag.protectedHits.size;
			cancelCut();
			if (edges.some((e) => hits.has(e.id) && boundaryPort(e))) documentEdit((doc) => cutGroupWires(doc, groupPath, edges, hits));
			else editWires(edges.filter((e) => !hits.has(e.id)));
			if (protectedCount) connectNotice = `${protectedCount} protected connections kept.`;
		}
		onConnectEnd(event);
		dragCandidate = null;
	}

	function onNodeDragStart({ nodes: moved, event }: { nodes: XyNode[]; event: MouseEvent | TouchEvent }) {
		closeContextMenu();
		if (!dragCandidate || !(event instanceof MouseEvent)) return;
		flushPendingCommit();
		captureIfChanged(getSnapshot());
		nodeMotion = {
			...dragCandidate,
			moved: moved.filter((n) => n.type !== 'groupBoundary'),
			positions: new Map(moved.map((n) => [n.id, { ...n.position }])),
			cancelled: false
		};
		if (nodeMotion.detach) connectNotice = 'Release to detach all editable connections and move. Esc cancels.';
	}

	function restoreMotionPositions() {
		if (!nodeMotion) return;
		const positions = nodeMotion.positions;
		nodes = nodes.map((n) => (positions.has(n.id) ? { ...n, position: positions.get(n.id)!, dragging: false } : n));
	}

	function onNodeDragStop() {
		const motion = nodeMotion;
		if (!motion) return;
		if (destroying) {
			restoreMotionPositions();
			nodeMotion = null;
			clearTimeout(saveTimer);
			saveTimer = undefined;
			return;
		}
		const previous = edges,
			doc = structuredClone(groupDocument);
		try {
			updateInsertion();
			const before = getSnapshot();
			flushSync(() => {
				if (motion.cancelled) restoreMotionPositions();
				else if (motion.detach) edges = detachNodes(edges, motion.moved);
				else if (insertion) {
					insertIntoWires(motion.moved[0].id, insertion);
					validateInsertion(before, getSnapshot());
				}
			});
			if (!motion.cancelled) commit(getSnapshot());
		} catch (error) {
			flushSync(() => {
				edges = previous;
				groupDocument = doc;
				restoreMotionPositions();
			});
			audioStore.reportError(error);
		} finally {
			flushSync(() => {
				nodeMotion = null;
				insertion = null;
			});
			clearTimeout(saveTimer);
			saveTimer = undefined;
			connectNotice = '';
			wireGeometry.clear();
		}
	}

	function cancelGestures() {
		finishCablePoint(true);
		insertion = null;
		cancelCut();
		cancelConnect();
		dragCandidate = null;
		if (nodeMotion) {
			nodeMotion.cancelled = true;
			// XYFlow uses d3 mouse listeners; end its drag before restoring the transaction.
			window.dispatchEvent(new MouseEvent('mouseup', { view: window, bubbles: true }));
			if (nodeMotion) onNodeDragStop();
		}
		connectNotice = '';
	}

	function onGestureCancel(event: PointerEvent) {
		if (
			event.pointerId === cutDrag?.pointerId ||
			event.pointerId === connectDrag?.pointerId ||
			event.pointerId === nodeMotion?.pointerId ||
			event.pointerId === pointMotion?.pointerId
		)
			cancelGestures();
	}

	function onEditorContextMenu(event: MouseEvent) {
		if (suppressRightMenu || cutDrag) {
			event.preventDefault();
			event.stopPropagation();
		}
	}

	$effect(() => {
		// XYFlow cancellation flushes state and must run outside the reactive update.
		if (modalManager.isOpen || chooserOpen) queueMicrotask(cancelGestures);
	});

	function bodyNode(target: EventTarget | null): HTMLElement | null {
		if (!(target instanceof Element) || target.closest(INTERACTIVE)) return null;
		const node = target.closest<HTMLElement>('.svelte-flow__node');
		return node && editorElement.contains(node) ? node : null;
	}
	function nodeAt(x: number, y: number): HTMLElement | undefined {
		return document
			.elementsFromPoint(x, y)
			.map((el) => el.closest<HTMLElement>('.svelte-flow__node'))
			.find((el): el is HTMLElement => !!el && editorElement.contains(el));
	}
	function connectDecoration(source: string, target?: string) {
		const rect = editorElement.getBoundingClientRect();
		const elements = [...editorElement.querySelectorAll<HTMLElement>('.svelte-flow__node')];
		const frames = [source, target].flatMap((id) => {
			const r = elements.find((el) => el.dataset.id === id)?.getBoundingClientRect();
			return r ? [{ x: r.left - rect.left - 3, y: r.top - rect.top - 3, width: r.width + 6, height: r.height + 6 }] : [];
		});
		const sockets: Point[] = [];
		for (const connection of target ? quickConnections(source, target) : []) {
			for (const side of ['source', 'target'] as const) {
				const handle = connection[side === 'source' ? 'sourceHandle' : 'targetHandle'];
				const el = elements.find((el) => el.dataset.id === connection[side]);
				const socket = [...(el?.querySelectorAll<HTMLElement>(`.svelte-flow__handle.${side}`) ?? [])].find(
					(el) => (el.dataset.handleid ?? null) === handle
				);
				if (socket) {
					const r = socket.getBoundingClientRect();
					sockets.push({ x: r.left + r.width / 2 - rect.left, y: r.top + r.height / 2 - rect.top });
				}
			}
		}
		return { frames, sockets };
	}

	function onEditorPointerDown(event: PointerEvent) {
		const target = event.target;
		if (event.button === 2 && !cutDrag) suppressRightMenu = false;
		if (!(target instanceof Element) || target.closest(INTERACTIVE) || modalManager.isOpen || chooserOpen || !event.isPrimary) return;
		if (cutDrag || connectDrag || nodeMotion || pointMotion) return;
		if (event.button === 2 && event.ctrlKey && !event.altKey && !event.metaKey) {
			event.preventDefault();
			event.stopPropagation();
			editorElement.focus({ preventScroll: true });
			closeContextMenu();
			suppressRightMenu = true;
			connectNotice = '';
			cutDrag = { pointerId: event.pointerId, points: [{ x: event.clientX, y: event.clientY }], hits: new Set(), protectedHits: new Set() };
			editorElement.setPointerCapture(event.pointerId);
			return;
		}
		if (event.button === 0) editorElement.focus({ preventScroll: true });
		const node = bodyNode(target) ?? (event.button === 2 && event.altKey ? nodeAt(event.clientX, event.clientY) : undefined);
		if (!node?.dataset.id) return;
		if (event.button === 0) {
			if (nodes.find((n) => n.id === node.dataset.id)?.type === 'groupBoundary') return;
			dragCandidate = {
				pointerId: event.pointerId,
				shake: shakeDetector({ x: event.clientX, y: event.clientY }, event.timeStamp),
				detach: event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
			};
			return;
		}
		if (event.button !== 2 || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		event.preventDefault();
		event.stopPropagation();
		editorElement.focus({ preventScroll: true });
		closeContextMenu();
		suppressRightMenu = true;
		connectNotice = '';
		const rect = editorElement.getBoundingClientRect();
		flushSync(() => {
			connectDrag = {
				source: node.dataset.id!,
				pointerId: event.pointerId,
				startX: event.clientX - rect.left,
				startY: event.clientY - rect.top,
				x: event.clientX - rect.left,
				y: event.clientY - rect.top,
				...connectDecoration(node.dataset.id!)
			};
		});
		editorElement.setPointerCapture(event.pointerId);
	}

	function onConnectMove(event: PointerEvent) {
		if (!connectDrag || connectDrag.pointerId !== event.pointerId) return;
		if (!(event.buttons & 2)) {
			cancelConnect();
			return;
		}
		const rect = editorElement.getBoundingClientRect();
		const hovered = nodeAt(event.clientX, event.clientY)?.dataset.id;
		const target = hovered === connectDrag.source ? undefined : hovered;
		connectDrag = {
			...connectDrag,
			target,
			x: event.clientX - rect.left,
			y: event.clientY - rect.top,
			...(target !== connectDrag.target ? connectDecoration(connectDrag.source, target) : {})
		};
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
		const ordered = d?.[portSide].filter((p) => p.node).map((p) => ({ id: p.id, handle: semantic(d, p.node, p.handle) }));
		return { id, handles: handles.map((h) => ({ id: h.id ?? null, y: h.y })), channels: channelPorts.get(id)?.[side], ordered };
	}

	function quickConnections(source: string, target: string): Connection[] {
		if (source === target) return [];
		const boundary = [source, target].filter((id) => id === BOUNDARY_INPUT || id === BOUNDARY_OUTPUT);
		if (!boundary.length) return planAutoConnect(audioPorts(source, 'source'), audioPorts(target, 'target'), edges);
		if (boundary.length !== 1 || !groupPath.length) return [];
		const input = boundary[0] === BOUNDARY_INPUT;
		const other = source === boundary[0] ? target : source;
		const d = scopeAt(groupDocument, groupPath);
		const exposed = d[input ? 'inputs' : 'outputs']
			.filter((port) => !port.disconnected && port.node === localNodeId(other))
			.map((port) => port.handle ?? null);
		const used = new Set<string>();
		return planGroupPorts(audioPorts(other, input ? 'target' : 'source'), input ? 'target' : 'source', edges, exposed).map((handle) => {
			const ports = d[input ? 'inputs' : 'outputs'];
			const reusable =
				ports.find((p) => !used.has(p.id) && p.disconnected && p.node === localNodeId(other) && (p.handle ?? null) === handle) ??
				ports.find((p) => !used.has(p.id) && p.disconnected && p.node && (p.handle ?? null) === handle) ??
				ports.find((p) => !used.has(p.id) && p.disconnected && !p.node);
			if (reusable) used.add(reusable.id);
			const socket = reusable?.id ?? NEW_GROUP_PORT;
			return input
				? { source: BOUNDARY_INPUT, sourceHandle: socket, target: other, targetHandle: handle }
				: { source: other, sourceHandle: handle, target: BOUNDARY_OUTPUT, targetHandle: socket };
		});
	}
	function exposeConnections(connections: Connection[]) {
		if (!groupPath.length) return;
		documentEdit((doc) => {
			const d = scopeAt(doc, groupPath);
			for (const connection of connections) {
				const port = boundaryPort(connection);
				if (!port) continue;
				const node = nodes.find((n) => n.id === port.node);
				const audio = audioPorts(port.node, port.side === 'inputs' ? 'target' : 'source');
				const handle = audio.ordered?.find((p) => p.id === port.handle)?.handle ?? port.handle;
				const label = String(node?.data.name ?? registry[node?.type as NodeKind]?.label ?? 'Audio');
				exposePort(d, port.side, localNodeId(port.node), port.handle, `${label} · ${handle ?? 'Audio'}`, port.port);
			}
		});
	}
	function onSocketConnect(connection: Connection) {
		if (!boundaryPort(connection)) return;
		// XYFlow adds the temporary edge before calling onconnect; only the stable port is saved.
		edges = edges.filter(
			(e) =>
				!(
					e.source === connection.source &&
					e.target === connection.target &&
					(e.sourceHandle ?? null) === (connection.sourceHandle ?? null) &&
					(e.targetHandle ?? null) === (connection.targetHandle ?? null)
				)
		);
		seenEdgeIds = new Set(edges.map((e) => e.id));
		exposeConnections([connection]);
	}
	function onConnectEnd(event: PointerEvent) {
		if (!connectDrag || connectDrag.pointerId !== event.pointerId || event.button !== 2) return;
		const source = connectDrag.source;
		const rect = editorElement.getBoundingClientRect();
		const moved = Math.hypot(event.clientX - rect.left - connectDrag.startX, event.clientY - rect.top - connectDrag.startY) >= 3;
		const target = nodeAt(event.clientX, event.clientY)?.dataset.id;
		cancelConnect();
		if (!moved || !target) return;
		const planned = quickConnections(source, target);
		if (!planned.length) {
			const boundary = [source, target].some((id) => id === BOUNDARY_INPUT || id === BOUNDARY_OUTPUT);
			connectNotice = boundary
				? 'No additional audio ports available to expose. Outputs must have an input feed; fixed ports and channel limits are preserved.'
				: createsCycle(source, target, edges)
					? 'Cannot connect: this would create an audio loop.'
					: 'No new compatible audio connections (already connected or no matching channels).';
			return;
		}
		if (planned.some((connection) => boundaryPort(connection))) {
			exposeConnections(planned);
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
		const items: MenuItem[] = convenienceMenuItems();
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
								if (!d[side].some((p) => !p.disconnected && p.node === local && p.handle === (handle.id ?? undefined)))
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
			...convenienceMenuItems(),
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
		groupDocument.pluginStates = doc.pluginStates;
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
			groupPath = survivingGroupPath(groupDocument, groupPath);
			replaceState(groupUrl(page.url, groupPath), { ...page.state, editorGroupPath: groupPath });
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

	const restoreHistory = createHistoryRestorer({
		flush: flushPendingCommit,
		current: () => ({ history, cursor }),
		restore: restoreSnapshot,
		setCursor: (next) => (cursor = next)
	});

	function undo() {
		cancelGestures();
		return restoreHistory(-1);
	}

	function redo() {
		cancelGestures();
		return restoreHistory(1);
	}

	pipelineStore.editorActions = {
		pipelineId: untrack(() => pipeline.id),
		addNode,
		addNodeWithData,
		getSnapshot,
		getRuntimeSnapshot,
		save: () => {
			cancelGestures();
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
		saveTimer = undefined;
		if (nodeMotion || pointMotion) return;
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
	let routingCache: { doc: GroupDocument; library: GroupLibrary; input: string; signature: string; snapshot: Pipeline } | undefined;
	function getRuntimeSnapshot(): Pipeline | null {
		// Live controls read audio data, never editor positions or undo state.
		return routingSignature() ? routingCache!.snapshot : null;
	}
	function routingSignature(): string {
		try {
			const input = JSON.stringify({
				path: groupPath,
				nodes: nodes.map((n) => ({ id: n.id, type: n.type, data: n.data })),
				edges: edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle }))
			});
			// Geometry changes must not clone, expand and validate the complete group document.
			if (routingCache?.doc === groupDocument && routingCache.library === groupLibrary && routingCache.input === input) return routingCache.signature;
			const p = getSnapshot();
			const signature = JSON.stringify({ nodes: p.nodes.map((n) => ({ id: n.id, kind: n.kind, data: n.data })), edges: p.edges });
			routingCache = { doc: groupDocument, library: groupLibrary, input, signature, snapshot: p };
			return signature;
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
		// A held Delete must not reach XYFlow after removing the focused point.
		if (deletingCablePoint && (e.key === 'Delete' || e.key === 'Backspace')) {
			e.preventDefault();
			e.stopImmediatePropagation();
			return;
		}
		const t = e.target as HTMLElement | null;
		const tag = t?.tagName?.toLowerCase();
		const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || t?.isContentEditable;
		const onCanvas = !!t && editorElement.contains(t) && !t.closest(INTERACTIVE) && !modalManager.isOpen && !chooserOpen && !contextMenu;

		if (e.key === 'Escape') {
			const active = cutDrag || connectDrag || nodeMotion || pointMotion || contextMenu;
			closeContextMenu();
			cancelGestures();
			connectNotice = '';
			if (active) {
				e.preventDefault();
				e.stopImmediatePropagation();
				return;
			}
		}
		if ((onCanvas || !!pointMotion) && (cutDrag || connectDrag || nodeMotion || pointMotion)) {
			e.preventDefault();
			e.stopImmediatePropagation();
			return;
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
			if ((e.key === 'Enter' || e.key === 'Tab') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
				const selected = nodes.filter((n) => n.selected && n.type !== 'groupBoundary');
				const n = selected.length === 1 && selected[0].type === 'group' ? selected[0] : undefined;
				if (n || (e.key === 'Tab' && groupPath.length)) {
					e.preventDefault();
					e.stopImmediatePropagation();
					if (n) openGroup(n.id);
					else navigate(groupPath.slice(0, -1));
					return;
				}
			}
		}
		const cablePoint = t?.closest<SVGCircleElement>('[data-reroute-point]');
		if (cablePoint && editorElement.contains(cablePoint) && (e.key === 'Delete' || e.key === 'Backspace')) {
			deletingCablePoint = true;
			e.preventDefault();
			e.stopImmediatePropagation();
			if (!e.repeat && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && !modalManager.isOpen && !chooserOpen && !contextMenu)
				removeCablePoint(cablePoint.dataset.rerouteEdge!, Number(cablePoint.dataset.reroutePoint));
			return;
		}
		const shortcut = canvasShortcut(e, onCanvas && !connectDrag && !e.defaultPrevented);
		if (shortcut) {
			e.preventDefault();
			if (!e.repeat) {
				if (shortcut === 'toggleGrid') toggleGrid();
				else if (shortcut === 'switchInputs') switchSelectedInputs();
				else if (shortcut === 'align') alignSelection();
				else if (shortcut === 'bypass') bypassSelection();
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
		cancelGestures();
		flushPendingCommit();
	}

	onMount(() => {
		window.addEventListener('keydown', onWindowKeyDown, { capture: true });
		window.addEventListener('pointermove', onGestureMove, { capture: true });
		window.addEventListener('pointerup', onGestureEnd, { capture: true });
		window.addEventListener('beforeunload', onBeforeUnload);
		void pipelineMethods
			.library()
			.then((value) => (groupLibrary = value))
			.catch((error) => audioStore.reportError(error));
		return () => {
			window.removeEventListener('keydown', onWindowKeyDown, { capture: true });
			window.removeEventListener('pointermove', onGestureMove, { capture: true });
			window.removeEventListener('pointerup', onGestureEnd, { capture: true });
			window.removeEventListener('beforeunload', onBeforeUnload);
		};
	});

	onDestroy(() => {
		destroying = true;
		cancelGestures();
		flushPendingCommit();
		clearTimeout(restartTimer);
		// Keep runtime controls on the latest document until its save reaches the root store.
		void commitQueue.then(() => {
			if (pipelineStore.editorActions?.getSnapshot === getSnapshot) pipelineStore.editorActions = null;
		});
	});
</script>

<svelte:window
	onmousedown={closeContextMenu}
	onpointercancel={onGestureCancel}
	onblur={() => {
		deletingCablePoint = false;
		cancelGestures();
	}}
	onkeyup={(event) => {
		if (event.key === 'Delete' || event.key === 'Backspace') deletingCablePoint = false;
	}} />

<div class="flex h-full w-full">
	<div
		bind:this={editorElement}
		class="flow-editor relative flex-1"
		class:connecting={connectDrag !== null}
		class:cutting={cutDrag !== null}
		role="region"
		aria-label="Flow editor"
		tabindex="-1"
		onpointerdowncapture={onEditorPointerDown}
		onlostpointercapture={onGestureCancel}
		oncontextmenucapture={onEditorContextMenu}
		onmousedowncapture={(e) => {
			if (connectDrag || cutDrag) {
				e.preventDefault();
				e.stopPropagation();
			}
		}}
		ondblclickcapture={(event) => {
			const id = bodyNode(event.target)?.dataset.id;
			if (id && nodes.some((n) => n.id === id && n.type === 'group')) {
				event.preventDefault();
				event.stopPropagation();
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
			onconnect={onSocketConnect}
			isValidConnection={(connection) => {
				if (![connection.source, connection.target].some((id) => id.startsWith('$group-'))) return true;
				const port = boundaryPort(connection);
				return !!port && (!port.port || !!scopeAt(groupDocument, groupPath)[port.side].find((p) => p.id === port.port)?.disconnected);
			}}
			onbeforedelete={async ({ nodes: deleted, edges: deletedEdges }) => {
				const d = scopeAt(groupDocument, groupPath);
				if (deleted.some((n) => [...d.inputs, ...d.outputs].some((p) => !p.disconnected && p.node === localNodeId(n.id)))) {
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
			onnodedrag={updateInsertion}
			onnodedragstart={onNodeDragStart}
			onnodedragstop={onNodeDragStop}
			onselectionstart={closeContextMenu}
			onmovestart={closeContextMenu}
			snapGrid={appSettings.snapToGrid ? [appSettings.gridSize, appSettings.gridSize] : undefined}>
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
			{#if groupPath.length}<button
					class="inline-flex items-center gap-1"
					aria-label="Back to parent group"
					onclick={() => navigate(groupPath.slice(0, -1))}><ArrowLeft class="size-4" /> Back</button
				>{/if}
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
				<p>
					Inputs and microphones are kept. Independent copies clear recording destinations and mute hotkeys. Linked copies share them. All groups run
					inside this pipeline.
				</p>
				<div class="flex gap-3">
					<button disabled={!chooserId} onclick={insertGroup}>Add {chooserLinked ? 'linked' : 'independent'} group</button><button
						onclick={() => (chooserOpen = false)}>Cancel</button>
				</div>
			</div>
		{/if}
		{#if connectDrag}
			<svg class="quick-connect-preview pointer-events-none absolute inset-0 z-20 h-full w-full text-red-600 dark:text-red-400" aria-hidden="true">
				{#each connectDrag.frames as frame}
					<rect x={frame.x} y={frame.y} width={frame.width} height={frame.height} rx="9" fill="none" stroke="currentColor" stroke-width="2.5" />
				{/each}
				<line
					x1={connectDrag.startX}
					y1={connectDrag.startY}
					x2={connectDrag.x}
					y2={connectDrag.y}
					stroke="currentColor"
					stroke-width="2.5"
					stroke-linecap="round" />
				<circle cx={connectDrag.startX} cy={connectDrag.startY} r="5" fill="currentColor" />
				<circle cx={connectDrag.x} cy={connectDrag.y} r="5" fill="currentColor" />
				{#each connectDrag.sockets as socket}
					<circle cx={socket.x} cy={socket.y} r="6" fill="none" stroke="currentColor" stroke-width="2" />
				{/each}
			</svg>
		{/if}
		{#if cutDrag}
			{@const rect = editorElement.getBoundingClientRect()}
			<svg class="pointer-events-none absolute inset-0 z-20 h-full w-full text-red-500" aria-hidden="true">
				<polyline
					points={cutDrag.points.map((p) => `${p.x - rect.left},${p.y - rect.top}`).join(' ')}
					fill="none"
					stroke="currentColor"
					stroke-width="2" />
			</svg>
			<p role="status" class="pointer-events-none absolute top-14 right-3 z-10 rounded bg-neutral-100 p-2 text-xs text-neutral-1000">
				Release to cut {cutDrag.hits.size} connections · Esc cancels
				{#if cutDrag.protectedHits.size}
					· {cutDrag.protectedHits.size} protected connections{/if}
			</p>
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
	.flow-editor.cutting :global(*) {
		cursor: crosshair;
	}
</style>
