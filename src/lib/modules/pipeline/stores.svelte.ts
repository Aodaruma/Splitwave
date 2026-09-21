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

class PipelineStore {
	pipelines = $state<Pipeline[]>([]);
	editorActions = $state<EditorActions | null>(null);
	clipboard = $state<ClipboardEntry | null>(null);
	/** Wall-clock millis of the last successful auto-save. `0` before any. */
	lastSavedAt = $state<number>(0);
	private pendingSave: Promise<void> = Promise.resolve();

	async refresh(): Promise<void> {
		this.pipelines = await methods.list();
	}

	async save(p: Pipeline): Promise<Pipeline> {
		p = $state.snapshot(p);
		const save = this.pendingSave.then(() => methods.save(p));
		this.pendingSave = save.then(
			() => {},
			() => {}
		);
		const saved = await save;
		this.lastSavedAt = Date.now();
		await this.refresh();
		return saved;
	}

	async remove(id: string): Promise<void> {
		await methods.remove(id);
		await this.refresh();
	}
}

export const pipelineStore = new PipelineStore();
