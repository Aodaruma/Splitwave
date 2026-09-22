import { onDestroy } from 'svelte';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { createMonitorDemand } from './monitor_demand';

const monitors = createMonitorDemand(
	(nodeIds) => (isTauri() ? invoke('set_monitor_targets', { nodeIds }) : Promise.resolve()),
	(error) => console.warn('Monitor subscriptions:', error)
);
if (typeof document !== 'undefined') {
	const visibility = () => monitors.setVisible(!document.hidden);
	visibility();
	document.addEventListener('visibilitychange', visibility);
	if (import.meta.hot)
		import.meta.hot.dispose(() => {
			document.removeEventListener('visibilitychange', visibility);
			monitors.setVisible(false);
		});
}

/**
 * Component-bound `listen`. Call during component initialisation; the listener
 * is registered as soon as the bridge resolves and is always unregistered on
 * destroy -- including the race where the component unmounts before the
 * mount-time promise settles, which would otherwise leak the listener forever
 * and keep waking the dead component on every event.
 */
export function tauriListen<T>(event: string, handler: (payload: T) => void, monitorNodeId?: () => string): void {
	let unlisten: UnlistenFn | undefined;
	let release: (() => void) | undefined;
	let disposed = false;
	const p = listen<T>(event, (e) => {
		if (!unlisten || disposed) return;
		handler(e.payload);
	});
	onDestroy(() => {
		disposed = true;
		release?.();
		p.then(
			(u) => u(),
			(e) => console.warn(`tauriListen(${event}):`, e)
		);
	});
	p.then((u) => {
		unlisten = u;
		if (!disposed && monitorNodeId) release = monitors.add(monitorNodeId());
	}).catch((error) => console.warn(`tauriListen(${event}):`, error));
}
