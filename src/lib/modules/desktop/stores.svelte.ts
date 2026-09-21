import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { audioStore } from '$lib/modules/audio/stores.svelte';
import { methods as audioMethods } from '$lib/modules/audio/methods';
import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
import { methods as pipelineMethods } from '$lib/modules/pipeline/methods';
import { isFromFuture } from '$lib/modules/pipeline/migrations';
import { appSettings } from '$lib/modules/settings/stores.svelte';

class DesktopStore {
	ready = $state(false);
	busy = $state(false);
	quitting = $state(false);
	private unlisten?: UnlistenFn;
	private syncQueue = Promise.resolve();

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
		const editor = pipelineStore.editorActions;
		const snapshot = editor?.getSnapshot();
		const runningId = audioStore.runningPipelineId;
		const running = runningId ? (snapshot?.id === runningId ? snapshot : await pipelineMethods.get(runningId)) : null;
		if (running && audioStore.isRunning) {
			for (const node of running.nodes) {
				if (node.kind !== 'plugin' || !node.data.path) continue;
				const state = await audioMethods.getPluginState(node.id);
				if (state !== null) node.data = { ...node.data, state };
			}
			if (running.id === snapshot?.id) editor?.revertToSnapshot(running);
			await pipelineStore.save(running);
		}
		if (snapshot && (snapshot.id !== running?.id || !audioStore.isRunning)) await pipelineStore.save(snapshot);
		appSettings.persist();
	}

	private async handleAction(action: string): Promise<void> {
		if (this.busy) {
			if (action === 'quit' && !this.quitting) await invoke('cancel_desktop_exit');
			return;
		}
		this.busy = true;
		try {
			if (action === 'quit') {
				this.quitting = true;
				audioStore.shuttingDown = true;
				await this.saveBeforeExit();
				await audioStore.stopForExit();
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
			audioStore.shuttingDown = false;
			await invoke('cancel_desktop_exit');
			await invoke('show_main_window');
			audioStore.reportError(error);
		} finally {
			this.busy = false;
			this.quitting = false;
			await this.sync().catch((error) => audioStore.reportError(error));
		}
	}

	destroy(): void {
		this.unlisten?.();
		this.ready = false;
	}
}

export const desktopStore = new DesktopStore();
