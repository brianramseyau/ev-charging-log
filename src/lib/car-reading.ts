// Browser-side helpers for the car-odometer integration: calling this app's own
// /sessions/car-odometer endpoint (never Home Assistant directly — BYD-INTEGRATION-
// PLAN.md §2 #7) and wording the hint shown under an odometer field.

/** How old the car's data can be before Read from car warns (plan §11 #2). */
export const STALE_AFTER_MINUTES = 30;

export type CarReadResult =
	| { ok: true; km: number; carReportedAt: string; match: 'current' | 'fill' | 'suggest' }
	| { ok: false; status: string; message: string; broken?: boolean };

export interface CarHint {
	tone: 'ok' | 'warning' | 'error';
	text: string;
	/** Show a "Fix in Settings" link after the text. */
	fix?: boolean;
}

/** "just now", "3 min ago", "2 hours ago", "2 days ago". */
export function formatAge(iso: string, now: Date): string {
	const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60000));
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "Tue 23 Sep", in the browser's own timezone. */
export function formatShortDate(iso: string): string {
	return new Intl.DateTimeFormat('en-AU', {
		weekday: 'short',
		day: 'numeric',
		month: 'short'
	})
		.format(new Date(iso))
		.replace(',', '');
}

export function hintFor(result: Extract<CarReadResult, { ok: true }>, now: Date): CarHint {
	if (result.match === 'fill') {
		return { tone: 'ok', text: 'From car, reported during this charge.' };
	}
	if (result.match === 'suggest') {
		return { tone: 'warning', text: 'From car — not confirmed during this charge.' };
	}
	const ageMinutes = (now.getTime() - Date.parse(result.carReportedAt)) / 60000;
	const age = formatAge(result.carReportedAt, now);
	return ageMinutes > STALE_AFTER_MINUTES
		? { tone: 'warning', text: `Car last reported ${age} — check this matches the dash.` }
		: { tone: 'ok', text: `From car, reported ${age}.` };
}

/** Mirrors the server's broken statuses: calls are paused until a successful Test. */
export function isBrokenStatusName(status: string): boolean {
	return (
		status === 'auth_failed' || status === 'companion_missing' || status === 'companion_outdated'
	);
}

export function errorHint(result: Extract<CarReadResult, { ok: false }>): CarHint {
	return {
		tone: 'error',
		text: result.message,
		fix: result.broken === true || isBrokenStatusName(result.status)
	};
}

export async function readFromCar(draftId?: number): Promise<CarReadResult> {
	try {
		const res = await fetch('/sessions/car-odometer', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(draftId == null ? {} : { draftId })
		});
		return (await res.json()) as CarReadResult;
	} catch {
		return { ok: false, status: 'unreachable', message: "Couldn't reach the app's server." };
	}
}

export type CarFillResult =
	| {
			ok: true;
			filled: number;
			suggestions: { id: number; km: number; carReportedAt: string }[];
			skipped: number;
	  }
	| { ok: false; status: string; message: string; broken?: boolean };

export async function applyCarOdometer(): Promise<CarFillResult> {
	try {
		const res = await fetch('/sessions/car-odometer?apply=1', { method: 'POST' });
		return (await res.json()) as CarFillResult;
	} catch {
		return { ok: false, status: 'unreachable', message: "Couldn't reach the app's server." };
	}
}
