// Stand-in for vite-plugin-pwa's `virtual:pwa-register/svelte`, aliased in
// vite.config.ts for Electron builds only.
//
// Electron builds deliberately skip SvelteKitPWA (see PLAN.md §11.2), so the
// virtual module doesn't exist there — but Rollup still has to resolve every
// import in the graph, including the layout's guarded dynamic one. A no-op stub
// keeps the desktop bundle building without shipping PWA code into it.
//
// Mirrors `UseRegisterSWReturn` from vite-plugin-pwa/svelte closely enough for
// the (never reached) call site: two boolean stores plus the updater function.
const noop = () => {};

export function useRegisterSW() {
	// A zero-argument subscribe is assignable to Svelte's Readable<T> signature.
	const store = () => ({ subscribe: () => noop });
	return {
		needRefresh: store(),
		offlineReady: store(),
		updateServiceWorker: () => Promise.resolve()
	};
}
