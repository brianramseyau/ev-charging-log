<script lang="ts">
	// The line under an odometer field after Read from car: how old the car's data
	// is, whether it was confirmed during the charge, or why it couldn't be read.
	import { resolve } from '$app/paths';
	import type { CarHint } from '$lib/car-reading';

	let { hint }: { hint: CarHint } = $props();
</script>

<p class="car-hint car-hint--{hint.tone}" role={hint.tone === 'error' ? 'alert' : undefined}>
	{hint.text}
	{#if hint.fix}<a href={resolve('/settings')}>Fix in Settings</a>{/if}
</p>

<style>
	.car-hint {
		font-size: 0.8rem;
		margin: 0.25rem 0 0;
		color: #0f766e;
	}

	.car-hint--warning {
		color: #b45309;
	}

	.car-hint--error {
		color: #b91c1c;
	}

	.car-hint a {
		color: inherit;
		font-weight: 600;
	}

	@media (prefers-color-scheme: dark) {
		.car-hint {
			color: #2dd4bf;
		}

		.car-hint--warning {
			color: #fbbf24;
		}

		.car-hint--error {
			color: #f87171;
		}
	}
</style>
