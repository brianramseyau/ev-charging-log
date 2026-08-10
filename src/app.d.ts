/// <reference types="vite-plugin-pwa/svelte" />

// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	// Set via vite.config.ts `define`, true when building for the Electron desktop app.
	const __ELECTRON_BUILD__: boolean;
	// Set via vite.config.ts `define` from package.json's `version` field.
	const __APP_VERSION__: string;

	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
