export function canvasShortcut(
	event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>,
	onCanvas: boolean
): 'duplicate' | 'toggleGrid' | null {
	if (!onCanvas || event.altKey) return null;
	const mod = event.ctrlKey || event.metaKey;
	if (event.key === 'Tab' && event.shiftKey && !mod) return 'toggleGrid';
	if (event.key.toLowerCase() === 'd' && mod && !event.shiftKey) return 'duplicate';
	return null;
}
