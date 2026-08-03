<script lang="ts">
	import { formatDateShort, linearScale, niceTicks } from './chartUtils';
	import type { EfficiencyPoint } from '$lib/dashboard';

	let { points }: { points: EfficiencyPoint[] } = $props();

	const width = 343;
	const height = 220;
	const margin = { top: 12, right: 12, bottom: 24, left: 34 };
	const plotWidth = width - margin.left - margin.right;
	const plotHeight = height - margin.top - margin.bottom;

	let hoveredIndex = $state<number | null>(null);

	const values = $derived(points.map((p) => p.kmPerKwh));
	const yMin = $derived(values.length ? Math.min(...values) : 0);
	const yMax = $derived(values.length ? Math.max(...values) : 1);
	const yTicks = $derived(niceTicks(yMin, yMax, 4));
	const yDomainMin = $derived(yTicks[0] ?? 0);
	const yDomainMax = $derived(yTicks[yTicks.length - 1] ?? 1);

	const xScale = $derived(linearScale(0, Math.max(points.length - 1, 1), 0, plotWidth));
	const yScale = $derived(linearScale(yDomainMin, yDomainMax, plotHeight, 0));

	const linePath = $derived(
		points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xScale(i)} ${yScale(p.kmPerKwh)}`).join(' ')
	);

	const hovered = $derived(hoveredIndex != null ? points[hoveredIndex] : null);

	function handlePointerMove(event: PointerEvent) {
		if (points.length === 0) return;
		const svg = event.currentTarget as SVGSVGElement;
		const rect = svg.getBoundingClientRect();
		const localX = ((event.clientX - rect.left) / rect.width) * width - margin.left;
		let nearest = 0;
		let nearestDist = Infinity;
		for (let i = 0; i < points.length; i++) {
			const dist = Math.abs(xScale(i) - localX);
			if (dist < nearestDist) {
				nearestDist = dist;
				nearest = i;
			}
		}
		hoveredIndex = nearest;
	}

	function handlePointerLeave() {
		hoveredIndex = null;
	}
</script>

<div class="viz-root">
	{#if points.length === 0}
		<p class="empty">Not enough charging history yet to plot an efficiency trend.</p>
	{:else}
		<svg
			viewBox="0 0 {width} {height}"
			role="img"
			aria-label="Efficiency trend, kilometres per kilowatt-hour, over time"
			onpointermove={handlePointerMove}
			onpointerleave={handlePointerLeave}
		>
			<g transform="translate({margin.left},{margin.top})">
				{#each yTicks as tick (tick)}
					<line x1="0" x2={plotWidth} y1={yScale(tick)} y2={yScale(tick)} class="gridline" />
					<text x="-8" y={yScale(tick)} class="tick-label" text-anchor="end" dy="0.32em"
						>{tick}</text
					>
				{/each}

				<path d={linePath} class="line" fill="none" />

				{#each points as p, i (p.sessionId)}
					<circle
						cx={xScale(i)}
						cy={yScale(p.kmPerKwh)}
						r={i === hoveredIndex || i === points.length - 1 ? 5 : 3}
						class="dot"
						class:dot--end={i === points.length - 1}
					/>
				{/each}

				{#if points.length > 0}
					<text x={xScale(0)} y={plotHeight + 16} class="tick-label" text-anchor="start"
						>{formatDateShort(points[0].date)}</text
					>
					<text
						x={xScale(points.length - 1)}
						y={plotHeight + 16}
						class="tick-label"
						text-anchor="end">{formatDateShort(points[points.length - 1].date)}</text
					>
				{/if}

				{#if hovered}
					<line
						x1={xScale(hoveredIndex ?? 0)}
						x2={xScale(hoveredIndex ?? 0)}
						y1="0"
						y2={plotHeight}
						class="crosshair"
					/>
				{/if}
			</g>
		</svg>

		{#if hovered}
			<div class="tooltip" role="status">
				<strong>{hovered.kmPerKwh.toFixed(2)} km/kWh</strong>
				<span>{formatDateShort(hovered.date)}</span>
			</div>
		{/if}

		<table class="sr-only-table">
			<caption>Efficiency by charging session</caption>
			<thead>
				<tr>
					<th scope="col">Date</th>
					<th scope="col">km/kWh</th>
				</tr>
			</thead>
			<tbody>
				{#each points as p (p.sessionId)}
					<tr>
						<td>{p.date}</td>
						<td>{p.kmPerKwh.toFixed(2)}</td>
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
		}
	}

	svg {
		width: 100%;
		height: auto;
		display: block;
		touch-action: pan-y;
	}

	.gridline {
		stroke: var(--gridline);
		stroke-width: 1;
	}

	.tick-label {
		fill: var(--text-muted);
		font-size: 10px;
	}

	.line {
		stroke: var(--series-1);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}

	.dot {
		fill: var(--series-1);
		stroke: var(--surface-1);
		stroke-width: 2;
	}

	.crosshair {
		stroke: var(--text-muted);
		stroke-width: 1;
		stroke-dasharray: none;
	}

	.empty {
		color: var(--text-secondary, #52514e);
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
