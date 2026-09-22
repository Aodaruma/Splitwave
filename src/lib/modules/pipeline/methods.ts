import { LazyStore } from '@tauri-apps/plugin-store';
import type { Pipeline } from './types';
import { saveToLibrary, type GroupLibrary } from './group_library';
import { documentFor, materialize } from './groups';
import { isFromFuture, migrate } from './migrations';
import { pruneDanglingEdges } from './sanitize';
import { appSettings } from '$lib/modules/settings/stores.svelte';

const STORE_FILE = 'pipelines.json';
const KEY_PREFIX = 'pipeline:';
const SNAPSHOT_KEY_PREFIX = 'snapshots:';
const ACTIVE_PIPELINE_KEY = 'activePipelineId';
const store = new LazyStore(STORE_FILE, { autoSave: false, defaults: {} });
const LIBRARY_KEY = 'groupLibrary';
let writes: Promise<unknown> = Promise.resolve();

async function library(): Promise<GroupLibrary> {
	const current = await store.get<Omit<GroupLibrary, 'version'> & { version: number }>(LIBRARY_KEY);
	if (current) {
		if (current.version !== 3 && current.version !== 4) throw new Error('This group library requires a newer version of Splitwave');
		return { ...current, version: 4 };
	}
	const initial: GroupLibrary = { version: 4, pipelines: {}, definitions: {} };
	for (const [key, value] of await store.entries<Pipeline>()) {
		if (!key.startsWith(KEY_PREFIX)) continue;
		if (isFromFuture(value)) {
			initial.pipelines[value.id] = value;
			continue;
		}
		const p = materialize(pruneDanglingEdges(migrate(value)));
		initial.pipelines[p.id] = p;
		Object.assign(initial.definitions, p.groups!.definitions);
	}
	return initial;
}

function transaction<T>(operation: () => Promise<T>): Promise<T> {
	const result = writes.then(operation);
	writes = result.catch(() => {});
	return result;
}

async function writeLibrary(next: GroupLibrary) {
	const previous = await store.get<GroupLibrary>(LIBRARY_KEY);
	const legacy = (await store.entries<Pipeline>()).filter(([key]) => key.startsWith(KEY_PREFIX));
	try {
		await store.set(LIBRARY_KEY, next);
		// Older builds must hit their version gate instead of loading a stale v2 copy.
		for (const [id, p] of Object.entries(next.pipelines)) await store.set(KEY_PREFIX + id, p);
		for (const [key] of legacy) if (!next.pipelines[key.slice(KEY_PREFIX.length)]) await store.delete(key);
		await store.save();
	} catch (error) {
		if (previous) await store.set(LIBRARY_KEY, previous);
		else await store.delete(LIBRARY_KEY);
		for (const id of Object.keys(next.pipelines)) await store.delete(KEY_PREFIX + id);
		for (const [key, p] of legacy) await store.set(key, p);
		throw error;
	}
}

export interface Snapshot {
	takenAt: number;
	pipeline: Pipeline;
}

export const methods = {
	async library(): Promise<GroupLibrary> {
		await writes;
		return library();
	},
	async list(): Promise<Pipeline[]> {
		await writes;
		return Object.values((await library()).pipelines).sort((a, b) => b.updatedAt - a.updatedAt);
	},

	/** Migrates on read; the result is only persisted once the pipeline is saved,
	 * so opening a v0 pipeline in a build that crashes leaves the original intact. */
	async get(id: string): Promise<Pipeline | null> {
		await writes;
		const stored = (await library()).pipelines[id];
		if (!stored) return null;
		return isFromFuture(stored) ? stored : materialize(stored);
	},

	async save(p: Pipeline): Promise<Pipeline> {
		return transaction(async () => {
			if (isFromFuture(p)) throw new Error('This pipeline requires a newer version of Splitwave');
			const next = saveToLibrary(await library(), p.groups ? p : pruneDanglingEdges(migrate(p)));
			await writeLibrary(next);
			return next.pipelines[p.id];
		});
	},

	async remove(id: string): Promise<void> {
		return transaction(async () => {
			const next = await library();
			const root = next.pipelines[id] ? documentFor(next.pipelines[id]).root : null;
			if (root && Object.values(next.definitions).some((d) => d.nodes.some((n) => n.kind === 'group' && n.data.definition === root))) {
				throw new Error('This pipeline is used by a reusable group. Make its references independent before deleting it.');
			}
			delete next.pipelines[id];
			await writeLibrary(next);
			await store.delete(SNAPSHOT_KEY_PREFIX + id);
			await store.save();
		});
	},

	async getActivePipelineId(): Promise<string | null> {
		return (await store.get<string>(ACTIVE_PIPELINE_KEY)) ?? null;
	},

	async setActivePipelineId(id: string | null): Promise<void> {
		return transaction(async () => {
			if (id === null) {
				await store.delete(ACTIVE_PIPELINE_KEY);
			} else {
				await store.set(ACTIVE_PIPELINE_KEY, id);
			}
			await store.save();
		});
	},

	async listSnapshots(id: string): Promise<Snapshot[]> {
		return (await store.get<Snapshot[]>(SNAPSHOT_KEY_PREFIX + id)) ?? [];
	},

	async addSnapshot(p: Pipeline): Promise<void> {
		return transaction(async () => {
			const key = SNAPSHOT_KEY_PREFIX + p.id;
			const existing = (await store.get<Snapshot[]>(key)) ?? [];
			existing.push({ takenAt: Date.now(), pipeline: p });
			// Ring-buffer behaviour -- drop oldest.
			const cap = appSettings.maxSnapshots;
			if (existing.length > cap) {
				existing.splice(0, existing.length - cap);
			}
			await store.set(key, existing);
			await store.save();
		});
	}
};
