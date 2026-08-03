<script lang="ts">
	import { enhance } from '$app/forms';
	import Button, { Label } from '@smui/button';
	import Card from '@smui/card';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let showForm = $state(false);

	function formatRange(startDate: string, endDate: string) {
		return `${startDate} – ${endDate}`;
	}
</script>

<svelte:head>
	<title>Billing periods — EV Charging Log</title>
</svelte:head>

<h1>Billing periods</h1>

<div class="toolbar">
	<Button variant="raised" onclick={() => (showForm = !showForm)}>
		<Label>{showForm ? 'Cancel' : 'Add period'}</Label>
	</Button>
</div>

{#if showForm}
	<Card padded class="add-card">
		<form
			method="POST"
			action="?/create"
			use:enhance={() => {
				return async ({ result, update }) => {
					await update();
					if (result.type === 'success') showForm = false;
				};
			}}
		>
			{#if form?.error}
				<p class="form-error">{form.error}</p>
			{/if}
			<label class="field">
				<span>Label</span>
				<input
					type="text"
					name="label"
					placeholder="e.g. July 2026"
					value={form?.label ?? ''}
					required
				/>
			</label>
			<label class="field">
				<span>Start date</span>
				<input type="date" name="startDate" value={form?.startDate ?? ''} required />
			</label>
			<label class="field">
				<span>End date</span>
				<input type="date" name="endDate" value={form?.endDate ?? ''} required />
			</label>
			<Button variant="raised" type="submit">
				<Label>Save period</Label>
			</Button>
		</form>
	</Card>
{/if}

{#if data.periods.length === 0}
	<p class="empty">No billing periods yet. Add one to start logging sessions against it.</p>
{:else}
	<ul class="period-list">
		{#each data.periods as period (period.id)}
			<li>
				<a class="period-card" href="/periods/{period.id}">
					<Card padded>
						<div class="period-card__row">
							<strong>{period.label}</strong>
							{#if period.submittedAt}
								<span class="badge badge--submitted">Submitted</span>
							{:else}
								<span class="badge badge--pending">Not submitted</span>
							{/if}
						</div>
						<div class="period-card__range">{formatRange(period.startDate, period.endDate)}</div>
					</Card>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<style>
	h1 {
		font-size: 1.3rem;
		margin: 0 0 1rem;
	}

	.toolbar {
		margin-bottom: 1rem;
	}

	:global(.add-card) {
		margin-bottom: 1.25rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.3rem;
		font-size: 0.85rem;
		color: #334155;
	}

	.field input {
		font-size: 1rem;
		padding: 0.55rem 0.6rem;
		border: 1px solid #cbd5e1;
		border-radius: 6px;
		font-family: inherit;
	}

	.form-error {
		color: #b91c1c;
		font-size: 0.85rem;
		margin: 0;
	}

	.empty {
		color: #64748b;
	}

	.period-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.period-card {
		text-decoration: none;
		color: inherit;
		display: block;
	}

	.period-card__row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
	}

	.period-card__range {
		color: #64748b;
		font-size: 0.85rem;
		margin-top: 0.25rem;
	}

	.badge {
		font-size: 0.7rem;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
		white-space: nowrap;
	}

	.badge--submitted {
		background: #dcfce7;
		color: #166534;
	}

	.badge--pending {
		background: #fef3c7;
		color: #92400e;
	}
</style>
