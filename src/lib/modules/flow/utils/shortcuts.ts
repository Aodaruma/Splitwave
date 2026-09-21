export function canvasShortcut(
	event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
	onCanvas: boolean
): 'duplicate' | 'toggleGrid' | 'switchInputs' | 'align' | 'bypass' | null {
	if (!onCanvas) return null;
	if (event.altKey) return event.key.toLowerCase() === 's' && !event.ctrlKey && !event.metaKey && !event.shiftKey ? 'switchInputs' : null;
	const mod = event.ctrlKey || event.metaKey;
	if (!mod && event.shiftKey && (event.key === '=' || event.key === '+')) return 'align';
	if (!mod && !event.shiftKey && event.key.toLowerCase() === 'm') return 'bypass';
	if (event.key === 'Tab' && event.shiftKey && !mod) return 'toggleGrid';
	if (event.key.toLowerCase() === 'd' && mod && !event.shiftKey) return 'duplicate';
	return null;
}
