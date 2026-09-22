import { PIPELINE_VERSION } from './version';
import type { Pipeline } from './types';
import {
	assertReusableInstance,
	capturePluginStates,
	copyInstanceState,
	definition,
	dependencies,
	documentFor,
	expand,
	materialize,
	type GroupDefinition,
	type GroupDocument
} from './groups';

export interface GroupLibrary {
	version: 4;
	pipelines: Record<string, Pipeline>;
	definitions: Record<string, GroupDefinition>;
}

export function findGroupInstance(library: GroupLibrary, id: string): { doc: GroupDocument; path: string[] } | undefined {
	for (const p of Object.values(library.pipelines)) {
		if ((p.version ?? 0) > PIPELINE_VERSION) continue;
		const doc = documentFor(p);
		function visit(d: GroupDefinition, path: string[]): string[] | undefined {
			if (d.id === id) return path;
			for (const n of d.nodes)
				if (n.kind === 'group') {
					const found = visit(definition(doc, n.data.definition), [...path, n.id]);
					if (found) return found;
				}
		}
		const path = visit(definition(doc, doc.root), []);
		if (path) return { doc, path };
	}
}

export function definitionContent(d: GroupDefinition): string {
	const { revision: _, ...content } = d;
	return JSON.stringify(content);
}

/** Replacing a child in a shared parent creates new runtime occurrences in every pipeline. */
export function inheritReplacementStates(source: GroupLibrary, target: GroupDocument, previous: Record<string, GroupDefinition>) {
	function visit(d: GroupDefinition, path: string[]) {
		for (const n of d.nodes) {
			if (n.kind !== 'group') continue;
			const old = previous[d.id]?.nodes.find((old) => old.id === n.id);
			const nextPath = [...path, n.id];
			if (old?.kind === 'group' && old.data.definition !== n.data.definition && JSON.stringify(old.identity) !== JSON.stringify(n.identity)) {
				const instance = findGroupInstance(source, n.data.definition);
				if (instance) copyInstanceState(instance.doc, instance.path, target, nextPath);
			}
			visit(definition(target, n.data.definition), nextPath);
		}
	}
	visit(definition(target, target.root), []);
}

export function assertFresh(p: Pipeline, definitions: Record<string, GroupDefinition>) {
	if (!p.groups) return;
	for (const d of Object.values(dependencies(p.groups))) {
		const current = definitions[d.id];
		if (current && current.revision !== d.revision && definitionContent(current) !== definitionContent(d)) {
			throw new Error(`“${d.name}” was edited elsewhere. Reload the pipeline before editing or restoring it; linked groups were not overwritten.`);
		}
	}
}

/** One value contains definitions and all affected wiring, so a failed write cannot split them. */
export function saveToLibrary(library: GroupLibrary, pipeline: Pipeline): GroupLibrary {
	const next = structuredClone(library);
	const p = capturePluginStates(pipeline);
	const doc = documentFor(p);
	definition(doc, doc.root).name = p.name;
	assertFresh({ ...p, groups: doc }, next.definitions);
	for (const d of Object.values(dependencies(doc))) {
		const current = next.definitions[d.id];
		const changed = !current || definitionContent(current) !== definitionContent(d);
		next.definitions[d.id] = { ...structuredClone(d), revision: changed ? (current?.revision ?? 0) + 1 : current.revision };
	}
	next.pipelines[p.id] = { ...p, groups: doc };
	for (const root of Object.keys(next.definitions)) expand({ root, definitions: next.definitions, runtimeIds: {}, pluginStates: {} });
	for (const [id, saved] of Object.entries(next.pipelines)) {
		if ((saved.version ?? 0) > PIPELINE_VERSION) continue;
		const document = documentFor(saved);
		const previous = document.definitions;
		document.definitions = next.definitions;
		inheritReplacementStates(library, document, previous);
		next.pipelines[id] = materialize({ ...saved, name: definition(document, document.root).name }, document);
	}
	validateSharedRoutes(next);
	return next;
}

export function validateSharedRoutes(library: GroupLibrary) {
	const checked = new Set<string>();
	for (const p of Object.values(library.pipelines))
		if (p.groups) {
			for (const d of Object.values(p.groups.definitions)) {
				if (checked.has(d.id) || !d.nodes.some((n) => n.kind === 'webRtcCollaborator')) continue;
				checked.add(d.id);
				if (usageCount(library, d.id) > 1) assertReusableInstance(p.groups, d.id);
			}
		}
}

export function usageCount(library: GroupLibrary, id: string): number {
	let count = 0;
	for (const p of Object.values(library.pipelines)) {
		if ((p.version ?? 0) > PIPELINE_VERSION) continue;
		const doc = p.groups ?? documentFor(p);
		if (doc.root === id) count++;
		function visit(d: GroupDefinition) {
			for (const n of d.nodes)
				if (n.kind === 'group') {
					if (n.data.definition === id) count++;
					visit(definition(doc, n.data.definition));
				}
		}
		visit(definition(doc, doc.root));
	}
	return count;
}
