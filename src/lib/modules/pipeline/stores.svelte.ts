import { methods } from './methods';
import type { NodeKind, Pipeline } from './types';
import type { GroupDocument } from './groups';

export type ClipboardNode = {
	kind: NodeKind | 'group';
	data: Record<string, unknown>;
	/** Offset from the copied group's top-left corner. */
	dx: number;
	dy: number;
	width?: number;
	height?: number;
};

/** Endpoints are indices into `ClipboardEntry.nodes`; ids are minted on paste. */
export type ClipboardEdge = {
	source: number;
	target: number;
	sourceHandle?: string;
	targetHandle?: string;
};

export type ClipboardEntry = {
	/** Top-left of the copied group in flow coordinates; paste offsets from here. */
	origin: { x: number; y: number };
	groupDocument?: GroupDocument;
	groupPaths?: Record<number, string[]>;
	nodes: ClipboardNode[];
	edges: ClipboardEdge[];
};

export type EditorActions = {
	pipelineId: string;
	addNode: (kind: NodeKind, position?: { x: number; y: number }) => void;
	addNodeWithData: (kind: NodeKind, data: Record<string, unknown>, position?: { x: number; y: number }) => void;
	getSnapshot: () => Pipeline | null;
	save: () => Promise<void>;
	patchRuntimeNode: (id: string, patch: Record<string, unknown>) => void;
	revertToSnapshot: (p: Pipeline) => void;
	undo: () => void;
	redo: () => void;
	copySelection: () => void;
	paste: () => void;
	selectAll: () => void;
	canUndo: () => boolean;
	canRedo: () => boolean;
};

export class PipelineStore {
	pipelines = $state<Pipeline[]>([]);
	editorActions = $state<EditorActions | null>(null);
	clipboard = $state<ClipboardEntry | null>(null);
	/** Wall-clock millis of the last successful auto-save. `0` before any. */
	lastSavedAt = $state<number>(0);
	private pendingSave: Promise<void> = Promise.resolve();
	private failedSaves = new Map<string, unknown>();

	async refresh(): Promise<void> {
		this.pipelines = await methods.list();
	}

	private async enqueueSave(id: string, write: () => Promise<Pipeline>): Promise<Pipeline> {
		const save = this.pendingSave.then(async () => {
			const saved = await write();
			this.failedSaves.delete(id);
			this.lastSavedAt = Date.now();
			return saved;
		});
		this.pendingSave = save.then(
			() => {},
			(error) => {
				this.failedSaves.set(id, error);
			}
		);
		const saved = await save;
		await this.refresh();
		return saved;
	}

	save(p: Pipeline): Promise<Pipeline> {
		const snapshot = $state.snapshot(p);
		return this.enqueueSave(p.id, () => methods.save(snapshot));
	}

	update(id: string, update: (p: Pipeline) => Pipeline): Promise<Pipeline> {
		return this.enqueueSave(id, async () => {
			const latest = await methods.get(id);
			if (!latest) throw new Error('Pipeline no longer exists');
			return methods.save(update(latest));
		});
	}

	async flushSaves(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.pendingSave;
			await pending;
		} while (pending !== this.pendingSave);
		if (this.failedSaves.size) throw this.failedSaves.values().next().value;
	}

	async remove(id: string): Promise<void> {
		await methods.remove(id);
		this.failedSaves.delete(id);
		await this.refresh();
	}
}

export const pipelineStore = new PipelineStore();
