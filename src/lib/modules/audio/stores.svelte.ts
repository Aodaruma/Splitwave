import type { UnlistenFn } from '@tauri-apps/api/event';
import { browser } from '$app/environment';
import toast from 'svelte-french-toast';
import { open, save } from '@tauri-apps/plugin-dialog';
import { methods } from './methods';
import type { AudioApplication, AudioDevice, StartPipelinePayload } from './types';
import { methods as pipelineMethods } from '$lib/modules/pipeline/methods';
import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
import { isFromFuture } from '$lib/modules/pipeline/migrations';
import type { FileRecordingNodeData, PipelineNode, RecordingFormat } from '$lib/modules/pipeline/types';
import { appSettings } from '$lib/modules/settings/stores.svelte';
import { errorStore } from '$lib/modules/error';

// Mirrors `extension()` in the File Recording node: the dialog filter must
// match the encoder the node will actually write.
function recordingExtension(fmt: RecordingFormat): string {
	if (fmt.kind === 'flac') return 'flac';
	if (fmt.kind === 'opus') return 'opus';
	if (fmt.kind === 'mp3') return 'mp3';
	if (fmt.kind === 'aac') return 'm4a';
	if (fmt.kind === 'aiff') return 'aiff';
	return 'wav';
}

function pruneDanglingEdgesPayload(payload: StartPipelinePayload): StartPipelinePayload {
	const ids = new Set(payload.nodes.map((n) => n.id));
	const edges = payload.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
	return edges.length === payload.edges.length ? payload : { ...payload, edges };
}

export class AudioStore {
	inputDevices = $state<AudioDevice[]>([]);
	outputDevices = $state<AudioDevice[]>([]);
	audioApplications = $state<AudioApplication[]>([]);
	isRunning = $state(false);
	runningPipelineId = $state<string | null>(null);
	startedAt = $state<number | null>(null);
	chooseFileNodeId = $state<string | null>(null);
	pendingRetryPipelineId = $state<string | null>(null);
	pendingNodeIds = $state<Set<string>>(new Set());
	missingFilePaths = $state<Set<string>>(new Set());
	safeMode = $state(false);
	shuttingDown = false;

	private lastGraph: StartPipelinePayload | null = null;
	private fullGraph: StartPipelinePayload | null = null;
	private reconnectTimer: ReturnType<typeof setInterval> | undefined;
	private pendingOperation = Promise.resolve();
	private operationVersion = 0;
	private pendingDeactivation?: Promise<void>;
	private unlisten: UnlistenFn | undefined;
	private unlistenSpeakerError: UnlistenFn | undefined;
	private unlistenInputError: UnlistenFn | undefined;

	private enqueueOperation(operation: (cancelled: () => boolean) => Promise<void>, stopping = false): Promise<void> {
		const version = this.operationVersion;
		const cancelled = () => version !== this.operationVersion || this.shuttingDown;
		const next = this.pendingOperation.then(() => {
			if (!stopping && cancelled()) return;
			return operation(cancelled);
		});
		this.pendingOperation = next.catch(() => {});
		return next;
	}

	private cancelPendingOperations(): void {
		this.operationVersion += 1;
		this.stopPendingReconnectLoop();
		this.chooseFileNodeId = null;
		this.pendingRetryPipelineId = null;
	}

	takeRecordingRetry(): ((graph: StartPipelinePayload) => Promise<void>) | null {
		const pipelineId = this.pendingRetryPipelineId;
		const version = this.operationVersion;
		this.pendingRetryPipelineId = null;
		if (!pipelineId) return null;
		return (graph) => (version === this.operationVersion ? this.activatePipeline(pipelineId, graph) : Promise.resolve());
	}

	async refreshInputDevices(): Promise<void> {
		this.inputDevices = await methods.listInputDevices();
	}

	async refreshOutputDevices(): Promise<void> {
		this.outputDevices = await methods.listOutputDevices();
	}

	async refreshAudioApplications(): Promise<void> {
		const apps = await methods.listAudioApplications().catch(() => [] as AudioApplication[]);
		this.audioApplications = apps;
		if (apps.length === 0) return;
		methods
			.getAppIcons(apps.map((a) => a.bundleId))
			.then((icons) => {
				this.audioApplications = this.audioApplications.map((a) => (icons[a.bundleId] ? { ...a, icon: icons[a.bundleId] } : a));
			})
			.catch(() => {});
	}

	async init(): Promise<void> {
		await Promise.all([this.refreshInputDevices(), this.refreshOutputDevices()]);
		void this.refreshAudioApplications();
		this.isRunning = await methods.isPipelineRunning().catch(() => false);
		if (this.isRunning) this.startedAt = Date.now();
		this.unlisten = await methods.onState((e) => {
			if (e.kind === 'started') {
				this.isRunning = true;
				this.startedAt = Date.now();
			} else if (e.kind === 'stopped') {
				if (this.pendingNodeIds.size === 0) {
					this.stopPendingReconnectLoop();
					this.isRunning = false;
					this.runningPipelineId = null;
					this.startedAt = null;
				}
			} else if (e.kind === 'error') {
				void this.enqueueOperation(() => this.stopCurrentPipeline()).catch((error) => this.reportError(error));
				this.reportError(e.message);
			}
		});

		this.unlistenInputError = await methods.onInputError((payload) => {
			void this.recoverDevice(payload.nodeId, payload.error || 'Input device disconnected').catch((e) => this.reportError(e));
		});
		this.unlistenSpeakerError = await methods.onSpeakerError((payload) => {
			void this.recoverDevice(payload.nodeId, payload.error || 'Speaker device disconnected').catch((e) => this.reportError(e));
		});
	}

	private recoverDevice(nodeId: string | undefined, message: string): Promise<void> {
		return this.enqueueOperation(async (cancelled) => {
			if (!this.isRunning) return;
			this.reportError(message);
			if (!appSettings.keepRunningOnDisconnect) {
				await this.stopCurrentPipeline();
				return;
			}
			if (this.fullGraph && nodeId) {
				this.pendingNodeIds.add(nodeId);
				const reduced = this.buildReducedGraph(this.fullGraph, this.pendingNodeIds);
				if (reduced.nodes.length > 0) {
					try {
						await methods.reconcilePipeline(reduced);
						this.lastGraph = reduced;
						if (!cancelled()) this.startPendingReconnectLoop();
						return;
					} catch {
						if (cancelled()) return;
					}
				}
			}
			// Keep the desired pipeline identity while waiting for missing devices.
			await methods.stopPipeline();
			if (!cancelled()) this.startPendingReconnectLoop();
		});
	}

	activatePipeline(pipelineId: string, graph: StartPipelinePayload): Promise<void> {
		return this.enqueueOperation(async (cancelled) => {
			if (this.isRunning || this.runningPipelineId) return;
			this.safeMode = false;
			while (!cancelled()) {
				this.lastGraph = graph;
				this.fullGraph = graph;
				const excluded = appSettings.keepRunningOnDisconnect ? await this.unresolvedInputIds(graph) : new Set<string>();
				if (cancelled()) return;
				this.pendingNodeIds = excluded;
				const toStart = this.buildReducedGraph(graph, excluded);
				try {
					await methods.startPipeline(toStart);
				} catch (e) {
					if (cancelled()) return;
					const nodeId = this.chooseFileNodeIdFrom(e);
					if (!nodeId) {
						this.pendingNodeIds.clear();
						throw e;
					}
					if (pipelineStore.editorActions?.getSnapshot()?.id === pipelineId) {
						this.chooseFileNodeId = nodeId;
						this.pendingRetryPipelineId = pipelineId;
						return;
					}
					const next = await this.promptRecordingFile(pipelineId, graph, nodeId, cancelled);
					if (!next) return;
					graph = next;
					continue;
				}
				// A pending stop/exit still needs the identity of a completed start.
				this.isRunning = true;
				this.startedAt ??= Date.now();
				this.runningPipelineId = pipelineId;
				this.lastGraph = toStart;
				if (!cancelled() && excluded.size > 0) this.startPendingReconnectLoop();
				await pipelineMethods.setActivePipelineId(pipelineId);
				return;
			}
		});
	}

	private chooseFileNodeIdFrom(e: unknown): string | null {
		const msg = e instanceof Error ? e.message : String(e);
		const m = /choose-file \(node ([^)]+)\)/.exec(msg);
		return m ? m[1] : null;
	}

	/** Opens the save dialog for a recording node and returns the graph with the
	 * chosen path applied, or `null` when the user cancels. Persists the path so
	 * a later activation from the list won't prompt again. Append mode picks an
	 * existing file instead of asking for a new one. */
	private async promptRecordingFile(
		pipelineId: string,
		graph: StartPipelinePayload,
		nodeId: string,
		cancelled: () => boolean
	): Promise<StartPipelinePayload | null> {
		const node = graph.nodes.find((n) => n.id === nodeId);
		if (!node) return null;
		const data = node.data as FileRecordingNodeData;
		const ext = recordingExtension(data.format);
		const append = data.mode === 'append';
		let path: string | null;
		if (append) {
			const picked = await open({
				title: 'Choose recording to append to',
				multiple: false,
				filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
			});
			path = typeof picked === 'string' ? picked : null;
		} else {
			path = await save({ title: 'Save recording', filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
		}
		if (!path || cancelled()) return null;
		// A fresh path can be written unconditionally; only append keeps the
		// "extend this file" intent, everything else lands as a plain overwrite.
		const mode = append ? 'append' : 'overwrite';
		const patchNode = (n: PipelineNode): PipelineNode => (n.id === nodeId ? { ...n, data: { ...n.data, filePath: path, mode } } : n);
		await pipelineStore.update(pipelineId, (p) => ({ ...p, nodes: p.nodes.map(patchNode), updatedAt: Date.now() }));
		return { nodes: graph.nodes.map(patchNode), edges: graph.edges };
	}

	/** Explicit user stop: unlike an engine-reported `stopped`/`error` event
	 * (handled in `init()`), this also forgets the persisted active pipeline
	 * so a future launch doesn't try to auto-activate it again. */
	deactivatePipeline(): Promise<void> {
		this.cancelPendingOperations();
		if (this.pendingDeactivation) return this.pendingDeactivation;
		const stop = this.enqueueOperation(async () => {
			try {
				await this.stopCurrentPipeline();
			} catch (error) {
				await pipelineMethods.setActivePipelineId(null).catch((e) => this.reportError(e));
				throw error;
			}
			await pipelineMethods.setActivePipelineId(null);
		}, true).finally(() => {
			this.pendingDeactivation = undefined;
		});
		this.pendingDeactivation = stop;
		return stop;
	}

	stopForExit(beforeStop?: () => Promise<void>): Promise<void> {
		this.shuttingDown = true;
		this.cancelPendingOperations();
		const pendingStop = this.pendingDeactivation;
		return this.enqueueOperation(async () => {
			await pendingStop;
			await beforeStop?.();
			await this.stopCurrentPipeline();
		}, true);
	}

	private async stopCurrentPipeline(): Promise<void> {
		this.stopPendingReconnectLoop();
		this.pendingNodeIds.clear();
		this.isRunning = false;
		this.runningPipelineId = null;
		this.startedAt = null;
		await methods.stopPipeline();
	}

	/** Restores the pipeline that was active when the app last closed (or the
	 * PC last rebooted). Any App Audio / Audio File source not available yet
	 * is left out of the initial start and reconnected later by the polling
	 * loop once it becomes available. */
	autoActivateOnLaunch(): Promise<void> {
		return this.enqueueOperation(async (cancelled) => {
			if (this.isRunning || this.runningPipelineId) return;
			const crashGuard = browser && window.localStorage.getItem('splitwave:boot_audio_crash_guard') === 'true';
			if (errorStore.hadPreviousCrash || crashGuard) {
				this.safeMode = true;
				if (browser) window.localStorage.removeItem('splitwave:boot_audio_crash_guard');
				this.reportError(new Error('Safe Mode: Auto-starting previous pipeline was skipped because Splitwave crashed last time.'));
				return;
			}

			const id = await pipelineMethods.getActivePipelineId().catch(() => null);
			if (!id) return;
			const p = await pipelineMethods.get(id).catch(() => null);
			if (!p || isFromFuture(p)) return;
			const full: StartPipelinePayload = { nodes: p.nodes, edges: p.edges };
			this.fullGraph = full;
			const excluded = appSettings.keepRunningOnDisconnect ? await this.unresolvedInputIds(full) : new Set<string>();
			if (cancelled()) return;
			this.pendingNodeIds = excluded;
			const reduced = this.buildReducedGraph(full, excluded);
			if (browser) window.localStorage.setItem('splitwave:boot_audio_crash_guard', 'true');
			try {
				await methods.startPipeline(reduced);
			} catch (e) {
				if (browser) window.localStorage.removeItem('splitwave:boot_audio_crash_guard');
				this.reportError(e);
				return;
			}
			setTimeout(() => {
				if (browser) window.localStorage.removeItem('splitwave:boot_audio_crash_guard');
			}, 4000);
			this.lastGraph = reduced;
			this.isRunning = true;
			this.startedAt ??= Date.now();
			this.runningPipelineId = id;
			if (!cancelled() && excluded.size > 0) {
				this.startPendingReconnectLoop();
			}
		});
	}

	/** Which input nodes in `full` can't resolve right now: an App Audio node
	 * whose bundle isn't currently running, or an Audio File node whose path
	 * doesn't exist on disk. Building this list also refreshes the app list,
	 * since a stale snapshot would wrongly exclude/include nodes. */
	private async unresolvedInputIds(full: StartPipelinePayload): Promise<Set<string>> {
		await Promise.all([this.refreshInputDevices(), this.refreshOutputDevices(), this.refreshAudioApplications()]);
		const running = new Set(this.audioApplications.map((a) => a.bundleId));
		const inputIds = new Set(this.inputDevices.map((d) => d.id));
		const outputIds = new Set(this.outputDevices.map((d) => d.id));
		const unresolved = new Set<string>();
		const filePaths = new Set<string>();
		for (const n of full.nodes) {
			if (n.kind === 'appAudio') {
				const bundleId = (n.data as { bundleId: string | null }).bundleId;
				if (bundleId && !running.has(bundleId)) unresolved.add(n.id);
			} else if (n.kind === 'microphone') {
				const deviceId = (n.data as { deviceId: string | null }).deviceId;
				if (deviceId && !inputIds.has(deviceId)) unresolved.add(n.id);
			} else if (n.kind === 'speaker') {
				const deviceId = (n.data as { deviceId: string | null }).deviceId;
				if (deviceId && !outputIds.has(deviceId)) unresolved.add(n.id);
			} else if (n.kind === 'audioFile') {
				const filePath = (n.data as { filePath: string | null }).filePath;
				if (filePath) filePaths.add(filePath);
			}
		}
		const stillMissing = new Set<string>();
		await Promise.all(
			[...filePaths].map(async (path) => {
				const exists = await methods.pathExists(path).catch(() => true);
				if (!exists) stillMissing.add(path);
			})
		);
		this.missingFilePaths = stillMissing;
		for (const n of full.nodes) {
			if (n.kind === 'audioFile') {
				const filePath = (n.data as { filePath: string | null }).filePath;
				if (filePath && stillMissing.has(filePath)) unresolved.add(n.id);
			}
		}
		return unresolved;
	}

	private buildReducedGraph(full: StartPipelinePayload, excludeIds: Set<string>): StartPipelinePayload {
		if (excludeIds.size === 0) return full;
		const nodes: PipelineNode[] = full.nodes.filter((n) => !excludeIds.has(n.id));
		return pruneDanglingEdgesPayload({ nodes, edges: full.edges });
	}

	private startPendingReconnectLoop(): void {
		this.stopPendingReconnectLoop();
		this.reconnectTimer = setInterval(() => {
			void this.tryReconnectPending();
		}, 3000);
	}

	private stopPendingReconnectLoop(): void {
		if (this.reconnectTimer !== undefined) {
			clearInterval(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private tryReconnectPending(): Promise<void> {
		const pipelineId = this.runningPipelineId;
		return this.enqueueOperation(async (cancelled) => {
			if (!pipelineId || this.runningPipelineId !== pipelineId) return;
			if (cancelled()) return;
			if (!appSettings.keepRunningOnDisconnect || this.pendingNodeIds.size === 0 || !this.fullGraph || !this.isRunning) {
				this.stopPendingReconnectLoop();
				return;
			}
			const stillUnresolved = await this.unresolvedInputIds(this.fullGraph);
			if (cancelled()) return;
			const isUnchanged = stillUnresolved.size === this.pendingNodeIds.size && [...stillUnresolved].every((id) => this.pendingNodeIds.has(id));
			if (isUnchanged) return;
			this.pendingNodeIds = stillUnresolved;
			const reduced = this.buildReducedGraph(this.fullGraph, stillUnresolved);
			try {
				await methods.reconcilePipeline(reduced);
				this.lastGraph = reduced;
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				if (cancelled()) return;
				if (msg.includes('not running')) {
					try {
						await methods.startPipeline(reduced);
						this.lastGraph = reduced;
					} catch {
						return;
					}
				} else {
					return;
				}
			}
			if (stillUnresolved.size === 0) this.stopPendingReconnectLoop();
		});
	}

	/** Apply a new graph to the running pipeline. Uses `reconcile_pipeline`,
	 * which diffs the new graph and only touches what changed — input
	 * streams stay alive across edits when their spec is unchanged.
	 * Falls back to stop + start if the pipeline isn't running. */
	restartPipeline(graph: StartPipelinePayload): Promise<void> {
		const pipelineId = this.runningPipelineId;
		return this.enqueueOperation(async (cancelled) => {
			if (!pipelineId || this.runningPipelineId !== pipelineId) return;
			if (cancelled()) return;
			this.fullGraph = graph;
			for (const id of this.pendingNodeIds) {
				if (!graph.nodes.some((n) => n.id === id)) {
					this.pendingNodeIds.delete(id);
				}
			}
			if (this.pendingNodeIds.size === 0) {
				this.stopPendingReconnectLoop();
			}
			const toRun = appSettings.keepRunningOnDisconnect && this.pendingNodeIds.size > 0 ? this.buildReducedGraph(graph, this.pendingNodeIds) : graph;
			this.lastGraph = toRun;
			let reconcileErr: unknown;
			try {
				await methods.reconcilePipeline(toRun);
				return;
			} catch (e) {
				reconcileErr = e;
			}
			const msg = reconcileErr instanceof Error ? reconcileErr.message : String(reconcileErr);
			if (cancelled()) return;
			if (msg.includes('not running')) {
				try {
					await methods.startPipeline(toRun);
				} catch (e) {
					if (cancelled() || this.routeStartError(e)) return;
					this.stopPendingReconnectLoop();
					this.isRunning = false;
					this.runningPipelineId = null;
					this.startedAt = null;
					await methods.stopPipeline().catch(() => {});
					throw e;
				}
			} else {
				if (cancelled() || this.routeStartError(reconcileErr)) return;
				this.stopPendingReconnectLoop();
				this.isRunning = false;
				this.runningPipelineId = null;
				this.startedAt = null;
				await methods.stopPipeline().catch(() => {});
				throw reconcileErr;
			}
		});
	}

	private routeStartError(e: unknown): boolean {
		const nodeId = this.chooseFileNodeIdFrom(e);
		if (!nodeId) return false;
		this.chooseFileNodeId = nodeId;
		this.pendingRetryPipelineId = null;
		return true;
	}

	reportError(e: unknown): void {
		toast.error(e instanceof Error ? e.message : String(e));
	}

	destroy(): void {
		this.cancelPendingOperations();
		this.unlisten?.();
		this.unlisten = undefined;
		this.unlistenSpeakerError?.();
		this.unlistenSpeakerError = undefined;
		this.unlistenInputError?.();
		this.unlistenInputError = undefined;
	}
}

export const audioStore = new AudioStore();
