<script lang="ts">
	import { enhance } from '$app/forms';
	import Card, { Content } from '@smui/card';
	import Textfield from '@smui/textfield';
	import Select, { Option } from '@smui/select';
	import Switch from '@smui/switch';
	import FormField from '@smui/form-field';
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

	// --- Evnex integration card ---

	let evnexEmail = $state('');
	let evnexPassword = $state('');
	let connecting = $state(false);
	let saving = $state(false);
	let disconnecting = $state(false);

	let selectedChargePointId = $state<string | null>(null);
	let importLookbackDays = $state('3');
	let evnexEnabled = $state(false);

	$effect(() => {
		selectedChargePointId = data.evnex.chargePointId;
		importLookbackDays = String(data.evnex.importLookbackDays);
		evnexEnabled = data.evnex.enabled;
	});

	const selectedChargePoint = $derived(
		data.chargePoints.find((p) => p.id === selectedChargePointId) ?? null
	);

	function formatLastPolled(iso: string | null) {
		if (!iso) return 'never polled';
		const then = new Date(iso).getTime();
		const minutes = Math.round((Date.now() - then) / 60000);
		if (minutes < 1) return 'last polled just now';
		if (minutes < 60) return `last polled ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
		const hours = Math.round(minutes / 60);
		if (hours < 24) return `last polled ${hours} hour${hours === 1 ? '' : 's'} ago`;
		const days = Math.round(hours / 24);
		return `last polled ${days} day${days === 1 ? '' : 's'} ago`;
	}
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

<h2 class="section-title">Evnex integration</h2>
<p class="page-subtitle">
	Pull recent home-charging sessions from your Evnex charger as drafts — you just add the odometer.
	Uses an undocumented Evnex API and may break if Evnex changes it.
</p>

<Card padded>
	<Content>
		{#if data.evnex.cardState === 'signed_out' || data.evnex.cardState === 'auth_failed'}
			{#if data.evnex.cardState === 'auth_failed'}
				<p class="evnex-reconnect-notice">
					Your Evnex session has expired and needs to be reconnected — sign in again below.
					{#if data.evnex.lastPollError}<span class="evnex-reconnect-detail"
							>({data.evnex.lastPollError})</span
						>{/if}
				</p>
			{/if}

			<form
				method="POST"
				action="?/connectEvnex"
				class="settings-form"
				use:enhance={() => {
					connecting = true;
					return async ({ update }) => {
						connecting = false;
						evnexPassword = '';
						await update();
					};
				}}
			>
				<Textfield
					variant="outlined"
					type="email"
					label="Evnex email"
					bind:value={evnexEmail}
					input$name="email"
					input$autocomplete="username"
					style="width: 100%"
				/>
				<Textfield
					variant="outlined"
					type="password"
					label="Evnex password"
					bind:value={evnexPassword}
					input$name="password"
					input$autocomplete="current-password"
					style="width: 100%"
				/>
				<p class="field-hint">
					Used once to sign in, then discarded — never stored. The same email/password you use in
					the Evnex app.
				</p>

				<Button variant="raised" type="submit" disabled={connecting} style="width: 100%">
					<Label
						>{connecting
							? 'Connecting…'
							: data.evnex.cardState === 'auth_failed'
								? 'Reconnect'
								: 'Connect'}</Label
					>
				</Button>

				{#if form?.connectError}
					<p class="settings-form__error">{form.connectError}</p>
				{/if}
				{#if form?.connectWarning}
					<p class="evnex-warning">{form.connectWarning}</p>
				{/if}
			</form>
		{:else}
			<div class="evnex-connected-header">
				<p class="evnex-connected-line">
					Connected as <strong>{data.evnex.email}</strong> · {formatLastPolled(
						data.evnex.lastPolledAt
					)}
				</p>
				<form
					method="POST"
					action="?/disconnectEvnex"
					use:enhance={() => {
						disconnecting = true;
						return async ({ update }) => {
							disconnecting = false;
							await update();
						};
					}}
				>
					<Button type="submit" disabled={disconnecting}>
						<Label>{disconnecting ? 'Disconnecting…' : 'Disconnect'}</Label>
					</Button>
				</form>
			</div>

			{#if data.evnex.lastPollStatus === 'api_error' || data.evnex.lastPollStatus === 'network_error'}
				{#if data.evnex.lastPollError}
					<p class="evnex-warning">Last poll failed: {data.evnex.lastPollError}</p>
				{/if}
			{/if}

			{#if data.chargePointsError}
				<p class="evnex-warning">{data.chargePointsError}</p>
			{/if}

			<form
				method="POST"
				action="?/saveEvnex"
				class="settings-form"
				use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						saving = false;
						// reset: false — the default `update()` calls the native
						// HTMLFormElement.reset(), which stomps the number Textfield's DOM
						// value out from under its `bind:value`. Since the round-tripped
						// value is textually unchanged, Svelte's reactivity sees no change
						// and never re-syncs the DOM, leaving the field blank and the next
						// save failing validation. State is already restored from `data` by
						// the $effect above, so the native reset is redundant here anyway.
						await update({ reset: false });
					};
				}}
			>
				<Select
					variant="outlined"
					label="Charge point"
					bind:value={selectedChargePointId}
					style="width: 100%"
				>
					{#each data.chargePoints as point (point.id)}
						<Option value={point.id}>{point.name}</Option>
					{/each}
				</Select>
				<input type="hidden" name="chargePointId" value={selectedChargePointId ?? ''} />
				<input type="hidden" name="chargePointName" value={selectedChargePoint?.name ?? ''} />
				<input
					type="hidden"
					name="chargePointTimeZone"
					value={selectedChargePoint?.timeZone ?? ''}
				/>

				<Textfield
					variant="outlined"
					type="number"
					label="Import sessions from the last"
					suffix="days"
					bind:value={importLookbackDays}
					input$name="importLookbackDays"
					input$min="1"
					input$step="1"
					style="width: 100%"
				/>

				<FormField>
					<Switch bind:checked={evnexEnabled} />
					{#snippet label()}Enabled{/snippet}
				</FormField>
				<input type="hidden" name="enabled" value={evnexEnabled ? 'true' : 'false'} />

				<Button variant="raised" type="submit" disabled={saving} style="width: 100%">
					<Label>{saving ? 'Saving…' : 'Save'}</Label>
				</Button>

				{#if form?.savedEvnex}
					<p class="settings-form__ok">Saved.</p>
				{/if}
				{#if form?.saveError}
					<p class="settings-form__error">{form.saveError}</p>
				{/if}
			</form>
		{/if}
	</Content>
</Card>

<h2 class="section-title">Historical import</h2>
<p class="page-subtitle">Import sessions from a legacy monthly spreadsheet.</p>

<Card padded>
	<Content>
		<Button variant="outlined" href="/import" style="width: 100%">
			<Label>Go to import</Label>
		</Button>
	</Content>
</Card>

<style>
	.page-title {
		font-size: 1.3rem;
		margin: 0 0 0.25rem;
	}

	.section-title {
		font-size: 1.05rem;
		margin: 1.75rem 0 0.25rem;
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

	.field-hint {
		color: #64748b;
		font-size: 0.8rem;
		margin: -0.5rem 0 0;
	}

	.evnex-reconnect-notice {
		background: #fef3c7;
		color: #92400e;
		border-radius: 8px;
		padding: 0.65rem 0.85rem;
		font-size: 0.85rem;
		margin: 0 0 1rem;
	}

	.evnex-reconnect-detail {
		color: inherit;
		opacity: 0.85;
	}

	.evnex-warning {
		background: #fef3c7;
		color: #92400e;
		border-radius: 8px;
		padding: 0.65rem 0.85rem;
		font-size: 0.85rem;
		margin: 0 0 1rem;
	}

	.evnex-connected-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.evnex-connected-line {
		margin: 0;
		font-size: 0.9rem;
	}

	@media (prefers-color-scheme: dark) {
		.page-subtitle {
			color: #94a3b8;
		}

		.settings-form__ok {
			color: #2dd4bf;
		}

		.field-hint {
			color: #94a3b8;
		}

		.evnex-reconnect-notice {
			background: #78350f;
			color: #fde68a;
		}

		.evnex-warning {
			background: #78350f;
			color: #fde68a;
		}
	}
</style>
