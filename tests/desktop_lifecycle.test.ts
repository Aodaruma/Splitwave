import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { plugin } from 'bun';
import { compileModule } from 'svelte/compiler';
import type { AudioStateEvent, StartPipelinePayload } from '../src/lib/modules/audio/types';
import type { Pipeline, PipelineNode } from '../src/lib/modules/pipeline/types';
import type { EditorActions } from '../src/lib/modules/pipeline/stores.svelte';

// Compile the real stores with Svelte's server transform: no DOM or audio devices.
await plugin({
	name: 'svelte-store-tests',
	setup(build) {
		build.onLoad({ filter: /stores\.svelte\.ts$/ }, async ({ path }) => ({
			contents: compileModule(new Bun.Transpiler({ loader: 'ts' }).transformSync(await Bun.file(path).text()), { filename: path, generate: 'server' }).js
				.code,
			loader: 'js'
		}));
	}
});

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function until(predicate: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error('Expected asynchronous operation did not reach its checkpoint');
}

const stored = new Map<string, Pipeline>();
let activeId: string | null = null;
let onState: (event: AudioStateEvent) => void = () => {};
let onInputError: (event: { nodeId: string; error: string }) => void = () => {};
const backend = {
	startPipeline: mock(async (_graph: StartPipelinePayload) => {}),
	stopPipeline: mock(async () => {}),
	reconcilePipeline: mock(async (_graph: StartPipelinePayload) => {}),
	getPluginState: mock(async (_id: string, _path: string, _pluginId: string): Promise<string | null> => null),
	listInputDevices: mock(async () => []),
	listOutputDevices: mock(async () => []),
	listAudioApplications: mock(async () => []),
	isPipelineRunning: async () => false,
	pathExists: async () => true,
	onState: async (cb: typeof onState) => {
		onState = cb;
		return () => {};
	},
	onInputError: async (cb: typeof onInputError) => {
		onInputError = cb;
		return () => {};
	},
	onSpeakerError: async () => () => {}
};
const persistence = {
	get: mock(async (id: string) => structuredClone(stored.get(id) ?? null)),
	list: async () => [...stored.values()],
	save: mock(async (p: Pipeline) => {
		stored.set(p.id, structuredClone(p));
	}),
	getActivePipelineId: mock(async () => activeId),
	setActivePipelineId: mock(async (id: string | null) => {
		activeId = id;
	})
};
const settings = { keepRunningOnDisconnect: false, persist: mock(() => {}), syncLaunchOnStartup: async () => {} };
const reportError = mock((_error: string) => {});
const chooseFile = mock(async (): Promise<string | null> => 'recording.wav');
let desktopAction: (event: { payload: string }) => void = () => {};
const invoke = mock(async (_command: string) => {});
mock.module('$app/environment', () => ({ browser: false }));
mock.module('../src/lib/modules/audio/methods', () => ({ methods: backend }));
mock.module('../src/lib/modules/pipeline/methods', () => ({ methods: persistence }));
mock.module('../src/lib/modules/settings/stores.svelte', () => ({ appSettings: settings }));
mock.module('../src/lib/modules/error', () => ({ errorStore: { hadPreviousCrash: false } }));
mock.module('svelte-french-toast', () => ({ default: { error: reportError } }));
mock.module('@tauri-apps/plugin-dialog', () => ({ open: chooseFile, save: chooseFile }));
mock.module('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
mock.module('@tauri-apps/api/event', () => ({
	listen: async (_name: string, cb: typeof desktopAction) => {
		desktopAction = cb;
		return () => {};
	}
}));

const { AudioStore, audioStore } = await import('../src/lib/modules/audio/stores.svelte');
const { PipelineStore, pipelineStore } = await import('../src/lib/modules/pipeline/stores.svelte');
const { desktopStore } = await import('../src/lib/modules/desktop/stores.svelte');
const emptyGraph: StartPipelinePayload = { nodes: [], edges: [] };
const pipeline = (id: string, nodes: PipelineNode[] = []): Pipeline => ({ id, name: id, nodes, edges: [], createdAt: 1, updatedAt: 1, version: 2 });
const pluginNode = (): PipelineNode<'plugin'> => ({
	id: 'plugin',
	kind: 'plugin',
	position: { x: 0, y: 0 },
	data: { format: 'clap', path: 'bundle', pluginId: 'one', state: 'old', bypassed: false }
});
const recordingNode = (): PipelineNode<'fileRecording'> => ({
	id: 'recording',
	kind: 'fileRecording',
	position: { x: 0, y: 0 },
	data: { filePath: null, format: { kind: 'wav', bitDepth: 'f32' }, mode: 'new', channels: 2, sampleRate: 48000, waveformHidden: false }
});
function setEditor(initial: Pipeline) {
	let snapshot = initial;
	pipelineStore.editorActions = {
		getSnapshot: () => structuredClone(snapshot),
		revertToSnapshot: (p: Pipeline) => {
			snapshot = p;
		}
	} as EditorActions;
	return (p: Pipeline) => {
		snapshot = p;
	};
}
let audio: InstanceType<typeof AudioStore>;
beforeEach(() => {
	stored.clear();
	activeId = null;
	settings.keepRunningOnDisconnect = false;
	pipelineStore.editorActions = null;
	backend.startPipeline.mockReset().mockImplementation(async () => {});
	backend.stopPipeline.mockReset().mockImplementation(async () => {});
	backend.reconcilePipeline.mockReset().mockImplementation(async () => {});
	backend.getPluginState.mockReset().mockImplementation(async () => null);
	backend.listInputDevices.mockReset().mockImplementation(async () => []);
	persistence.get.mockReset().mockImplementation(async (id) => structuredClone(stored.get(id) ?? null));
	persistence.save.mockReset().mockImplementation(async (p) => {
		stored.set(p.id, structuredClone(p));
	});
	persistence.getActivePipelineId.mockReset().mockImplementation(async () => activeId);
	persistence.setActivePipelineId.mockClear();
	chooseFile.mockReset().mockImplementation(async () => 'recording.wav');
	reportError.mockClear();
	invoke.mockClear();
	audio = new AudioStore();
});
afterEach(async () => {
	backend.stopPipeline.mockImplementation(async () => {});
	await audio.deactivatePipeline();
	audio.destroy();
	audioStore.shuttingDown = false;
	await audioStore.deactivatePipeline();
	desktopStore.destroy();
});

describe('AudioStore operation coordination', () => {
	it('coalesces overlapping activations without stopping the first successful start', async () => {
		const start = deferred();
		backend.startPipeline.mockImplementationOnce(() => start.promise);
		const first = audio.activatePipeline('first', emptyGraph);
		await until(() => backend.startPipeline.mock.calls.length === 1);
		const second = audio.activatePipeline('second', emptyGraph);
		start.resolve();
		await Promise.all([first, second]);
		expect(backend.startPipeline).toHaveBeenCalledTimes(1);
		expect(backend.stopPipeline).not.toHaveBeenCalled();
		expect(audio.runningPipelineId).toBe('first');
		expect(activeId).toBe('first');
	});

	it('coordinates launch restore with a manual activation', async () => {
		activeId = 'restored';
		stored.set('restored', pipeline('restored'));
		const read = deferred<string | null>();
		persistence.getActivePipelineId.mockImplementationOnce(() => read.promise);
		const restore = audio.autoActivateOnLaunch();
		await until(() => persistence.getActivePipelineId.mock.calls.length === 1);
		const manual = audio.activatePipeline('manual', emptyGraph);
		read.resolve('restored');
		await Promise.all([restore, manual]);
		expect(backend.startPipeline).toHaveBeenCalledTimes(1);
		expect(audio.runningPipelineId).toBe('restored');
		expect(backend.stopPipeline).not.toHaveBeenCalled();
	});

	it('waits for a pending start before stopping and cancels earlier queued starts', async () => {
		const start = deferred();
		backend.startPipeline.mockImplementationOnce(() => start.promise);
		const first = audio.activatePipeline('first', emptyGraph);
		await until(() => backend.startPipeline.mock.calls.length === 1);
		const second = audio.activatePipeline('second', emptyGraph);
		const stop = audio.deactivatePipeline();
		expect(backend.stopPipeline).not.toHaveBeenCalled();
		start.resolve();
		await Promise.all([first, second, stop]);
		expect(backend.startPipeline).toHaveBeenCalledTimes(1);
		expect(backend.stopPipeline).toHaveBeenCalledTimes(1);
		expect(audio.isRunning).toBe(false);
		expect(activeId).toBeNull();
		await audio.activatePipeline('third', emptyGraph);
		expect(audio.runningPipelineId).toBe('third');
	});

	it('cancels launch restore before it sends a start', async () => {
		const read = deferred<string | null>();
		stored.set('restored', pipeline('restored'));
		persistence.getActivePipelineId.mockImplementationOnce(() => read.promise);
		const restore = audio.autoActivateOnLaunch();
		await until(() => persistence.getActivePipelineId.mock.calls.length === 1);
		const stop = audio.deactivatePipeline();
		read.resolve('restored');
		await Promise.all([restore, stop]);
		expect(backend.startPipeline).not.toHaveBeenCalled();
	});

	it('takes the exit snapshot after start settles and keeps the active id for next launch', async () => {
		const start = deferred();
		backend.startPipeline.mockImplementationOnce(() => start.promise);
		const activation = audio.activatePipeline('running', emptyGraph);
		await until(() => backend.startPipeline.mock.calls.length === 1);
		const save = mock(async () => {
			expect(audio.runningPipelineId).toBe('running');
			expect(audio.isRunning).toBe(true);
		});
		const exit = audio.stopForExit(save);
		const late = audio.activatePipeline('too late', emptyGraph);
		start.resolve();
		await Promise.all([activation, exit, late]);
		expect(save).toHaveBeenCalledTimes(1);
		expect(backend.stopPipeline).toHaveBeenCalledTimes(1);
		expect(activeId).toBe('running');
	});

	it('retries choose-file inside the operation without recursively waiting on its queue', async () => {
		const graph = { nodes: [recordingNode()], edges: [] };
		stored.set('recording', pipeline('recording', graph.nodes));
		backend.startPipeline.mockRejectedValueOnce(new Error('choose-file (node recording)'));
		await audio.activatePipeline('recording', graph);
		expect(backend.startPipeline).toHaveBeenCalledTimes(2);
		expect(backend.startPipeline.mock.calls[1][0].nodes[0].data.filePath).toBe('recording.wav');
		expect(stored.get('recording')!.nodes[0].data.filePath).toBe('recording.wav');
	});

	it('does not retry after Stop while a recording dialog is open', async () => {
		const dialog = deferred<string | null>();
		chooseFile.mockImplementationOnce(() => dialog.promise);
		backend.startPipeline.mockRejectedValueOnce(new Error('choose-file (node recording)'));
		const activation = audio.activatePipeline('recording', { nodes: [recordingNode()], edges: [] });
		await until(() => chooseFile.mock.calls.length === 1);
		const stop = audio.deactivatePipeline();
		dialog.resolve('late.wav');
		await Promise.all([activation, stop]);
		expect(backend.startPipeline).toHaveBeenCalledTimes(1);
		expect(persistence.save).not.toHaveBeenCalled();
	});

	it('invalidates an editor-owned recording retry after Stop', async () => {
		setEditor(pipeline('editor', [recordingNode()]));
		backend.startPipeline.mockRejectedValueOnce(new Error('choose-file (node recording)'));
		await audio.activatePipeline('editor', emptyGraph);
		const retry = audio.takeRecordingRetry();
		expect(retry).not.toBeNull();
		await audio.deactivatePipeline();
		await retry!(emptyGraph);
		expect(backend.startPipeline).toHaveBeenCalledTimes(1);
	});

	it('recovers the operation queue after a failed start without issuing Stop', async () => {
		backend.startPipeline.mockRejectedValueOnce(new Error('already running'));
		await expect(audio.activatePipeline('first', emptyGraph)).rejects.toThrow('already running');
		expect(backend.stopPipeline).not.toHaveBeenCalled();
		await audio.activatePipeline('second', emptyGraph);
		expect(audio.runningPipelineId).toBe('second');
	});

	it('cancels a reconcile fallback start when Stop arrives during reconcile', async () => {
		await audio.activatePipeline('first', emptyGraph);
		const reconcile = deferred();
		backend.reconcilePipeline.mockImplementationOnce(() => reconcile.promise);
		const restart = audio.restartPipeline(emptyGraph);
		await until(() => backend.reconcilePipeline.mock.calls.length === 1);
		const stop = audio.deactivatePipeline();
		reconcile.reject(new Error('not running'));
		await Promise.all([restart, stop]);
		expect(backend.startPipeline).toHaveBeenCalledTimes(1);
		expect(backend.stopPipeline).toHaveBeenCalledTimes(1);
	});

	it('cancels an in-flight reconnect probe on exit', async () => {
		settings.keepRunningOnDisconnect = true;
		await audio.activatePipeline('first', emptyGraph);
		audio.pendingNodeIds.add('missing');
		const probe = deferred<[]>();
		backend.listInputDevices.mockClear().mockImplementationOnce(() => probe.promise);
		const reconnect = audio['tryReconnectPending']();
		await until(() => backend.listInputDevices.mock.calls.length === 1);
		const exit = audio.stopForExit();
		probe.resolve([]);
		await Promise.all([reconnect, exit]);
		expect(backend.reconcilePipeline).not.toHaveBeenCalled();
		expect(backend.startPipeline).toHaveBeenCalledTimes(1);
	});

	it('serializes device recovery and stop', async () => {
		await audio.init();
		await audio.activatePipeline('first', emptyGraph);
		settings.keepRunningOnDisconnect = true;
		const finalize = deferred();
		backend.stopPipeline.mockImplementationOnce(() => finalize.promise);
		onInputError({ nodeId: 'missing', error: 'disconnected' });
		await until(() => backend.stopPipeline.mock.calls.length === 1);
		const stop = audio.deactivatePipeline();
		expect(backend.stopPipeline).toHaveBeenCalledTimes(1);
		finalize.resolve();
		await stop;
		expect(backend.stopPipeline).toHaveBeenCalledTimes(2);
		expect(audio.isRunning).toBe(false);
	});

	it('propagates save and finalize failures from exit', async () => {
		await audio.activatePipeline('first', emptyGraph);
		await expect(
			audio.stopForExit(async () => {
				throw new Error('save failed');
			})
		).rejects.toThrow('save failed');
		expect(backend.stopPipeline).not.toHaveBeenCalled();
		expect(audio.isRunning).toBe(true);
		backend.stopPipeline.mockRejectedValueOnce(new Error('finalize failed'));
		await expect(audio.stopForExit()).rejects.toThrow('finalize failed');
	});
});

describe('exit persistence', () => {
	it('flushes writes added while waiting and preserves failures until that pipeline is saved', async () => {
		const store = new PipelineStore();
		const first = deferred();
		persistence.save.mockImplementationOnce(() => first.promise);
		const save = store.save(pipeline('a'));
		const flush = store.flushSaves();
		const next = store.save(pipeline('b'));
		const saveError = save.catch((error) => error);
		const flushError = flush.catch((error) => error);
		first.reject(new Error('disk full'));
		expect((await saveError).message).toBe('disk full');
		expect((await flushError).message).toBe('disk full');
		await next;
		await store.save(pipeline('a'));
		await store.flushSaves();
	});

	it('flushes offscreen saves before reading and merges captures into edits made during capture', async () => {
		await desktopStore.init();
		stored.set('running', pipeline('running', [pluginNode()]));
		await audioStore.activatePipeline('running', emptyGraph);
		const pending = deferred();
		persistence.save.mockImplementationOnce(async (p) => {
			await pending.promise;
			stored.set(p.id, structuredClone(p));
		});
		const edited = { ...pipeline('running', [pluginNode()]), name: 'latest', updatedAt: 2 };
		const saving = pipelineStore.save(edited);
		const capture = deferred<string | null>();
		backend.getPluginState.mockImplementationOnce(() => capture.promise);
		desktopAction({ payload: 'quit' });
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(persistence.get).not.toHaveBeenCalled();
		pending.resolve();
		await saving;
		await until(() => backend.getPluginState.mock.calls.length === 1);
		expect(backend.getPluginState).toHaveBeenCalledWith('plugin', 'bundle', 'one');
		await pipelineStore.save({ ...edited, name: 'edited during capture', updatedAt: 3 });
		capture.resolve('captured');
		await until(() => !desktopStore.busy);
		expect(stored.get('running')!.name).toBe('edited during capture');
		expect(stored.get('running')!.nodes[0].data.state).toBe('captured');
		expect(invoke).toHaveBeenCalledWith('complete_desktop_exit');
	});

	it('does not apply a captured state after the editor remounts with another pluginId in the same bundle', async () => {
		await desktopStore.init();
		const original = pipeline('running', [pluginNode()]);
		setEditor(original);
		await audioStore.activatePipeline('running', emptyGraph);
		const capture = deferred<string | null>();
		backend.getPluginState.mockImplementationOnce(() => capture.promise);
		desktopAction({ payload: 'quit' });
		await until(() => backend.getPluginState.mock.calls.length === 1);
		const replacement = pluginNode();
		replacement.data.pluginId = 'two';
		replacement.data.state = null;
		setEditor({ ...original, name: 'new edit', nodes: [replacement] });
		capture.resolve('old plugin state');
		await until(() => !desktopStore.busy);
		expect(stored.get('running')!.name).toBe('new edit');
		expect(stored.get('running')!.nodes[0].data.state).toBeNull();
	});

	it('reports a late Stop failure and cancels exit on a non-editor screen', async () => {
		await desktopStore.init();
		const finalize = deferred();
		backend.stopPipeline.mockImplementationOnce(() => finalize.promise);
		desktopAction({ payload: 'quit' });
		await until(() => backend.stopPipeline.mock.calls.length === 1);
		expect(invoke.mock.calls.some(([command]) => command === 'complete_desktop_exit')).toBe(false);
		finalize.reject(new Error('recording finalize failed'));
		await until(() => !desktopStore.busy);
		expect(invoke).toHaveBeenCalledWith('cancel_desktop_exit');
		expect(invoke).toHaveBeenCalledWith('show_main_window');
		expect(reportError).toHaveBeenCalledWith('recording finalize failed');
		expect(audioStore.shuttingDown).toBe(false);
	});
});

describe('overlapping desktop stop and exit', () => {
	it('accepts quit while a tray activation is pending', async () => {
		await desktopStore.init();
		stored.set('running', pipeline('running'));
		const start = deferred();
		backend.startPipeline.mockImplementationOnce(() => start.promise);
		desktopAction({ payload: 'pipeline:running' });
		await until(() => backend.startPipeline.mock.calls.length === 1);
		desktopAction({ payload: 'quit' });
		expect(desktopStore.quitting).toBe(true);
		start.resolve();
		await until(() => !desktopStore.busy);
		expect(invoke).toHaveBeenCalledWith('complete_desktop_exit');
		expect(backend.stopPipeline).toHaveBeenCalledTimes(1);
		expect(activeId).toBe('running');
	});

	it('shares an explicit pending Stop and propagates its failure to exit', async () => {
		await audio.activatePipeline('running', emptyGraph);
		const finalize = deferred();
		backend.stopPipeline.mockImplementationOnce(() => finalize.promise);
		const first = audio.deactivatePipeline().catch((e) => e);
		await until(() => backend.stopPipeline.mock.calls.length === 1);
		const second = audio.deactivatePipeline().catch((e) => e);
		const exit = audio.stopForExit().catch((e) => e);
		const error = new Error('late finalize failure');
		finalize.reject(error);
		expect(await first).toBe(error);
		expect(await second).toBe(error);
		expect(await exit).toBe(error);
		expect(backend.stopPipeline).toHaveBeenCalledTimes(1);
	});
});

it('cancels desktop exit when a queued pipeline save fails', async () => {
	await desktopStore.init();
	const error = new Error('pipeline save failed');
	persistence.save.mockRejectedValueOnce(error);
	const saving = pipelineStore.save(pipeline('unsaved')).catch((e) => e);
	desktopAction({ payload: 'quit' });
	await until(() => !desktopStore.busy);
	expect(await saving).toBe(error);
	expect(invoke).toHaveBeenCalledWith('cancel_desktop_exit');
	expect(reportError).toHaveBeenCalledWith('pipeline save failed');
	expect(backend.stopPipeline).not.toHaveBeenCalled();
	expect(invoke.mock.calls.some(([command]) => command === 'complete_desktop_exit')).toBe(false);
	await pipelineStore.save(pipeline('unsaved'));
});
