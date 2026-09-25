<script lang="ts">
	// A persistent, non-dismissable banner for an integration that has stopped
	// working (BYD-INTEGRATION-PLAN.md §7.3). It goes away only when the stored
	// status stops being broken — never on a click.
	import { resolve } from '$app/paths';
	import Button, { Label } from '@smui/button';
	import { mdiAlertCircleOutline } from '@mdi/js';
	import Icon from '$lib/components/Icon.svelte';
	import { formatShortDate } from '$lib/car-reading';
	import type { IntegrationAlert } from '$lib/integration-alert';

	let { alert }: { alert: IntegrationAlert } = $props();
</script>

<div class="integration-alert" role="alert">
	<span class="integration-alert__icon"><Icon path={mdiAlertCircleOutline} size={22} /></span>
	<p class="integration-alert__text">
		{#if alert.kind === 'unreachable' && alert.since}
			{alert.message}
			{formatShortDate(alert.since)}. Odometers won't fill from the car until it's back.
		{:else}
			{alert.message}
		{/if}
	</p>
	<Button variant="outlined" href={resolve(alert.href)} class="integration-alert__fix">
		<Label>Fix in Settings</Label>
	</Button>
</div>

<style>
	.integration-alert {
		display: flex;
		align-items: center;
		gap: 0.6rem;
		flex-wrap: wrap;
		background: #fee2e2;
		color: #991b1b;
		border: 1px solid #b91c1c;
		border-radius: 8px;
		padding: 0.65rem 0.85rem;
		margin: 0 0 1rem;
	}

	.integration-alert__icon {
		display: flex;
	}

	.integration-alert__text {
		flex: 1 1 14rem;
		margin: 0;
		font-size: 0.88rem;
	}

	:global(.integration-alert .integration-alert__fix) {
		color: #991b1b;
		border-color: #b91c1c;
	}

	@media (prefers-color-scheme: dark) {
		.integration-alert {
			background: #450a0a;
			color: #fecaca;
			border-color: #f87171;
		}

		:global(.integration-alert .integration-alert__fix) {
			color: #fecaca;
			border-color: #f87171;
		}
	}
</style>
