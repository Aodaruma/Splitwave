<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
	import { listen } from '@tauri-apps/api/event';
	import { audioStore } from '../stores.svelte';
	import { methods } from '../methods';
	import { pipelineStore } from '$lib/modules/pipeline/stores.svelte';
	import type { MuteNodeData, Pipeline } from '$lib/modules/pipeline/types';

	function current(): Pipeline | null {
		let editor: Pipeline | null = null;
		try {
			editor = pipelineStore.editorActions?.getSnapshot() ?? null;
		} catch {}
		if (!audioStore.runningPipelineId || editor?.id === audioStore.runningPipelineId) return editor ?? null;
		return pipelineStore.pipelines.find((p) => p.id === audioStore.runningPipelineId) ?? null;
	}
	let graph = $derived.by(() => {
		try {
			return current();
		} catch {
			return null;
		}
	});
	let receivers = $derived(JSON.stringify(graph?.nodes.filter((n) => n.kind === 'netReceiver').map((n) => [n.id, n.data.port]) ?? []));
	$effect(() => {
		for (const [id, port] of JSON.parse(receivers) as [string, number][])
			void methods.netReceiverListen(id, port).catch((error) => audioStore.reportError(error));
	});
	const registered = new Set<string>();
	let registration = Promise.resolve();
	let disposed = false;
	let keys = $derived([...new Set(graph?.nodes.filter((n) => n.kind === 'mute' && n.data.hotkey).map((n) => String(n.data.hotkey)) ?? [])].sort().join('\n'));
	$effect(() => {
		const wanted = new Set(keys ? keys.split('\n') : []);
		registration = registration
			.then(async () => {
				for (const key of registered)
					if (!wanted.has(key) || disposed) {
						await unregister(key);
						registered.delete(key);
					}
				if (disposed) return;
				for (const key of wanted)
					if (!registered.has(key)) {
						try {
							await register(key, (event) => {
								const p = untrack(current);
								for (const node of p?.nodes ?? []) {
									if (node.kind !== 'mute' || node.data.hotkey !== key) continue;
									const data = node.data as MuteNodeData;
									if (!data.pushToTalk && event.state !== 'Pressed') continue;
									const muted = data.pushToTalk ? event.state === 'Released' : !data.muted;
									if (muted === data.muted) continue;
									void audioStore.patchNode(p!.id, node.id, { muted }).catch((error) => audioStore.reportError(error));
									if (data.cueEnabled && data.cueDeviceId)
										void methods
											.playCue(data.cueDeviceId, muted, (data.cueVolume ?? 40) / 100, data.pushToTalk ?? false)
											.catch((error) => audioStore.reportError(error));
								}
							});
							registered.add(key);
							audioStore.hotkeyErrors[key] = '';
						} catch (error) {
							audioStore.hotkeyErrors[key] = String(error);
						}
					}
			})
			.catch((error) => audioStore.reportError(error));
	});
	$effect(() => {
		const running = audioStore.isRunning;
		const p = graph;
		if (running && p?.id === audioStore.runningPipelineId) {
			const apply = pipelineStore.editorActions?.pipelineId === p.id ? audioStore.syncLiveControls(p) : audioStore.restartPipeline(p);
			void apply.catch((error) => audioStore.reportError(error));
		}
	});
	$effect(() => {
		const id = audioStore.chooseFileNodeId;
		if (id)
			untrack(() => {
				audioStore.chooseFileNodeId = null;
				void audioStore.retryRecordingFile(id).catch((error) => audioStore.reportError(error));
			});
	});
	onMount(() => {
		const done = new Map<string, boolean>();
		const subscriptions = Promise.all([
			methods.onState(() => done.clear()),
			listen<{ nodeId: string; stopped: boolean }>('audio://audio_file_progress', ({ payload }) => {
				const p = current();
				if (!audioStore.isRunning || audioStore.shuttingDown || !p) {
					done.clear();
					return;
				}
				const node = p.nodes.find((n) => n.id === payload.nodeId);
				if (node?.kind === 'audioFile')
					void methods.setAudioFileLoop(node.id, Boolean(node.data.loopEnabled)).catch((error) => audioStore.reportError(error));
				done.set(payload.nodeId, payload.stopped);
				if (p.nodes.some((n) => ['microphone', 'systemAudio', 'appAudio', 'netReceiver', 'webRtcCollaborator'].includes(n.kind))) return;
				const files = p.nodes.filter((n) => n.kind === 'audioFile');
				if (payload.stopped && files.length && files.every((n) => done.get(n.id)))
					void audioStore.deactivatePipeline().catch((error) => audioStore.reportError(error));
			}),
			methods.onPluginEditorClosed((id) => {
				void audioStore.capturePluginState(id).catch((error) => audioStore.reportError(error));
			})
		]);
		return () => {
			disposed = true;
			void registration
				.then(async () => {
					for (const key of registered) await unregister(key);
				})
				.catch((error) => audioStore.reportError(error));
			void subscriptions.then((fns) => fns.forEach((fn) => fn()));
		};
	});
</script>
