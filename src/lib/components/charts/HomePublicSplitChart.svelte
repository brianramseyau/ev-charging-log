<script lang="ts">
	import { formatCompact, linearScale, niceTicks } from './chartUtils';
	import type { PeriodSplit } from '$lib/dashboard';

	let { periods }: { periods: PeriodSplit[] } = $props();

	const width = 343;
	const height = 240;
	const margin = { top: 12, right: 8, bottom: 32, left: 34 };
	const plotWidth = width - margin.left - margin.right;
	const plotHeight = height - margin.top - margin.bottom;
	const barGap = 2; // surface gap between the two stacked segments
	const maxBarThickness = 24;

	let hovered = $state<{ periodId: number; kind: 'home' | 'public' } | null>(null);

	const totals = $derived(periods.map((p) => p.homeKwh + p.publicKwh));
	const yMax = $derived(totals.length ? Math.max(...totals) : 1);
	const yTicks = $derived(niceTicks(0, yMax, 4));
	const yDomainMax = $derived(yTicks[yTicks.length - 1] ?? 1);
	const yScale = $derived(linearScale(0, yDomainMax, plotHeight, 0));

	const slotWidth = $derived(periods.length ? plotWidth / periods.length : plotWidth);
	const barWidth = $derived(Math.min(maxBarThickness, slotWidth * 0.6));

	function barX(i: number) {
		return i * slotWidth + (slotWidth - barWidth) / 2;
	}

	const hoveredSplit = $derived(
		hovered ? periods.find((p) => p.periodId === hovered!.periodId) : null
	);
</script>

<div class="viz-root">
	{#if periods.length === 0}
		<p class="empty">
			No billing periods yet — log a session and assign it to a period to see the split here.
		</p>
	{:else}
		<div class="legend">
			<span class="legend-item"><i class="swatch swatch--home"></i>Home</span>
			<span class="legend-item"><i class="swatch swatch--public"></i>Public</span>
		</div>

		<svg
			viewBox="0 0 {width} {height}"
			role="img"
			aria-label="Home vs public charging kWh by billing period"
		>
			<g transform="translate({margin.left},{margin.top})">
				{#each yTicks as tick (tick)}
					<line x1="0" x2={plotWidth} y1={yScale(tick)} y2={yScale(tick)} class="gridline" />
					<text x="-8" y={yScale(tick)} class="tick-label" text-anchor="end" dy="0.32em"
						>{formatCompact(tick)}</text
					>
				{/each}

				{#each periods as p, i (p.periodId)}
					{@const x = barX(i)}
					{@const homeTop = yScale(p.homeKwh)}
					{@const homeHeight = plotHeight - homeTop}
					{@const publicTop = yScale(p.homeKwh + p.publicKwh)}
					{@const publicHeight = Math.max(homeTop - publicTop - barGap, 0)}
					<g>
						{#if p.homeKwh > 0}
							<rect
								{x}
								y={homeTop}
								width={barWidth}
								height={homeHeight}
								rx="4"
								class="seg seg--home"
								class:seg--hover={hovered?.periodId === p.periodId && hovered.kind === 'home'}
								role="button"
								tabindex="0"
								onpointerenter={() => (hovered = { periodId: p.periodId, kind: 'home' })}
								onpointerleave={() => (hovered = null)}
								onfocus={() => (hovered = { periodId: p.periodId, kind: 'home' })}
								onblur={() => (hovered = null)}
							/>
						{/if}
						{#if p.publicKwh > 0}
							<rect
								{x}
								y={publicTop}
								width={barWidth}
								height={publicHeight}
								rx="4"
								class="seg seg--public"
								class:seg--hover={hovered?.periodId === p.periodId && hovered.kind === 'public'}
								role="button"
								tabindex="0"
								onpointerenter={() => (hovered = { periodId: p.periodId, kind: 'public' })}
								onpointerleave={() => (hovered = null)}
								onfocus={() => (hovered = { periodId: p.periodId, kind: 'public' })}
								onblur={() => (hovered = null)}
							/>
						{/if}
					</g>
					<text
						x={i * slotWidth + slotWidth / 2}
						y={plotHeight + 16}
						class="tick-label"
						text-anchor="middle">{p.label}</text
					>
				{/each}
			</g>
		</svg>

		{#if hoveredSplit && hovered}
			<div class="tooltip" role="status">
				<strong
					>{formatCompact(hovered.kind === 'home' ? hoveredSplit.homeKwh : hoveredSplit.publicKwh)} kWh</strong
				>
				<span>{hovered.kind === 'home' ? 'Home' : 'Public'} · {hoveredSplit.label}</span>
			</div>
		{/if}

		<table class="sr-only-table">
			<caption>Home vs public charging kWh by billing period</caption>
			<thead>
				<tr>
					<th scope="col">Period</th>
					<th scope="col">Home kWh</th>
					<th scope="col">Public kWh</th>
				</tr>
			</thead>
			<tbody>
				{#each periods as p (p.periodId)}
					<tr>
						<td>{p.label}</td>
						<td>{p.homeKwh.toFixed(1)}</td>
						<td>{p.publicKwh.toFixed(1)}</td>
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
		--series-1: #2a78d6;
		--series-2: #eb6834;
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
			--series-1: #3987e5;
			--series-2: #d95926;
		}
	}

	svg {
		width: 100%;
		height: auto;
		display: block;
	}

	.legend {
		display: flex;
		gap: 12px;
		font-size: 0.78rem;
		color: var(--text-secondary);
		margin-bottom: 6px;
	}

	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}

	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		display: inline-block;
	}

	.swatch--home {
		background: var(--series-1);
	}

	.swatch--public {
		background: var(--series-2);
	}

	.gridline {
		stroke: var(--gridline);
		stroke-width: 1;
	}

	.tick-label {
		fill: var(--text-muted);
		font-size: 10px;
	}

	.seg {
		fill: var(--series-1);
		cursor: pointer;
		outline: none;
	}

	.seg--public {
		fill: var(--series-2);
	}

	.seg--hover {
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
