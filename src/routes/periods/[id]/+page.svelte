<script lang="ts">
	import { enhance } from '$app/forms';
	import Button, { Label } from '@smui/button';
	import Card from '@smui/card';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let isEmpty = $derived(data.homeSessions.length === 0 && data.publicSessions.length === 0);

	function formatKwh(n: number) {
		return `${n.toFixed(2)} kWh`;
	}

	function formatCost(n: number) {
		return `$${n.toFixed(2)}`;
	}

	function formatPercent(n: number | null) {
		return n === null ? '—' : `${(n * 100).toFixed(1)}%`;
	}
</script>

<svelte:head>
	<title>{data.period.label} — EV Charging Log</title>
</svelte:head>

<a class="back-link" href="/periods">&larr; All periods</a>

<div class="header-row">
	<div>
		<h1>{data.period.label}</h1>
		<p class="range">{data.period.startDate} – {data.period.endDate}</p>
	</div>
	{#if data.period.submittedAt}
		<span class="badge badge--submitted">Submitted</span>
	{:else}
		<span class="badge badge--pending">Not submitted</span>
	{/if}
</div>

<Card padded class="summary-card">
	<div class="summary-grid">
		<div class="summary-item">
			<span class="summary-label">Home kWh</span>
			<span class="summary-value">{formatKwh(data.totals.homeKwhTotal)}</span>
		</div>
		<div class="summary-item">
			<span class="summary-label">Home cost</span>
			<span class="summary-value">{formatCost(data.totals.homeCostTotal)}</span>
		</div>
		<div class="summary-item">
			<span class="summary-label">Public kWh</span>
			<span class="summary-value">{formatKwh(data.totals.publicKwhTotal)}</span>
		</div>
		<div class="summary-item">
			<span class="summary-label">Home %</span>
			<span class="summary-value">{formatPercent(data.totals.homePercentage)}</span>
		</div>
	</div>
</Card>

<a class="export-link" href="/periods/{data.period.id}/export" data-sveltekit-reload>
	<Button variant="raised">
		<Label>Export report (.xlsx)</Label>
	</Button>
</a>

{#if form?.error}
	<p class="form-error">{form.error}</p>
{/if}

<form method="POST" action={data.period.submittedAt ? '?/unsubmit' : '?/submit'} use:enhance>
	<Button variant="outlined" class="submit-toggle-button" style="width: 100%">
		<Label>{data.period.submittedAt ? 'Unsubmit period' : 'Mark as submitted'}</Label>
	</Button>
</form>

{#if isEmpty}
	<form
		method="POST"
		action="?/delete"
		use:enhance={() => {
			return async ({ result, update }) => {
				if (result.type === 'failure') {
					form = result.data as ActionData;
					return;
				}
				await update();
			};
		}}
	>
		<Button
			variant="outlined"
			class="delete-button"
			onclick={(e: Event) => {
				if (!confirm('Delete this billing period? This cannot be undone.')) e.preventDefault();
			}}
		>
			<Label>Delete period</Label>
		</Button>
	</form>
{/if}

<section class="table-section">
	<h2>Home charging</h2>
	{#if data.homeSessions.length === 0}
		<p class="empty">No home sessions logged in this period.</p>
	{:else}
		<ul class="session-list">
			{#each data.homeSessions as s (s.id)}
				<li class="session-row">
					<div class="session-row__top">
						<span class="session-row__datetime">{s.date} · {s.time}</span>
					</div>
					<div class="session-row__details">
						<span>{s.odometerKm.toLocaleString()} km</span>
						<span>{s.kwhUsed.toFixed(2)} kWh</span>
						<span class="session-row__location">{s.location}</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<section class="table-section">
	<h2>Public / commercial charging</h2>
	{#if data.publicSessions.length === 0}
		<p class="empty">No public sessions logged in this period.</p>
	{:else}
		<ul class="session-list">
			{#each data.publicSessions as s (s.id)}
				<li class="session-row">
					<div class="session-row__top">
						<span class="session-row__datetime">{s.date} · {s.time}</span>
					</div>
					<div class="session-row__details">
						<span>{s.odometerKm.toLocaleString()} km</span>
						<span>{s.kwhUsed.toFixed(2)} kWh</span>
						<span class="session-row__location">{s.location}</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.back-link {
		display: inline-block;
		margin-bottom: 0.75rem;
		color: #0369a1;
		text-decoration: none;
		font-size: 0.9rem;
	}

	.header-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 1rem;
	}

	h1 {
		font-size: 1.3rem;
		margin: 0;
	}

	.range {
		margin: 0.15rem 0 0;
		color: #64748b;
		font-size: 0.9rem;
	}

	.badge {
		font-size: 0.7rem;
		padding: 0.2rem 0.55rem;
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

	:global(.summary-card) {
		margin-bottom: 1rem;
	}

	.summary-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.85rem;
	}

	.summary-item {
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.summary-label {
		font-size: 0.75rem;
		color: #64748b;
	}

	.summary-value {
		font-size: 1.05rem;
		font-weight: 600;
	}

	.export-link {
		display: block;
		margin: 0 0 1.5rem;
	}

	.export-link :global(.mdc-button) {
		width: 100%;
	}

	.form-error {
		color: #b91c1c;
		font-size: 0.85rem;
		margin: 0 0 0.75rem;
	}

	:global(.delete-button) {
		width: 100%;
		margin-bottom: 1.5rem;
		color: #b91c1c !important;
	}

	:global(.submit-toggle-button) {
		margin-bottom: 1.5rem;
	}

	.table-section {
		margin-bottom: 1.75rem;
	}

	.table-section h2 {
		font-size: 1.05rem;
		margin: 0 0 0.6rem;
	}

	.empty {
		color: #64748b;
		font-size: 0.9rem;
	}

	.session-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.6rem;
	}

	.session-row {
		border: 1px solid rgba(0, 0, 0, 0.1);
		border-radius: 10px;
		padding: 0.65rem 0.9rem;
	}

	.session-row__top {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.session-row__datetime {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.session-row__details {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem 0.9rem;
		font-size: 0.85rem;
		margin-top: 0.35rem;
		color: #334155;
	}

	.session-row__location {
		word-break: break-word;
	}

	@media (prefers-color-scheme: dark) {
		.range,
		.summary-label,
		.empty {
			color: #94a3b8;
		}

		.session-row {
			border-color: rgba(255, 255, 255, 0.12);
		}

		.session-row__details {
			color: #cbd5e1;
		}
	}
</style>
