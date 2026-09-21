import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { audioStore } from '$lib/modules/audio/stores.svelte';
import { methods as audioMethods } from '$lib/modules/audio/methods';
import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
import { methods as pipelineMethods } from '$lib/modules/pipeline/methods';
import { isFromFuture } from '$lib/modules/pipeline/migrations';
import { appSettings } from '$lib/modules/settings/stores.svelte';
import type { Pipeline, PluginNodeData } from '$lib/modules/pipeline/types';

class DesktopStore {
	ready = $state(false);
	busy = $state(false);
	quitting = $state(false);
	private unlisten?: UnlistenFn;
	private syncQueue = Promise.resolve();
	private actionCount = 0;

	async init(): Promise<void> {
		if (!isTauri()) return;
		this.unlisten = await listen<string>('desktop://action', (e) => void this.handleAction(e.payload));
		await appSettings.syncLaunchOnStartup();
		await pipelineStore.refresh();
		this.ready = true;
		await this.sync();
	}

	sync(): Promise<void> {
		if (!this.ready) return Promise.resolve();
		const config = {
			closeToTray: appSettings.closeToTray,
			launchOnStartup: appSettings.launchOnStartup,
			startInTray: appSettings.startInTray,
			runningPipelineId: audioStore.isRunning ? audioStore.runningPipelineId : null,
			busy: this.busy,
			pipelines: pipelineStore.pipelines.map(({ id, name }) => ({ id, name }))
		};
		const next = this.syncQueue.then(() => invoke<void>('sync_desktop', { config }));
		this.syncQueue = next.catch(() => {});
		return next;
	}

	async hideOnLaunch(): Promise<void> {
		if (!this.ready || !appSettings.startInTray || audioStore.safeMode) return;
		const previous = await pipelineMethods.getActivePipelineId();
		if (previous && audioStore.runningPipelineId !== previous) return;
		await invoke('hide_main_window');
	}

	private async saveBeforeExit(): Promise<void> {
		await pipelineStore.editorActions?.save();
		await pipelineStore.flushSaves();
		const snapshot = pipelineStore.editorActions?.getSnapshot();
		const runningId = audioStore.runningPipelineId;
		const running = runningId ? (snapshot?.id === runningId ? snapshot : await pipelineMethods.get(runningId)) : null;
		if (running && audioStore.isRunning) {
			const captured = new Map<string, { path: string; pluginId: string; state: string; previousState: string | null }>();
			for (const node of running.nodes) {
				if (node.kind !== 'plugin' || !node.data.path) continue;
				const { path, pluginId, state: previousState } = node.data as PluginNodeData;
				const state = await audioMethods.getPluginState(node.id, path, pluginId);
				if (state !== null) captured.set(node.id, { path, pluginId, state, previousState });
			}
			const applyStates = (p: Pipeline): Pipeline => ({
				...p,
				nodes: p.nodes.map((node) => {
					const capture = captured.get(node.id);
					if (
						node.kind !== 'plugin' ||
						!capture ||
						node.data.path !== capture.path ||
						node.data.pluginId !== capture.pluginId ||
						node.data.state !== capture.previousState
					)
						return node;
					return { ...node, data: { ...node.data, state: capture.state } };
				})
			});
			const editor = pipelineStore.editorActions;
			const latest = pipelineStore.editorActions?.getSnapshot();
			if (latest?.id === running.id) {
				for (const node of applyStates(latest).nodes) {
					const before = latest.nodes.find((n) => n.id === node.id);
					if (node.kind === 'plugin' && node.data.state !== before?.data.state) editor?.patchRuntimeNode(node.id, { state: node.data.state });
				}
			} else await pipelineStore.update(running.id, applyStates);
		}
		await pipelineStore.editorActions?.save();
		await pipelineStore.flushSaves();
		appSettings.persist();
	}

	private async handleAction(action: string): Promise<void> {
		if (this.quitting || (this.busy && action !== 'quit' && action !== 'stop')) return;
		this.actionCount += 1;
		this.busy = true;
		try {
			if (action === 'quit') {
				this.quitting = true;
				await audioStore.stopForExit(() => this.saveBeforeExit());
				await invoke('complete_desktop_exit');
			} else if (action === 'autostart') {
				await appSettings.setLaunchOnStartup(!appSettings.launchOnStartup);
			} else if (action === 'start-in-tray') {
				appSettings.startInTray = !appSettings.startInTray;
				appSettings.persist();
			} else if (action === 'stop') {
				await audioStore.deactivatePipeline();
			} else if (action.startsWith('pipeline:')) {
				const id = action.slice('pipeline:'.length);
				if (id === audioStore.runningPipelineId) {
					await audioStore.deactivatePipeline();
				} else if (!audioStore.isRunning) {
					await invoke('show_main_window');
					const snapshot = pipelineStore.editorActions?.getSnapshot();
					const pipeline = snapshot?.id === id ? snapshot : await pipelineMethods.get(id);
					if (!pipeline) throw new Error('Pipeline no longer exists');
					if (isFromFuture(pipeline)) throw new Error('This pipeline requires a newer version of Splitwave');
					await audioStore.activatePipeline(id, { nodes: pipeline.nodes, edges: pipeline.edges });
				}
			}
		} catch (error) {
			if (action === 'quit') {
				audioStore.shuttingDown = false;
				await invoke('cancel_desktop_exit');
			}
			await invoke('show_main_window');
			audioStore.reportError(error);
		} finally {
			this.actionCount -= 1;
			this.busy = this.actionCount > 0;
			if (action === 'quit') this.quitting = false;
			await this.sync().catch((error) => audioStore.reportError(error));
		}
	}

	destroy(): void {
		this.unlisten?.();
		this.ready = false;
	}
}

export const desktopStore = new DesktopStore();
