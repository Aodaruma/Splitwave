import type { Pipeline } from './types';
import { assertReusableInstance, capturePluginStates, definition, dependencies, documentFor, expand, materialize, type GroupDefinition } from './groups';

export interface GroupLibrary {
	version: 3;
	pipelines: Record<string, Pipeline>;
	definitions: Record<string, GroupDefinition>;
}

export function definitionContent(d: GroupDefinition): string {
	const { revision: _, ...content } = d;
	return JSON.stringify(content);
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
		if ((saved.version ?? 0) > 3) continue;
		const document = documentFor(saved);
		document.definitions = next.definitions;
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
		if ((p.version ?? 0) > 3) continue;
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
