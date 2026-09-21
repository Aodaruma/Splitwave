import type { Pipeline } from '../../pipeline/types';

export function createHistoryRestorer(options: {
	flush: () => void;
	current: () => { history: Pipeline[]; cursor: number };
	restore: (snapshot: Pipeline) => Promise<boolean>;
	setCursor: (cursor: number) => void;
}) {
	let queue = Promise.resolve();
	return (direction: -1 | 1): Promise<void> => {
		const result = queue.then(async () => {
			options.flush();
			const { history, cursor } = options.current();
			const target = cursor + direction;
			if (target < 0 || target >= history.length) return;
			if (await options.restore(history[target])) options.setCursor(target);
		});
		queue = result.catch(() => {});
		return result;
	};
}
