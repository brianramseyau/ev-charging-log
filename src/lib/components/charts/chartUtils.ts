// Small, dependency-free helpers shared by the hand-rolled inline-SVG charts in
// this folder. See PLAN.md §5.5 and the dataviz skill for the conventions these
// follow (mark specs, tick rounding, compact figure formatting).

/** "Nice" round tick values spanning [min, max] (always includes 0 as the baseline). */
export function niceTicks(min: number, max: number, targetCount = 4): number[] {
	const lo = Math.min(0, min);
	const hi = Math.max(0, max, 0.0001);
	const rawStep = (hi - lo) / targetCount;
	const magnitude = 10 ** Math.floor(Math.log10(rawStep || 1));
	const normalized = rawStep / magnitude;
	const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	const step = niceNormalized * magnitude;

	const ticks: number[] = [];
	const start = Math.floor(lo / step) * step;
	for (let t = start; t <= hi + step * 0.001; t += step) {
		ticks.push(Math.round(t * 1000) / 1000);
	}
	return ticks;
}

/** Compact figure formatting per the dataviz mark spec: 1,284 / 12.9K / $4.2M. */
export function formatCompact(value: number, options: { currency?: boolean } = {}): string {
	const prefix = options.currency ? '$' : '';
	const abs = Math.abs(value);
	if (abs < 1000) {
		const decimals = options.currency && abs > 0 && abs < 100 ? 2 : 0;
		return prefix + value.toLocaleString(undefined, { maximumFractionDigits: decimals });
	}
	return (
		prefix +
		new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(
			value
		)
	);
}

export function formatDateShort(iso: string): string {
	const d = new Date(iso + 'T00:00:00');
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export interface LinearScale {
	(value: number): number;
}

/** Maps a value in [domainMin, domainMax] to [rangeMin, rangeMax]. */
export function linearScale(
	domainMin: number,
	domainMax: number,
	rangeMin: number,
	rangeMax: number
): LinearScale {
	const domainSpan = domainMax - domainMin || 1;
	return (value: number) => rangeMin + ((value - domainMin) / domainSpan) * (rangeMax - rangeMin);
}
