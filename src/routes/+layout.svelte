<script lang="ts">
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import {
		mdiViewDashboard,
		mdiLightningBolt,
		mdiCalendarRange,
		mdiTune,
		mdiTrayArrowUp,
		mdiCog
	} from '@mdi/js';
	import logo from '$lib/assets/logo.svg';
	import Icon from '$lib/components/Icon.svelte';

	let { children } = $props();

	if (browser && !__ELECTRON_BUILD__) {
		// The virtual module only exists when SvelteKitPWA is registered (skipped for
		// Electron builds, see vite.config.ts) — @vite-ignore keeps the bundler from
		// trying to statically resolve it in that case.
		const pwaRegisterModule = 'virtual:pwa-register/svelte';
		import(/* @vite-ignore */ pwaRegisterModule).then(({ useRegisterSW }) => useRegisterSW());
	}

	const navItems = [
		{ href: '/', label: 'Dashboard', icon: mdiViewDashboard },
		{ href: '/sessions', label: 'Sessions', icon: mdiLightningBolt },
		{ href: '/periods', label: 'Periods', icon: mdiCalendarRange },
		{ href: '/rates', label: 'Rates', icon: mdiTune },
		{ href: '/import', label: 'Import', icon: mdiTrayArrowUp }
	];

	function isActive(href: string) {
		return href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
	}
</script>

<div class="app-shell">
	<header class="app-bar">
		<img src={logo} alt="" class="app-bar__logo" width="28" height="28" />
		<span class="app-bar__title">EV Charging Log</span>
		<a href="/settings" class="app-bar__settings" aria-label="Settings">
			<Icon path={mdiCog} size={22} />
		</a>
	</header>

	<main class="app-content">
		{@render children()}
	</main>

	<nav class="bottom-nav" aria-label="Primary">
		{#each navItems as item (item.href)}
			<a href={item.href} class="bottom-nav__item" class:is-active={isActive(item.href)}>
				<Icon path={item.icon} size={22} />
				<span>{item.label}</span>
			</a>
		{/each}
	</nav>
</div>

<style>
	:global(html, body) {
		height: 100%;
	}

	:global(html) {
		--charge-home-color: #3987e5;
		--charge-public-color: #d95926;
		color-scheme: light dark;
	}

	:global(body) {
		margin: 0;
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
	}

	.app-shell {
		display: flex;
		flex-direction: column;
		min-height: 100dvh;
	}

	.app-bar {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: max(0.75rem, env(safe-area-inset-top)) 1rem 0.75rem;
		background: #0f766e;
		color: #fff;
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.app-bar__logo {
		border-radius: 6px;
	}

	.app-bar__title {
		font-size: 1.05rem;
		font-weight: 600;
		flex: 1;
	}

	.app-bar__settings {
		display: flex;
		color: inherit;
		opacity: 0.9;
	}

	.app-content {
		flex: 1;
		padding: 1rem 1rem calc(1rem + 64px + env(safe-area-inset-bottom));
		max-width: 720px;
		width: 100%;
		margin: 0 auto;
		box-sizing: border-box;
	}

	.bottom-nav {
		position: fixed;
		bottom: 0;
		left: 0;
		right: 0;
		display: flex;
		background: #fff;
		border-top: 1px solid rgba(0, 0, 0, 0.1);
		padding-bottom: env(safe-area-inset-bottom);
		z-index: 10;
	}

	.bottom-nav__item {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 8px 4px 6px;
		font-size: 0.68rem;
		text-decoration: none;
		color: #64748b;
	}

	.bottom-nav__item.is-active {
		color: #0f766e;
	}

	@media (prefers-color-scheme: dark) {
		.bottom-nav {
			background: #111827;
			border-top-color: rgba(255, 255, 255, 0.1);
		}

		.bottom-nav__item {
			color: #94a3b8;
		}

		.bottom-nav__item.is-active {
			color: #2dd4bf;
		}
	}
</style>
