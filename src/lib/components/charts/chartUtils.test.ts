import { describe, expect, it } from 'vitest';
import { estimateTextWidth, layoutAxisLabels } from './chartUtils';

const MONTHS = [
	'May 2026',
	'June 2026',
	'July 2026',
	'August 2026',
	'September 2026',
	'October 2026',
	'November 2026'
];

describe('layoutAxisLabels', () => {
	it('shows every label when they fit side by side', () => {
		const labels = ['Jan 2026', 'Feb 2026', 'Mar 2026'];
		const layout = layoutAxisLabels(labels, 120, 360);
		expect(layout.map((l) => l.visible)).toEqual([true, true, true]);
	});

	it('always shows the most recent label and hides neighbours that would overlap', () => {
		const layout = layoutAxisLabels(MONTHS, 43, 301);
		expect(layout[layout.length - 1].visible).toBe(true);
		expect(layout.some((label) => !label.visible)).toBe(true);
	});

	it('keeps every shown label fully inside the plot', () => {
		const plotWidth = 301;
		const layout = layoutAxisLabels(MONTHS, 43, plotWidth);
		layout.forEach((label, i) => {
			if (!label.visible) return;
			const half = estimateTextWidth(MONTHS[i], 10) / 2;
			expect(label.x - half).toBeGreaterThanOrEqual(0);
			expect(label.x + half).toBeLessThanOrEqual(plotWidth);
		});
	});

	it('leaves a gap between every pair of shown labels', () => {
		const plotWidth = 301;
		const layout = layoutAxisLabels(MONTHS, 43, plotWidth);
		const shown = layout.flatMap((label, i) => (label.visible ? [i] : []));
		for (let k = 1; k < shown.length; k++) {
			const previous = shown[k - 1];
			const current = shown[k];
			const previousRight = layout[previous].x + estimateTextWidth(MONTHS[previous], 10) / 2;
			const currentLeft = layout[current].x - estimateTextWidth(MONTHS[current], 10) / 2;
			expect(currentLeft).toBeGreaterThan(previousRight);
		}
	});

	it('returns an empty array for no labels', () => {
		expect(layoutAxisLabels([], 100, 300)).toEqual([]);
	});
});
