<script lang="ts">
	import Card, { Content } from '@smui/card';
	import { formatCompact } from '$lib/components/charts/chartUtils';
	import EfficiencyLineChart from '$lib/components/charts/EfficiencyLineChart.svelte';
	import HomePublicSplitChart from '$lib/components/charts/HomePublicSplitChart.svelte';
	import CostTrendChart from '$lib/components/charts/CostTrendChart.svelte';
	import { GOVERNMENT_RATE_PER_KM } from '$lib/dashboard';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const costPerKmDeltaCents = $derived(
		data.kpis.avgCostPerKm != null ? (data.kpis.avgCostPerKm - GOVERNMENT_RATE_PER_KM) * 100 : null
	);

	const hasAnyData = $derived(
		data.efficiencySeries.length > 0 ||
			data.periodSplits.length > 0 ||
			data.kpis.lifetimeHomeKwh > 0 ||
			data.currentPeriodStats != null
	);
</script>

<svelte:head>
	<title>Dashboard · EV Charging Log</title>
</svelte:head>

<h1 class="page-title">Dashboard</h1>

{#if !hasAnyData}
	<p class="empty-state">
		No charging sessions logged yet. Once you log a session (and it's assigned to a billing period),
		your efficiency trend, home/public split, and cost history will show up here.
	</p>
{/if}

{#if data.currentPeriodStats}
	{@const cp = data.currentPeriodStats}
	<section class="current-period">
		<h2 class="section-title">{cp.label} <span class="section-title-tag">current period</span></h2>
		<div class="kpi-row">
			<Card padded class="kpi-card">
				<Content>
					<p class="kpi-label">Home kWh so far</p>
					<p class="kpi-value">{formatCompact(cp.homeKwh)}</p>
				</Content>
			</Card>

			<Card padded class="kpi-card">
				<Content>
					<p class="kpi-label">Cost so far</p>
					<p class="kpi-value">{formatCompact(cp.homeCost, { currency: true })}</p>
				</Content>
			</Card>

			<Card padded class="kpi-card">
				<Content>
					<p class="kpi-label">% home</p>
					<p class="kpi-value">
						{cp.homePct != null ? `${Math.round(cp.homePct * 100)}%` : '—'}
					</p>
				</Content>
			</Card>

			<Card padded class="kpi-card">
				<Content>
					<p class="kpi-label">Efficiency so far</p>
					<p class="kpi-value">
						{cp.avgKwhPer100Km != null ? `${cp.avgKwhPer100Km.toFixed(2)} kWh/100km` : '—'}
					</p>
					{#if cp.avgEfficiency != null}
						<p class="kpi-subvalue">{cp.avgEfficiency.toFixed(2)} km/kWh</p>
					{/if}
				</Content>
			</Card>
		</div>
	</section>
{/if}

<section class="historical">
	<h2 class="section-title">Historical</h2>
	<p class="section-subtitle">
		Lifetime totals and completed billing periods{data.currentPeriodStats
			? ` — excludes ${data.currentPeriodStats.label}, still in progress`
			: ''}.
	</p>

	<div class="kpi-row">
		<Card padded class="kpi-card">
			<Content>
				<p class="kpi-label">Lifetime home kWh</p>
				<p class="kpi-value">{formatCompact(data.kpis.lifetimeHomeKwh)}</p>
			</Content>
		</Card>

		<Card padded class="kpi-card">
			<Content>
				<p class="kpi-label">Lifetime cost</p>
				<p class="kpi-value">{formatCompact(data.kpis.lifetimeCost, { currency: true })}</p>
			</Content>
		</Card>

		<Card padded class="kpi-card">
			<Content>
				<p class="kpi-label">Avg efficiency</p>
				<p class="kpi-value">
					{data.kpis.avgKwhPer100Km != null
						? `${data.kpis.avgKwhPer100Km.toFixed(2)} kWh/100km`
						: '—'}
				</p>
				{#if data.kpis.avgEfficiency != null}
					<p class="kpi-subvalue">{data.kpis.avgEfficiency.toFixed(2)} km/kWh</p>
				{/if}
			</Content>
		</Card>

		<Card padded class="kpi-card">
			<Content>
				<p class="kpi-label">Avg cost per kWh</p>
				<p class="kpi-value">
					{data.kpis.avgCostPerKwh != null ? `$${data.kpis.avgCostPerKwh.toFixed(2)}` : '—'}
				</p>
			</Content>
		</Card>

		<Card padded class="kpi-card">
			<Content>
				<p class="kpi-label">Avg cost per km</p>
				<p class="kpi-value">
					{data.kpis.avgCostPerKm != null ? `${(data.kpis.avgCostPerKm * 100).toFixed(2)}¢` : '—'}
				</p>
				{#if costPerKmDeltaCents != null}
					<p
						class="kpi-subvalue"
						class:kpi-good={costPerKmDeltaCents > 0}
						class:kpi-bad={costPerKmDeltaCents <= 0}
					>
						{costPerKmDeltaCents <= 0 ? '−' : '+'}{Math.abs(costPerKmDeltaCents).toFixed(2)}¢ vs {(
							GOVERNMENT_RATE_PER_KM * 100
						).toFixed(2)}¢ govt rate
					</p>
				{/if}
			</Content>
		</Card>
	</div>

	<section class="chart-card">
		<h3 class="chart-title">Efficiency over time</h3>
		<p class="chart-subtitle">km driven per kWh, per home-charging session</p>
		<EfficiencyLineChart points={data.efficiencySeries} />
	</section>

	<section class="chart-card">
		<h3 class="chart-title">Home vs public charging</h3>
		<p class="chart-subtitle">kWh by billing period</p>
		<HomePublicSplitChart periods={data.periodSplits} />
	</section>

	<section class="chart-card">
		<h3 class="chart-title">Cost per period</h3>
		<p class="chart-subtitle">Home charging cost, by billing period</p>
		<CostTrendChart periods={data.periodSplits} />
	</section>
</section>

<style>
	.page-title {
		font-size: 1.3rem;
		margin: 0 0 1rem;
	}

	.empty-state {
		background: var(--empty-surface, #f1f5f9);
		border-radius: 8px;
		padding: 0.85rem 1rem;
		font-size: 0.9rem;
		color: #475569;
		margin: 0 0 1rem;
	}

	@media (prefers-color-scheme: dark) {
		.empty-state {
			background: #1e293b;
			color: #cbd5e1;
		}
	}

	.current-period {
		margin-bottom: 1.75rem;
	}

	.historical {
		margin-bottom: 0;
	}

	.section-title {
		font-size: 1rem;
		margin: 0 0 0.5rem;
	}

	.section-title-tag {
		font-size: 0.7rem;
		font-weight: 400;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: #64748b;
	}

	.section-subtitle {
		font-size: 0.8rem;
		color: #64748b;
		margin: -0.25rem 0 0.75rem;
	}

	@media (prefers-color-scheme: dark) {
		.section-title-tag,
		.section-subtitle {
			color: #94a3b8;
		}
	}

	.kpi-row {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.75rem;
		margin-bottom: 1.25rem;
	}

	@media (min-width: 480px) {
		.kpi-row {
			grid-template-columns: repeat(2, 1fr);
		}
	}

	@media (min-width: 720px) {
		.kpi-row {
			grid-template-columns: repeat(4, 1fr);
		}
	}

	.kpi-label {
		margin: 0 0 0.25rem;
		font-size: 0.75rem;
		color: #64748b;
		text-transform: uppercase;
		letter-spacing: 0.02em;
	}

	.kpi-value {
		margin: 0;
		font-size: 1.4rem;
		font-weight: 600;
	}

	.kpi-subvalue {
		margin: 0.15rem 0 0;
		font-size: 0.75rem;
	}

	.kpi-good {
		color: #16a34a;
	}

	.kpi-bad {
		color: #dc2626;
	}

	@media (prefers-color-scheme: dark) {
		.kpi-label {
			color: #94a3b8;
		}

		.kpi-good {
			color: #4ade80;
		}

		.kpi-bad {
			color: #f87171;
		}
	}

	.chart-card {
		margin-bottom: 1.5rem;
	}

	.chart-title {
		font-size: 1rem;
		margin: 0 0 0.15rem;
	}

	.chart-subtitle {
		font-size: 0.8rem;
		color: #64748b;
		margin: 0 0 0.5rem;
	}

	@media (prefers-color-scheme: dark) {
		.chart-subtitle {
			color: #94a3b8;
		}
	}
</style>
