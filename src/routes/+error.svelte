<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import crashedEv from '$lib/assets/crashed-ev.svg';
</script>

<div class="error-page">
	<img src={crashedEv} alt="A cartoon illustration of a crashed EV, dazed with X eyes and smoke" />
	<h1>Oh no, it crashed!</h1>
	<p class="error-page__status">
		{page.status}{page.error?.message ? ` — ${page.error.message}` : ''}
	</p>
	<a class="error-page__home" href={resolve('/')}>Back to safety</a>
</div>

<style>
	.error-page {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		gap: 0.75rem;
		padding: 3rem 1rem;
	}

	.error-page img {
		max-width: 320px;
		width: 100%;
		height: auto;
	}

	.error-page h1 {
		margin: 0;
		font-size: 1.3rem;
	}

	.error-page__status {
		color: #64748b;
		font-family: monospace;
	}

	.error-page__home {
		margin-top: 0.5rem;
		color: #0369a1;
		font-weight: 600;
		text-decoration: none;
	}

	@media (prefers-color-scheme: dark) {
		.error-page__status {
			color: #94a3b8;
		}

		.error-page__home {
			color: #38bdf8;
		}
	}
</style>
