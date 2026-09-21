import { browser } from '$app/environment';
import { isEnabled, enable, disable } from '@tauri-apps/plugin-autostart';

const KEY = 'app:settings';

interface Stored {
	checkUpdatesOnLaunch: boolean;
	includePreReleases: boolean;
	maxSnapshots: number;
	snapToGrid: boolean;
	gridSize: number;
	launchOnStartup: boolean;
	closeToTray: boolean;
	startInTray: boolean;
	confirmOverwriteChanges: boolean;
	keepRunningOnDisconnect: boolean;
	pipelineSampleRate: number;
}

const DEFAULTS: Stored = {
	checkUpdatesOnLaunch: true,
	includePreReleases: false,
	maxSnapshots: 20,
	snapToGrid: false,
	gridSize: 20,
	launchOnStartup: false,
	closeToTray: false,
	startInTray: false,
	confirmOverwriteChanges: true,
	keepRunningOnDisconnect: true,
	pipelineSampleRate: 48_000
};

export const SNAPSHOT_LIMITS = [10, 20, 50, 100] as const;
export const GRID_SIZES = [10, 20, 40] as const;
export const PIPELINE_SAMPLE_RATE_PRESETS = [44100, 48000, 88200, 96000, 176400, 192000] as const;

function load(): Stored {
	if (!browser) return DEFAULTS;
	try {
		return { ...DEFAULTS, ...JSON.parse(window.localStorage.getItem(KEY) ?? '{}') };
	} catch {
		return DEFAULTS;
	}
}

class AppSettings {
	#initial = load();
	checkUpdatesOnLaunch = $state(this.#initial.checkUpdatesOnLaunch);
	includePreReleases = $state(this.#initial.includePreReleases ?? false);
	maxSnapshots = $state(this.#initial.maxSnapshots);
	snapToGrid = $state(this.#initial.snapToGrid);
	gridSize = $state(this.#initial.gridSize);
	launchOnStartup = $state(this.#initial.launchOnStartup);
	closeToTray = $state(this.#initial.closeToTray);
	startInTray = $state(this.#initial.startInTray);
	confirmOverwriteChanges = $state(this.#initial.confirmOverwriteChanges);
	keepRunningOnDisconnect = $state(this.#initial.keepRunningOnDisconnect);
	pipelineSampleRate = $state(this.#initial.pipelineSampleRate ?? 48_000);

	persist(): void {
		if (!browser) return;
		const {
			checkUpdatesOnLaunch,
			includePreReleases,
			maxSnapshots,
			snapToGrid,
			gridSize,
			launchOnStartup,
			closeToTray,
			startInTray,
			confirmOverwriteChanges,
			keepRunningOnDisconnect,
			pipelineSampleRate
		} = this;
		window.localStorage.setItem(
			KEY,
			JSON.stringify({
				checkUpdatesOnLaunch,
				includePreReleases,
				maxSnapshots,
				snapToGrid,
				gridSize,
				launchOnStartup,
				closeToTray,
				startInTray,
				confirmOverwriteChanges,
				keepRunningOnDisconnect,
				pipelineSampleRate
			})
		);
	}

	reset(): void {
		Object.assign(this, DEFAULTS);
		this.persist();
	}

	/** Reconciles the mirror from the plugin's real OS registration state,
	 * in case the user removed Splitwave from login items outside the app. */
	async syncLaunchOnStartup(): Promise<void> {
		if (!browser) return;
		try {
			this.launchOnStartup = await isEnabled();
		} catch {
			// Plugin unavailable (e.g. non-Tauri dev preview) -- leave the mirror as-is.
		}
	}

	async setLaunchOnStartup(enabled: boolean): Promise<void> {
		if (enabled) await enable();
		else await disable();
		this.launchOnStartup = await isEnabled();
		this.persist();
	}
}

export const appSettings = new AppSettings();
