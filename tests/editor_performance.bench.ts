import { displayFrame, editorHarness, editorSource, fixture } from './helpers/editor_performance';
import { expand } from '../src/lib/modules/pipeline/groups';
import { saveToLibrary } from '../src/lib/modules/pipeline/group_library';

const ref = process.env.EDITOR_PERF_REF;
let source = editorSource;
if (ref) {
	const result = Bun.spawnSync(['git', 'show', `${ref}:src/lib/modules/flow/ui/editor.svelte`]);
	if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
	source = new TextDecoder().decode(result.stdout);
}
if (!source.includes('function getSnapshot')) throw new Error('Missing editor source');
const frames = 120;
const samples: number[] = [];
let counts;
for (let repeat = 0; repeat < 6; repeat++) {
	const editor = editorHarness(source);
	displayFrame(editor, 0);
	for (const key of Object.keys(editor.counts) as (keyof typeof editor.counts)[]) editor.counts[key] = 0;
	const start = performance.now();
	for (let frame = 1; frame <= frames; frame++) displayFrame(editor, frame);
	if (repeat) samples.push((performance.now() - start) / frames);
	counts = editor.counts;
}
samples.sort((a, b) => a - b);
console.log(
	JSON.stringify({ source: ref ?? 'working tree', bun: Bun.version, instances: 12, nodes: 192, edges: 180, frames, medianMsPerFrame: samples[2], counts })
);

for (const [label, run] of [
	[
		'expand',
		() => {
			const { doc } = fixture();
			return () => expand(doc);
		}
	],
	[
		'saveToLibrary',
		() => {
			const { library, pipeline } = fixture();
			return () => saveToLibrary(library, pipeline);
		}
	]
] as const) {
	const operation = run();
	const timings: number[] = [];
	for (let i = 0; i < 6; i++) {
		const start = performance.now();
		for (let j = 0; j < 30; j++) operation();
		if (i) timings.push((performance.now() - start) / 30);
	}
	timings.sort((a, b) => a - b);
	console.log(JSON.stringify({ operation: label, medianMs: timings[2] }));
}
