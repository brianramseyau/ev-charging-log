<script lang="ts">
	import { page } from '$app/state';
	import logo from '$lib/assets/logo.svg';

	let { children } = $props();

	const navItems = [
		{
			href: '/',
			label: 'Dashboard',
			icon: 'M4 13h7V4H4v9zm0 7h7v-5H4v5zm9 0h7V11h-7v9zm0-16v5h7V4h-7z'
		},
		{
			href: '/sessions',
			label: 'Sessions',
			icon: 'M13 2L3 14h7l-1 8 10-12h-7l1-8z'
		},
		{
			href: '/periods',
			label: 'Periods',
			icon: 'M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7zM5 9h14v11H5V9z'
		},
		{
			href: '/rates',
			label: 'Rates',
			icon: 'M9.5 6a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM3 19l16-16h2L5 21H3v-2z'
		},
		{
			href: '/import',
			label: 'Import',
			icon: 'M5 20h14v-2H5v2zM12 2 6 9h4v6h4V9h4l-6-7z'
		}
	];

	function isActive(href: string) {
		return href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href);
	}
</script>

<div class="app-shell">
	<header class="app-bar">
		<img src={logo} alt="" class="app-bar__logo" width="28" height="28" />
		<span class="app-bar__title">EV Charging Log</span>
	</header>

	<main class="app-content">
		{@render children()}
	</main>

	<nav class="bottom-nav" aria-label="Primary">
		{#each navItems as item (item.href)}
			<a href={item.href} class="bottom-nav__item" class:is-active={isActive(item.href)}>
				<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
					<path d={item.icon} fill="currentColor" />
				</svg>
				<span>{item.label}</span>
			</a>
		{/each}
	</nav>
</div>

<style>
	:global(html, body) {
		height: 100%;
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
