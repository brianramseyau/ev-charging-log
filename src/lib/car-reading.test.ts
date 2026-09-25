import { describe, expect, it } from 'vitest';
import { formatAge, hintFor } from './car-reading';

const NOW = new Date('2026-09-24T09:00:00Z');

describe('formatAge', () => {
	it.each([
		['2026-09-24T08:59:50Z', 'just now'],
		['2026-09-24T08:57:00Z', '3 min ago'],
		['2026-09-24T08:00:00Z', '1 hour ago'],
		['2026-09-24T05:00:00Z', '4 hours ago'],
		['2026-09-22T09:00:00Z', '2 days ago']
	])('%s → %s', (iso, expected) => {
		expect(formatAge(iso, NOW)).toBe(expected);
	});
});

describe('hintFor', () => {
	it('is a plain hint for a fresh current reading', () => {
		expect(
			hintFor({ ok: true, match: 'current', km: 1, carReportedAt: '2026-09-24T08:57:00Z' }, NOW)
		).toEqual({ tone: 'ok', text: 'From car, reported 3 min ago.' });
	});

	it('warns once the car data is more than 30 minutes old', () => {
		expect(
			hintFor({ ok: true, match: 'current', km: 1, carReportedAt: '2026-09-24T08:29:00Z' }, NOW)
		).toMatchObject({ tone: 'warning' });
		expect(
			hintFor({ ok: true, match: 'current', km: 1, carReportedAt: '2026-09-22T09:00:00Z' }, NOW)
				.text
		).toBe('Car last reported 2 days ago — check this matches the dash.');
	});

	it('says whether a draft reading was confirmed during the charge', () => {
		expect(
			hintFor({ ok: true, match: 'fill', km: 1, carReportedAt: '2026-09-20T08:00:00Z' }, NOW)
		).toMatchObject({ tone: 'ok' });
		expect(
			hintFor({ ok: true, match: 'suggest', km: 1, carReportedAt: '2026-09-20T08:00:00Z' }, NOW)
		).toEqual({ tone: 'warning', text: 'From car — not confirmed during this charge.' });
	});
});
