<script lang="ts">
	import { enhance } from '$app/forms';
	import { untrack } from 'svelte';
	import Button, { Label } from '@smui/button';
	import Card, { Content } from '@smui/card';
	import IconButton from '@smui/icon-button';
	import Textfield from '@smui/textfield';
	import { mdiDeleteOutline } from '@mdi/js';
	import DateTimeField from '$lib/components/DateTimeField.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	const homeAddress = $derived(data.homeAddress ?? '');

	// Local state for the add-session form. Re-seeded from the last submission's
	// values whenever a validation failure comes back, so the user doesn't have
	// to retype everything.
	let kind = $state<'home' | 'public'>('home');
	let date = $state('');
	let time = $state('');
	let odometerKm = $state('');
	let kwhUsed = $state('');
	let location = $state(untrack(() => data.homeAddress) ?? '');
	let notes = $state('');
	// Drafts skip kWh — it's not known until charging finishes, which is the
	// whole point: log date/time/odometer/location on the spot, before driving off.
	let isDraft = $state(false);

	let submitting = $state(false);
	let completingId = $state<number | null>(null);

	const PAGE_SIZE = 5;
	let visibleCount = $state(PAGE_SIZE);
	const visibleSessions = $derived(data.sessions.slice(0, visibleCount));

	// Pre-populate Location with the saved home address whenever the user switches
	// to a home session, but only if they haven't already typed something in.
	$effect(() => {
		if (kind === 'home') {
			untrack(() => {
				if (!location.trim()) location = homeAddress;
			});
		}
	});

	$effect(() => {
		if (form?.values) {
			kind = (form.values.kind as 'home' | 'public' | null) ?? 'home';
			date = form.values.date ?? '';
			time = form.values.time ?? '';
			odometerKm = form.values.odometerKm ?? '';
			kwhUsed = form.values.kwhUsed ?? '';
			location = form.values.location ?? '';
			notes = form.values.notes ?? '';
			isDraft = form.values.isDraft === 'true';
		}
	});

	function resetForm() {
		kind = 'home';
		date = '';
		time = '';
		odometerKm = '';
		kwhUsed = '';
		location = homeAddress;
		notes = '';
		isDraft = false;
	}

	const errors = $derived(form?.errors ?? {});
	const completeError = $derived(form?.completeError ?? null);
	const completeErrorId = $derived(form?.completeId ?? null);

	function formatCost(cost: number | null) {
		return cost == null ? null : `$${cost.toFixed(2)}`;
	}

	function formatEfficiency(value: number | null) {
		return value == null ? null : `${value.toFixed(2)} km/kWh`;
	}
</script>

<svelte:head>
	<title>Sessions — EV Charging Log</title>
</svelte:head>

<h1>Charging sessions</h1>

{#if form?.error}
	<p class="field-error page-error">{form.error}</p>
{/if}

<Card class="session-form-card" padded>
	<Content>
		<h2 class="section-title">Log a session</h2>

		<form
			method="POST"
			action="?/create"
			use:enhance={() => {
				submitting = true;
				return async ({ result, update }) => {
					submitting = false;
					if (result.type === 'success') {
						resetForm();
					}
					await update({ reset: false });
				};
			}}
		>
			<div class="field-group">
				<span class="field-label">Kind</span>
				<div class="kind-toggle" role="radiogroup" aria-label="Charging kind">
					<label class:selected={kind === 'home'} class="kind-toggle__home">
						<input type="radio" name="kind" value="home" bind:group={kind} />
						Home
					</label>
					<label class:selected={kind === 'public'} class="kind-toggle__public">
						<input type="radio" name="kind" value="public" bind:group={kind} />
						Public
					</label>
				</div>
				{#if errors.kind}<p class="field-error">{errors.kind}</p>{/if}
			</div>

			<div class="field-group">
				<label class="draft-checkbox">
					<input type="checkbox" name="isDraft" value="true" bind:checked={isDraft} />
					Just plugged in — save as draft, add kWh later
				</label>
			</div>

			<div class="field-row">
				<DateTimeField
					type="date"
					label="Date"
					name="date"
					bind:value={date}
					required
					error={errors.date}
				/>
			</div>

			<div class="field-row">
				<DateTimeField
					type="time"
					label="Time"
					name="time"
					bind:value={time}
					required
					error={errors.time}
				/>
			</div>

			<div class="field-row">
				<Textfield
					variant="outlined"
					type="number"
					label="Odometer (km)"
					bind:value={odometerKm}
					input$name="odometerKm"
					input$step="0.1"
					input$min="0"
					required
					style="width: 100%"
					invalid={!!errors.odometerKm}
				/>
				{#if errors.odometerKm}<p class="field-error">{errors.odometerKm}</p>{/if}
			</div>

			{#if !isDraft}
				<div class="field-row">
					<Textfield
						variant="outlined"
						type="number"
						label="kWh used"
						bind:value={kwhUsed}
						input$name="kwhUsed"
						input$step="0.01"
						input$min="0"
						required
						style="width: 100%"
						invalid={!!errors.kwhUsed}
					/>
					{#if errors.kwhUsed}<p class="field-error">{errors.kwhUsed}</p>{/if}
				</div>
			{/if}

			<div class="field-row">
				<Textfield
					variant="outlined"
					label="Location"
					bind:value={location}
					input$name="location"
					required
					style="width: 100%"
					invalid={!!errors.location}
				/>
				{#if errors.location}<p class="field-error">{errors.location}</p>{/if}
			</div>

			<div class="field-row">
				<Textfield
					variant="outlined"
					textarea
					label="Notes (optional)"
					bind:value={notes}
					input$name="notes"
					style="width: 100%"
				/>
			</div>

			<Button variant="raised" type="submit" disabled={submitting} style="width: 100%">
				<Label>{submitting ? 'Saving…' : isDraft ? 'Save draft' : 'Save session'}</Label>
			</Button>

			{#if form?.success}
				<div class="save-feedback">
					<p class="save-feedback__ok">
						{form.isDraft ? 'Draft saved — add kWh once charging finishes.' : 'Session saved.'}
					</p>
					{#if form.odometerWarning}
						<p class="save-feedback__warning">
							Warning: this odometer reading is lower than the last recorded reading.
						</p>
					{/if}
					{#if form.unassigned}
						<p class="save-feedback__note">Not yet assigned to a billing period.</p>
					{/if}
					{#if form.noRatePlan}
						<p class="save-feedback__warning">
							No rate plan covers this date yet — cost was left unset. Add one on the Rates page.
						</p>
					{/if}
				</div>
			{/if}
		</form>
	</Content>
</Card>

<h2 class="section-title">History</h2>

{#if data.sessions.length === 0}
	<p class="empty-state">No sessions logged yet.</p>
{:else}
	<ul class="session-list">
		{#each visibleSessions as session (session.id)}
			<li class="session-row" class:session-row--draft={session.isDraft}>
				<div class="session-row__top">
					<span class="badge" class:badge--home={session.kind === 'home'}>
						{session.kind === 'home' ? 'Home' : 'Public'}
					</span>
					{#if session.isDraft}
						<span class="badge badge--draft">Draft</span>
					{/if}
					<span class="session-row__datetime">{session.date} · {session.time}</span>
					{#if !session.periodSubmitted}
						<form method="POST" action="?/delete" use:enhance class="delete-form">
							<input type="hidden" name="id" value={session.id} />
							<IconButton type="submit" aria-label="Delete session" title="Delete session">
								<Icon path={mdiDeleteOutline} size={20} />
							</IconButton>
						</form>
					{/if}
				</div>
				<div class="session-row__details">
					<span>{session.odometerKm.toLocaleString()} km</span>
					{#if session.kwhUsed != null}
						<span>{session.kwhUsed} kWh</span>
					{/if}
					<span>{session.location}</span>
					{#if session.cost != null}
						<span>{formatCost(session.cost)}</span>
					{/if}
				</div>
				<div class="session-row__meta">
					{#if session.efficiencyKmPerKwh != null}
						<span class="efficiency">{formatEfficiency(session.efficiencyKmPerKwh)}</span>
					{/if}
					{#if session.billingPeriodLabel}
						<span class="period-label">{session.billingPeriodLabel}</span>
					{:else}
						<span class="period-label period-label--unassigned">
							Not yet assigned to a billing period
						</span>
					{/if}
				</div>
				{#if session.notes}
					<p class="session-row__notes">{session.notes}</p>
				{/if}
				{#if session.isDraft && !session.periodSubmitted}
					<form
						method="POST"
						action="?/complete"
						class="complete-form"
						use:enhance={() => {
							completingId = session.id;
							return async ({ update }) => {
								completingId = null;
								await update();
							};
						}}
					>
						<input type="hidden" name="id" value={session.id} />
						<label class="complete-form__field">
							<span class="complete-form__label">kWh used</span>
							<input
								type="number"
								name="kwhUsed"
								step="0.01"
								min="0"
								required
								class:invalid={completeErrorId === session.id && !!completeError}
							/>
						</label>
						<Button variant="outlined" type="submit" disabled={completingId === session.id}>
							<Label>{completingId === session.id ? 'Saving…' : 'Complete'}</Label>
						</Button>
					</form>
					{#if completeErrorId === session.id && completeError}
						<p class="field-error">{completeError}</p>
					{/if}
				{/if}
			</li>
		{/each}
	</ul>
	{#if visibleCount < data.sessions.length}
		<Button
			variant="outlined"
			style="width: 100%; margin-top: 0.75rem"
			onclick={() => (visibleCount += PAGE_SIZE)}
		>
			<Label>Load more</Label>
		</Button>
	{/if}
{/if}

<style>
	.section-title {
		font-size: 1rem;
		font-weight: 600;
		margin: 1.5rem 0 0.75rem;
	}

	:global(.session-form-card) {
		margin-bottom: 0.5rem;
	}

	.field-group,
	.field-row {
		margin-bottom: 1rem;
	}

	.field-label {
		display: block;
		font-size: 0.8rem;
		color: #64748b;
		margin-bottom: 0.35rem;
	}

	.kind-toggle {
		display: flex;
		gap: 0.5rem;
	}

	.kind-toggle label {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.4rem;
		padding: 0.75rem;
		border: 1px solid rgba(0, 0, 0, 0.2);
		border-radius: 8px;
		font-size: 0.95rem;
	}

	.kind-toggle label.selected {
		font-weight: 600;
	}

	.kind-toggle__home.selected {
		border-color: var(--charge-home-color);
		background: color-mix(in srgb, var(--charge-home-color) 10%, transparent);
		color: var(--charge-home-color);
	}

	.kind-toggle__public.selected {
		border-color: var(--charge-public-color);
		background: color-mix(in srgb, var(--charge-public-color) 10%, transparent);
		color: var(--charge-public-color);
	}

	.kind-toggle input {
		margin: 0;
	}

	.draft-checkbox {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.9rem;
	}

	.draft-checkbox input {
		margin: 0;
	}

	.field-error {
		color: #b91c1c;
		font-size: 0.8rem;
		margin: 0.25rem 0 0;
	}

	.page-error {
		margin: 0 0 1rem;
	}

	.save-feedback {
		margin-top: 0.75rem;
	}

	.save-feedback__ok {
		color: #0f766e;
		font-weight: 600;
		margin: 0 0 0.25rem;
	}

	.save-feedback__warning {
		color: #b45309;
		margin: 0.25rem 0;
	}

	.save-feedback__note {
		color: #64748b;
		margin: 0.25rem 0;
	}

	.empty-state {
		color: #64748b;
	}

	.session-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.session-row {
		border: 1px solid rgba(0, 0, 0, 0.1);
		border-radius: 10px;
		padding: 0.75rem 0.9rem;
	}

	.session-row--draft {
		border-color: #f59e0b;
		border-style: dashed;
	}

	.complete-form {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		margin-top: 0.6rem;
	}

	.complete-form__field {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		color: #334155;
	}

	.complete-form__field input {
		font-size: 1rem;
		padding: 0.55rem 0.6rem;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		font-family: inherit;
		background: #fff;
		color-scheme: light;
	}

	.complete-form__field input.invalid {
		border-color: #b91c1c;
	}

	.session-row__top {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.session-row__datetime {
		flex: 1;
		font-weight: 600;
		font-size: 0.9rem;
	}

	.delete-form {
		margin: 0;
	}

	.badge {
		display: inline-block;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		font-size: 0.7rem;
		font-weight: 700;
		text-transform: uppercase;
		background: color-mix(in srgb, var(--charge-public-color) 15%, white);
		color: var(--charge-public-color);
	}

	.badge--home {
		background: color-mix(in srgb, var(--charge-home-color) 15%, white);
		color: var(--charge-home-color);
	}

	.badge--draft {
		background: #fef3c7;
		color: #92400e;
	}

	.session-row__details {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.9rem;
		font-size: 0.85rem;
		margin-top: 0.4rem;
		color: #334155;
	}

	.session-row__meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 0.9rem;
		font-size: 0.78rem;
		margin-top: 0.35rem;
		color: #64748b;
	}

	.efficiency {
		color: #0369a1;
		font-weight: 600;
	}

	.period-label--unassigned {
		color: #b45309;
	}

	.session-row__notes {
		font-size: 0.82rem;
		color: #475569;
		margin: 0.5rem 0 0;
	}

	@media (prefers-color-scheme: dark) {
		.field-label {
			color: #94a3b8;
		}

		.kind-toggle label {
			border-color: rgba(255, 255, 255, 0.2);
		}

		.badge {
			background: color-mix(in srgb, var(--charge-public-color) 25%, black);
			color: #fff;
		}

		.badge--home {
			background: color-mix(in srgb, var(--charge-home-color) 25%, black);
			color: #fff;
		}

		.badge--draft {
			background: #78350f;
			color: #fde68a;
		}

		.empty-state {
			color: #94a3b8;
		}

		.session-row {
			border-color: rgba(255, 255, 255, 0.12);
		}

		.session-row--draft {
			border-color: #d97706;
		}

		.session-row__details {
			color: #cbd5e1;
		}

		.session-row__meta {
			color: #94a3b8;
		}

		.session-row__notes {
			color: #cbd5e1;
		}

		.complete-form__field {
			color: #94a3b8;
		}

		.complete-form__field input {
			background: #1e293b;
			border-color: rgba(255, 255, 255, 0.2);
			color: #e2e8f0;
			color-scheme: dark;
		}
	}
</style>
