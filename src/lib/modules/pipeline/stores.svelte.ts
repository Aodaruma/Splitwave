import { methods } from './methods';
import type { NodeKind, Pipeline } from './types';

export type ClipboardNode = {
	kind: NodeKind;
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
	nodes: ClipboardNode[];
	edges: ClipboardEdge[];
};

export type EditorActions = {
	addNode: (kind: NodeKind, position?: { x: number; y: number }) => void;
	addNodeWithData: (kind: NodeKind, data: Record<string, unknown>, position?: { x: number; y: number }) => void;
	getSnapshot: () => Pipeline | null;
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

	private async enqueueSave(id: string, write: () => Promise<void>): Promise<void> {
		const save = this.pendingSave.then(async () => {
			await write();
			this.failedSaves.delete(id);
			this.lastSavedAt = Date.now();
		});
		this.pendingSave = save.catch((error) => {
			this.failedSaves.set(id, error);
		});
		await save;
		await this.refresh();
	}

	save(p: Pipeline): Promise<void> {
		return this.enqueueSave(p.id, () => methods.save(p));
	}

	update(id: string, update: (p: Pipeline) => Pipeline): Promise<void> {
		return this.enqueueSave(id, async () => {
			const latest = await methods.get(id);
			if (!latest) throw new Error('Pipeline no longer exists');
			await methods.save(update(latest));
		});
	}

	async flushSaves(): Promise<void> {
		let pending: Promise<void>;
		do {
			pending = this.pendingSave;
			await pending;
		} while (pending !== this.pendingSave);
		if (this.failedSaves.size > 0) throw this.failedSaves.values().next().value;
	}

	async remove(id: string): Promise<void> {
		await methods.remove(id);
		this.failedSaves.delete(id);
		await this.refresh();
	}
}

export const pipelineStore = new PipelineStore();
