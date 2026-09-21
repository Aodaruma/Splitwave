import { browser } from '$app/environment';
import { writable } from 'svelte/store';
import { withoutTransition } from '$lib/utils/transition';

export type ThemePref = 'light' | 'dark' | 'system';

const KEY = 'theme';

function stored(): ThemePref {
	if (!browser) return 'dark';
	const v = window.localStorage.getItem(KEY);
	return v === 'light' || v === 'dark' || v === 'system' ? v : 'dark';
}

const media = browser ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const reducedMotion = browser ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
let initialized = false;
let transitionTimer: ReturnType<typeof setTimeout> | undefined;

function resolve(pref: ThemePref): 'light' | 'dark' {
	if (pref !== 'system') return pref;
	return media?.matches ? 'dark' : 'light';
}

function paint(pref: ThemePref, animate = false): void {
	if (!browser) return;
	const root = document.documentElement;
	clearTimeout(transitionTimer);
	const apply = () => root.classList.toggle('dark', resolve(pref) === 'dark');
	if (animate && !reducedMotion?.matches) {
		root.classList.add('theme-changing');
		// Commit the old palette with color transitions enabled before changing it.
		window.getComputedStyle(root).color;
		apply();
		transitionTimer = setTimeout(() => root.classList.remove('theme-changing'), 200);
	} else {
		withoutTransition(() => {
			root.classList.remove('theme-changing');
			apply();
		});
	}
}

export const themeStore = writable<ThemePref>(stored());

themeStore.subscribe((value) => {
	if (!browser) return;
	window.localStorage.setItem(KEY, value);
	paint(value, initialized);
	initialized = true;
});

// Only meaningful under 'system': the OS flipping themes must repaint live.
media?.addEventListener('change', () => {
	if (stored() === 'system') paint('system');
});
