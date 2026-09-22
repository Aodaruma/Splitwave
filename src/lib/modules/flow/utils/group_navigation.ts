export function groupPathFromUrl(url: URL): string[] {
	return (url.searchParams.get('group') ?? '').split('/').filter(Boolean);
}

// Shallow routing updates page.state while page.url retains the loaded route URL.
// The query string is the fallback for a reload or a direct link.
export function groupPathFromPage(url: URL, state: { editorGroupPath?: string[] }): string[] {
	return state.editorGroupPath ?? groupPathFromUrl(url);
}

export function groupUrl(url: URL, path: string[]): URL {
	const next = new URL(url);
	if (path.length) next.searchParams.set('group', path.join('/'));
	else next.searchParams.delete('group');
	return next;
}
