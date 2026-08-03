<script lang="ts">
	import { formatCompact, linearScale, niceTicks } from './chartUtils';
	import type { PeriodSplit } from '$lib/dashboard';

	let { periods }: { periods: PeriodSplit[] } = $props();

	const width = 343;
	const height = 220;
	const margin = { top: 12, right: 8, bottom: 32, left: 40 };
	const plotWidth = width - margin.left - margin.right;
	const plotHeight = height - margin.top - margin.bottom;
	const maxBarThickness = 24;

	let hoveredIndex = $state<number | null>(null);

	const costs = $derived(periods.map((p) => p.homeCost));
	const yMax = $derived(costs.length ? Math.max(...costs) : 1);
	const yTicks = $derived(niceTicks(0, yMax, 4));
	const yDomainMax = $derived(yTicks[yTicks.length - 1] ?? 1);
	const yScale = $derived(linearScale(0, yDomainMax, plotHeight, 0));

	const slotWidth = $derived(periods.length ? plotWidth / periods.length : plotWidth);
	const barWidth = $derived(Math.min(maxBarThickness, slotWidth * 0.6));

	function barX(i: number) {
		return i * slotWidth + (slotWidth - barWidth) / 2;
	}
</script>

<div class="viz-root">
	{#if periods.length === 0}
		<p class="empty">
			No billing periods yet — cost per period will show up here once you have some.
		</p>
	{:else}
		<svg
			viewBox="0 0 {width} {height}"
			role="img"
			aria-label="Home charging cost by billing period"
		>
			<g transform="translate({margin.left},{margin.top})">
				{#each yTicks as tick, i (i)}
					<line x1="0" x2={plotWidth} y1={yScale(tick)} y2={yScale(tick)} class="gridline" />
					<text x="-8" y={yScale(tick)} class="tick-label" text-anchor="end" dy="0.32em"
						>{formatCompact(tick, { currency: true })}</text
					>
				{/each}

				{#each periods as p, i (p.periodId)}
					{@const x = barX(i)}
					{@const top = yScale(p.homeCost)}
					{@const barHeight = plotHeight - top}
					<rect
						{x}
						y={top}
						width={barWidth}
						height={Math.max(barHeight, 0)}
						rx="4"
						class="bar"
						class:bar--hover={hoveredIndex === i}
						role="button"
						tabindex="0"
						onpointerenter={() => (hoveredIndex = i)}
						onpointerleave={() => (hoveredIndex = null)}
						onfocus={() => (hoveredIndex = i)}
						onblur={() => (hoveredIndex = null)}
					/>
					<text
						x={i * slotWidth + slotWidth / 2}
						y={plotHeight + 16}
						class="tick-label"
						text-anchor="middle">{p.label}</text
					>
				{/each}
			</g>
		</svg>

		{#if hoveredIndex != null}
			<div class="tooltip" role="status">
				<strong>{formatCompact(periods[hoveredIndex].homeCost, { currency: true })}</strong>
				<span>{periods[hoveredIndex].label}</span>
			</div>
		{/if}

		<table class="sr-only-table">
			<caption>Home charging cost by billing period</caption>
			<thead>
				<tr>
					<th scope="col">Period</th>
					<th scope="col">Cost</th>
				</tr>
			</thead>
			<tbody>
				{#each periods as p (p.periodId)}
					<tr>
						<td>{p.label}</td>
						<td>{p.homeCost.toFixed(2)}</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
</div>

<style>
	.viz-root {
		color-scheme: light;
		--surface-1: #fcfcfb;
		--text-primary: #0b0b0b;
		--text-secondary: #52514e;
		--text-muted: #898781;
		--gridline: #e1e0d9;
		--series-1: var(--charge-home-color);
		position: relative;
	}

	@media (prefers-color-scheme: dark) {
		.viz-root {
			color-scheme: dark;
			--surface-1: #1a1a19;
			--text-primary: #ffffff;
			--text-secondary: #c3c2b7;
			--text-muted: #898781;
			--gridline: #2c2c2a;
		}
	}

	svg {
		width: 100%;
		height: auto;
		display: block;
	}

	.gridline {
		stroke: var(--gridline);
		stroke-width: 1;
	}

	.tick-label {
		fill: var(--text-muted);
		font-size: 10px;
	}

	.bar {
		fill: var(--series-1);
		cursor: pointer;
		outline: none;
	}

	.bar--hover {
		filter: brightness(1.12);
	}

	.empty {
		color: var(--text-secondary);
		font-size: 0.9rem;
		margin: 0;
	}

	.tooltip {
		position: absolute;
		top: 8px;
		right: 8px;
		background: var(--surface-1);
		border: 1px solid var(--gridline);
		border-radius: 6px;
		padding: 4px 8px;
		font-size: 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 2px;
		pointer-events: none;
		color: var(--text-primary);
	}

	.tooltip span {
		color: var(--text-secondary);
	}

	.sr-only-table {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
