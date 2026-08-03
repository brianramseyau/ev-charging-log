<script lang="ts">
	import Button, { Label } from '@smui/button';
	import Card from '@smui/card';
	import DataTable, { Head, Body, Row, Cell } from '@smui/data-table';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	function formatKwh(n: number) {
		return `${n.toFixed(2)} kWh`;
	}

	function formatCost(n: number) {
		return n.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
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

<section class="table-section">
	<h2>Home charging</h2>
	{#if data.homeSessions.length === 0}
		<p class="empty">No home sessions logged in this period.</p>
	{:else}
		<div class="table-scroll">
			<DataTable table$aria-label="Home charging sessions" style="width: 100%;">
				<Head>
					<Row>
						<Cell>Date</Cell>
						<Cell>Time</Cell>
						<Cell numeric>Odometer</Cell>
						<Cell numeric>kWh</Cell>
						<Cell>Location</Cell>
					</Row>
				</Head>
				<Body>
					{#each data.homeSessions as s (s.id)}
						<Row>
							<Cell>{s.date}</Cell>
							<Cell>{s.time}</Cell>
							<Cell numeric>{s.odometerKm.toLocaleString()}</Cell>
							<Cell numeric>{s.kwhUsed.toFixed(2)}</Cell>
							<Cell>{s.location}</Cell>
						</Row>
					{/each}
				</Body>
			</DataTable>
		</div>
	{/if}
</section>

<section class="table-section">
	<h2>Public / commercial charging</h2>
	{#if data.publicSessions.length === 0}
		<p class="empty">No public sessions logged in this period.</p>
	{:else}
		<div class="table-scroll">
			<DataTable table$aria-label="Public charging sessions" style="width: 100%;">
				<Head>
					<Row>
						<Cell>Date</Cell>
						<Cell>Time</Cell>
						<Cell numeric>Odometer</Cell>
						<Cell numeric>kWh</Cell>
						<Cell>Location</Cell>
					</Row>
				</Head>
				<Body>
					{#each data.publicSessions as s (s.id)}
						<Row>
							<Cell>{s.date}</Cell>
							<Cell>{s.time}</Cell>
							<Cell numeric>{s.odometerKm.toLocaleString()}</Cell>
							<Cell numeric>{s.kwhUsed.toFixed(2)}</Cell>
							<Cell>{s.location}</Cell>
						</Row>
					{/each}
				</Body>
			</DataTable>
		</div>
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
		color: #0f172a;
	}

	.export-link {
		display: block;
		margin: 0 0 1.5rem;
	}

	.export-link :global(.mdc-button) {
		width: 100%;
	}

	.table-section {
		margin-bottom: 1.75rem;
	}

	.table-section h2 {
		font-size: 1.05rem;
		margin: 0 0 0.6rem;
	}

	.table-scroll {
		overflow-x: auto;
	}

	.empty {
		color: #64748b;
		font-size: 0.9rem;
	}
</style>
