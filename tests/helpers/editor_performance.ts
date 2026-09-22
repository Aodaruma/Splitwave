import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { definition, materialize, scopeAt, type GroupDefinition, type GroupDocument } from '../../src/lib/modules/pipeline/groups';
import { usageCount, validateSharedRoutes, type GroupLibrary } from '../../src/lib/modules/pipeline/group_library';
import { groupView, saveGroupView } from '../../src/lib/modules/flow/utils/group_view';
import type { Pipeline } from '../../src/lib/modules/pipeline/types';
import { PIPELINE_VERSION } from '../../src/lib/modules/pipeline/version';

export const editorSource = readFileSync(new URL('../../src/lib/modules/flow/ui/editor.svelte', import.meta.url), 'utf8');

export function fixture(instances = 12, size = 16) {
	const leaf: GroupDefinition = {
		id: 'leaf',
		name: 'Leaf',
		revision: 0,
		inputs: [],
		outputs: [],
		nodes: Array.from({ length: size }, (_, i) => ({ id: `n${i}`, kind: 'gain', position: { x: i * 100, y: 0 }, data: { gainDb: 0, bypassed: false } })),
		edges: Array.from({ length: size - 1 }, (_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}`, sourceHandle: 'ch1', targetHandle: 'ch1' }))
	};
	const root: GroupDefinition = {
		id: 'root',
		name: 'Root',
		revision: 0,
		inputs: [],
		outputs: [],
		edges: [],
		nodes: Array.from({ length: instances }, (_, i) => ({ id: `g${i}`, kind: 'group', position: { x: i * 100, y: 0 }, data: { definition: leaf.id } }))
	};
	const doc: GroupDocument = { root: root.id, definitions: { root, leaf }, runtimeIds: {}, pluginStates: {} };
	for (const group of root.nodes) {
		for (const n of leaf.nodes) doc.runtimeIds[`${group.id}/${n.id}`] = `${group.id}-${n.id}`;
		for (const e of leaf.edges) doc.runtimeIds[`${group.id}/#${e.id}`] = `${group.id}-${e.id}`;
	}
	const pipeline: Pipeline = materialize({ id: 'p', name: 'Root', version: PIPELINE_VERSION, createdAt: 1, updatedAt: 1, nodes: [], edges: [] }, doc);
	const library: GroupLibrary = { version: 4, pipelines: { p: structuredClone(pipeline) }, definitions: structuredClone(doc.definitions) };
	return { pipeline, doc, library };
}

// Execute the component's actual read paths without mounting a UI or importing stores.
export function editorHarness(source = editorSource, data = fixture()) {
	const script = source.slice(source.indexOf('<script lang="ts">') + '<script lang="ts">'.length, source.indexOf('</script>'));
	const ast = ts.createSourceFile('editor.ts', script, ts.ScriptTarget.Latest, true);
	const names = ['getSnapshot', 'groupUsage', 'routingSignature'];
	const selected = ast.statements.filter(
		(s) =>
			(ts.isFunctionDeclaration(s) && names.includes(s.name!.text)) ||
			(ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === 'routingCache'))
	);
	const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(selected.map((s) => s.getText(ast)).join('\n'));
	const counts = { snapshots: 0, expansions: 0, validations: 0, documentClones: 0 };
	const view = groupView(data.doc, []);
	const scope = {
		counts,
		pipeline: data.pipeline,
		groupDocument: data.doc,
		groupLibrary: data.library,
		groupPath: [] as string[],
		...view,
		definition,
		scopeAt,
		usageCount,
		saveGroupView,
		$state: { snapshot: structuredClone },
		structuredClone: <T>(value: T): T => {
			counts.documentClones++;
			return structuredClone(value);
		},
		materialize: (...args: Parameters<typeof materialize>) => {
			counts.expansions++;
			return materialize(...args);
		},
		validateSharedRoutes: (library: GroupLibrary) => {
			counts.validations++;
			return validateSharedRoutes(library);
		}
	};
	// Instrument after transpiling so the TypeScript return annotation cannot hide the entry point.
	if (!code.includes('function getSnapshot() {')) throw new Error('Snapshot instrumentation did not match');
	const instrumented = code.replace('function getSnapshot() {', 'function getSnapshot() { counts.snapshots++;');
	const callbacks = new Function('scope', `with (scope) { ${instrumented}; return { ${names.join(',')} }; }`)(scope) as {
		getSnapshot(): Pipeline;
		groupUsage(id: string): number;
		routingSignature(): string;
	};
	return { scope, counts, ...callbacks };
}

export function displayFrame(editor: ReturnType<typeof editorHarness>, frame: number) {
	editor.scope.nodes = editor.scope.nodes.map((n) => ({ ...n, position: { x: n.position.x + 1, y: frame }, selected: true, dragging: true }));
	for (const n of editor.scope.nodes) if (n.type === 'group') editor.groupUsage(String(n.data.definition));
	editor.groupUsage(scopeAt(editor.scope.groupDocument, editor.scope.groupPath).id);
	editor.routingSignature();
}
