<script lang="ts">
	// Fetches the odometer from the car (via this app's server) for one field. While
	// the integration is broken, it shows a warning icon instead and makes no request
	// — tapping it explains why, with a Fix in Settings link (plan §7.3).
	import IconButton from '@smui/icon-button';
	import { mdiAlertCircleOutline, mdiCarArrowRight } from '@mdi/js';
	import Icon from '$lib/components/Icon.svelte';
	import { readFromCar, type CarReadResult } from '$lib/car-reading';
	import type { IntegrationAlert } from '$lib/integration-alert';

	let {
		draftId,
		alert,
		onresult
	}: {
		draftId?: number;
		alert: IntegrationAlert | null;
		onresult: (result: CarReadResult) => void;
	} = $props();

	let reading = $state(false);
	const broken = $derived(alert?.kind === 'broken');

	async function onclick() {
		if (broken && alert) {
			onresult({ ok: false, status: alert.status, message: alert.message, broken: true });
			return;
		}
		reading = true;
		try {
			onresult(await readFromCar(draftId));
		} finally {
			reading = false;
		}
	}
</script>

<IconButton
	type="button"
	class="read-from-car {broken ? 'read-from-car--broken' : ''} {reading
		? 'read-from-car--busy'
		: ''}"
	disabled={reading}
	aria-label={broken ? `Read from car unavailable: ${alert?.message}` : 'Read odometer from car'}
	title={broken ? alert?.message : 'Read odometer from car'}
	{onclick}
>
	<Icon path={broken ? mdiAlertCircleOutline : mdiCarArrowRight} size={22} />
</IconButton>

<style>
	:global(.read-from-car) {
		color: #0f766e;
		flex: none;
	}

	:global(.read-from-car--broken) {
		color: #b91c1c;
	}

	:global(.read-from-car--busy) {
		animation: read-from-car-pulse 1s ease-in-out infinite;
	}

	@keyframes read-from-car-pulse {
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-color-scheme: dark) {
		:global(.read-from-car) {
			color: #2dd4bf;
		}

		:global(.read-from-car--broken) {
			color: #f87171;
		}
	}
</style>
