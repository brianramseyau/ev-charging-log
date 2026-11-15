// Small, dependency-free helpers shared by the hand-rolled inline-SVG charts in
// this folder. See PLAN.md §5.5 and the dataviz skill for the conventions these
// follow (mark specs, tick rounding, compact figure formatting).

/**
 * "Nice" round tick values spanning [min, max]. Includes 0 as the baseline by
 * default (appropriate for magnitude charts like bars); pass `includeZero: false`
 * for trend charts that should zoom to the data's own range instead.
 */
export function niceTicks(
	min: number,
	max: number,
	targetCount = 4,
	options: { includeZero?: boolean } = {}
): number[] {
	const includeZero = options.includeZero ?? true;
	const lo = includeZero ? Math.min(0, min) : min;
	const hi = Math.max(includeZero ? 0 : min, max, lo + 0.0001);
	const rawStep = (hi - lo) / targetCount;
	const magnitude = 10 ** Math.floor(Math.log10(rawStep || 1));
	const normalized = rawStep / magnitude;
	const niceNormalized = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
	const step = niceNormalized * magnitude;

	const ticks: number[] = [];
	const start = Math.floor(lo / step) * step;
	const end = Math.ceil(hi / step) * step;
	for (let t = start; t <= end + step * 0.001; t += step) {
		const rounded = Math.round(t * 1000) / 1000;
		if (ticks[ticks.length - 1] !== rounded) ticks.push(rounded);
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

/**
 * Rough width of `text` rendered at `fontSize` in the SVG's user units. Only
 * used to decide whether axis labels would collide, so an approximation good
 * enough for the system UI sans-serif is all that's needed.
 */
export function estimateTextWidth(text: string, fontSize: number): number {
	return text.length * fontSize * 0.58;
}

export interface AxisLabelLayout {
	/** Text to render — the original label, or an ellipsised version if it's wider than the plot. */
	text: string;
	/** Centre to render the label at (nudged inwards when it would spill past the plot). */
	x: number;
	/** False when showing this label would overlap the next one that's shown. */
	visible: boolean;
}

/** Trims `label` to fit `maxWidth`, marking the cut with an ellipsis. */
export function truncateLabelToWidth(label: string, maxWidth: number, fontSize: number): string {
	if (estimateTextWidth(label, fontSize) <= maxWidth) return label;
	const charWidth = estimateTextWidth('W', fontSize);
	const maxChars = Math.max(0, Math.floor(maxWidth / charWidth) - 1);
	return maxChars > 0 ? label.slice(0, maxChars).trimEnd() + '…' : '…';
}

/**
 * Positions for an x-axis category label per entry, hiding any that would
 * overlap. Labels wider than the plot are truncated first so they can always
 * be contained. Layout walks from the end so the most recent period always
 * keeps its label, and uses the same clamped x the label is rendered at so a
 * wide final label can't be pushed into its neighbour.
 */
export function layoutAxisLabels(
	labels: string[],
	slotWidth: number,
	plotWidth: number,
	fontSize = 10,
	gap = 6
): AxisLabelLayout[] {
	const texts = labels.map((label) => truncateLabelToWidth(label, plotWidth, fontSize));
	const centres = texts.map((label, i) => {
		const centre = i * slotWidth + slotWidth / 2;
		const half = estimateTextWidth(label, fontSize) / 2;
		return Math.min(Math.max(centre, half), Math.max(plotWidth - half, plotWidth / 2));
	});
	const visible = texts.map(() => false);
	let previousLeft = Infinity;
	for (let i = texts.length - 1; i >= 0; i--) {
		const half = estimateTextWidth(texts[i], fontSize) / 2;
		if (centres[i] + half <= previousLeft - gap) {
			visible[i] = true;
			previousLeft = centres[i] - half;
		}
	}
	return centres.map((x, i) => ({ text: texts[i], x, visible: visible[i] }));
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
