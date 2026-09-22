/** UI subscriptions only; this never changes the saved graph or audio processing. */
export function createMonitorDemand(send: (nodeIds: string[]) => Promise<unknown>, report: (error: unknown) => void) {
	const counts = new Map<string, number>();
	let visible = true;
	let scheduled = false;
	let last: string | undefined;
	let queue = Promise.resolve();
	function schedule() {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			queue = queue
				.then(async () => {
					const ids = visible ? [...counts.keys()].sort() : [];
					const signature = JSON.stringify(ids);
					if (signature === last) return;
					await send(ids);
					last = signature;
				})
				.catch(report);
		});
	}
	schedule(); // Clear subscriptions left by a previous webview document.
	return {
		add(id: string) {
			counts.set(id, (counts.get(id) ?? 0) + 1);
			schedule();
			let removed = false;
			return () => {
				if (removed) return;
				removed = true;
				const count = counts.get(id)! - 1;
				if (count) counts.set(id, count);
				else counts.delete(id);
				schedule();
			};
		},
		setVisible(value: boolean) {
			visible = value;
			schedule();
		}
	};
}
