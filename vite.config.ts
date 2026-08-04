import { defineConfig } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';

// The PWA service worker targets a real HTTPS origin; inside a localhost-loaded
// Electron BrowserWindow it's redundant at best and a source of stale-asset bugs
// at worst, so skip it for Electron builds (see PLAN.md §11.2).
const isElectronBuild = process.env.ELECTRON_BUILD === 'true';

export default defineConfig({
	define: {
		__ELECTRON_BUILD__: JSON.stringify(isElectronBuild)
	},
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
							globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}']
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
