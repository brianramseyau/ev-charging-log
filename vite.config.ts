import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { version as pkgVersion } from './package.json' with { type: 'json' };

// The PWA service worker targets a real HTTPS origin; inside a localhost-loaded
// Electron BrowserWindow it's redundant at best and a source of stale-asset bugs
// at worst, so skip it for Electron builds (see PLAN.md §11.2).
const isElectronBuild = process.env.ELECTRON_BUILD === 'true';

// `virtual:pwa-register/svelte` only exists when SvelteKitPWA is registered. The
// layout imports it (guarded by __ELECTRON_BUILD__ at runtime, but Rollup still
// resolves every import), so Electron builds point it at a no-op stub instead.
const pwaRegisterStub = fileURLToPath(new URL('./src/lib/pwa-register-stub.ts', import.meta.url));

// package.json's version only bumps for tagged releases (see .github/workflows/docker-publish.yml
// and electron-release.yml, both `v*`-tag-triggered). Untagged CI builds off `main` set APP_VERSION
// to `dev-<short sha>` instead, so the Settings page doesn't show a stale release version for a
// build that's actually ahead of it.
const appVersion = process.env.APP_VERSION || pkgVersion;

export default defineConfig({
	define: {
		__ELECTRON_BUILD__: JSON.stringify(isElectronBuild),
		__APP_VERSION__: JSON.stringify(appVersion)
	},
	resolve: isElectronBuild
		? {
				alias: {
					'virtual:pwa-register/svelte': pwaRegisterStub
				}
			}
		: undefined,
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			typescript: {
				config: (config) => {
					config.include.push('../drizzle.config.ts');
				}
			}
		}),
		...(isElectronBuild
			? []
			: [
					SvelteKitPWA({
						registerType: 'autoUpdate',
						// SvelteKit defaults `paths.relative` to true, which makes Vite's own
						// `base` `'./'` — and vite-plugin-pwa inherits it, emitting a service
						// worker registered as `./sw.js` with scope `./`. That resolves against
						// the current *page* URL, so registering from e.g. /periods/22 asks for
						// /periods/sw.js (404) and silently never registers. Pin both to the
						// root, which is where the app and the worker actually live.
						base: '/',
						scope: '/',
						manifest: {
							name: 'EV Charging Log',
							short_name: 'Charging Log',
							description: 'Track EV charging sessions and generate lease-company billing reports.',
							theme_color: '#0f766e',
							background_color: '#f8fafc',
							display: 'standalone',
							start_url: '/',
							icons: [
								{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
								{ src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
								{
									src: '/icons/icon-maskable-192.png',
									sizes: '192x192',
									type: 'image/png',
									purpose: 'maskable'
								},
								{
									src: '/icons/icon-maskable-512.png',
									sizes: '512x512',
									type: 'image/png',
									purpose: 'maskable'
								}
							]
						},
						workbox: {
							globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
							// @vite-pwa/sveltekit otherwise defaults this to `/`, which for an
							// SSR app (adapter-node, no prerendered index.html) points at a URL
							// that is never precached: workbox's NavigationRoute then throws
							// `non-precached-url` on every activation and the route is silently
							// dropped. There is nothing to fall back to here anyway — every
							// navigation must reach the server — so say so explicitly rather
							// than relying on that failure, which would start serving the cached
							// app shell in place of real responses (report downloads included)
							// if `/` ever did end up in the precache manifest.
							navigateFallback: null
						},
						devOptions: {
							enabled: true,
							suppressWarnings: true
						}
					})
				])
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
