<script lang="ts">
	import light from '@fluentui/svg-icons/icons/weather_sunny_16_regular.svg?raw';
	import dark from '@fluentui/svg-icons/icons/weather_moon_16_regular.svg?raw';
	import system from '@fluentui/svg-icons/icons/desktop_16_regular.svg?raw';
	import Icon from './_icon.svelte';
	import type { ClassValue } from 'svelte/elements';
	import type { ThemePref } from '$lib/modules/theme/stores';
	let { theme, class: cls = 'size-4', title }: { theme: ThemePref; class?: ClassValue; title?: string } = $props();
	const icons = { light, dark, system };
</script>

<Icon svg={icons[theme]} class={cls} {title} />
