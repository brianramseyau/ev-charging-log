<script lang="ts">
	import Card, { Content } from '@smui/card';
	import Textfield from '@smui/textfield';
	import Button, { Label } from '@smui/button';
	import AddressField from '$lib/components/AddressField.svelte';
	import type { PageData, ActionData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let fullName = $state('');
	let vehicleLabel = $state('');
	let homeAddress = $state('');

	$effect(() => {
		fullName = data.settings?.fullName ?? '';
		vehicleLabel = data.settings?.vehicleLabel ?? '';
		homeAddress = data.settings?.homeAddress ?? '';
	});
</script>

<svelte:head>
	<title>Settings · EV Charging Log</title>
</svelte:head>

<h1 class="page-title">Settings</h1>
<p class="page-subtitle">Your name and vehicle rego/VIN, as printed on the lease-company report.</p>

<Card padded>
	<Content>
		<form method="POST" action="?/save" class="settings-form">
			<Textfield
				variant="outlined"
				label="Full name"
				bind:value={fullName}
				input$name="fullName"
				style="width: 100%"
			/>
			<Textfield
				variant="outlined"
				label="Vehicle (rego or VIN)"
				bind:value={vehicleLabel}
				input$name="vehicleLabel"
				style="width: 100%"
			/>
			<AddressField label="Home address (optional)" bind:value={homeAddress} name="homeAddress" />

			<Button variant="raised" type="submit" style="width: 100%">
				<Label>Save</Label>
			</Button>

			{#if form?.success}
				<p class="settings-form__ok">Saved.</p>
			{/if}
			{#if form?.error}
				<p class="settings-form__error">{form.error}</p>
			{/if}
		</form>
	</Content>
</Card>

<style>
	.page-title {
		font-size: 1.3rem;
		margin: 0 0 0.25rem;
	}

	.page-subtitle {
		font-size: 0.85rem;
		color: #64748b;
		margin: 0 0 1rem;
	}

	.settings-form {
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.settings-form__ok {
		color: #0f766e;
		margin: 0;
	}

	.settings-form__error {
		color: #b91c1c;
		margin: 0;
	}

	@media (prefers-color-scheme: dark) {
		.page-subtitle {
			color: #94a3b8;
		}

		.settings-form__ok {
			color: #2dd4bf;
		}
	}
</style>
