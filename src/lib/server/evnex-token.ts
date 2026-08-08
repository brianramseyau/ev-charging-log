// Shared access-token lifecycle management for the two routes that need it
// (/settings and the /sessions poll action). Not a "pure" module in the sense the
// rest of src/lib/server/*.ts is (CLAUDE.md's layering convention keeps db imports
// confined to +page.server.ts) — this is a deliberate, narrow exception so the
// terminal-refresh-failure handling (persisting `lastPollStatus = 'auth_failed'`)
// exists in exactly one place instead of two copies that could drift apart, since
// getting this subtly wrong twice is a real risk (plan §5.1, §6.6 step 2).
import { eq } from 'drizzle-orm';
import { db } from './db';
import { evnexIntegration } from './db/schema';
import { EvnexRefreshExpiredError, refresh as evnexRefresh } from './evnex-auth';
import { isTokenExpired } from './evnex';

type EvnexIntegrationRow = typeof evnexIntegration.$inferSelect;

function eqId(id: number) {
	return eq(evnexIntegration.id, id);
}

/**
 * Refreshes unconditionally and persists the result. On a terminal failure (the
 * refresh token itself is invalid), records `lastPollStatus = 'auth_failed'` so
 * `/settings` shows the Reconnect prompt (plan §7.1), then rethrows.
 */
export async function refreshAndPersist(row: EvnexIntegrationRow): Promise<string> {
	if (row.refreshToken == null) {
		throw new EvnexRefreshExpiredError();
	}
	try {
		const tokenSet = await evnexRefresh(row.email ?? '', row.refreshToken);
		await db
			.update(evnexIntegration)
			.set({
				accessToken: tokenSet.accessToken,
				refreshToken: tokenSet.refreshToken,
				accessTokenExpiresAt: tokenSet.accessTokenExpiresAt
			})
			.where(eqId(row.id));
		return tokenSet.accessToken;
	} catch (err) {
		if (err instanceof EvnexRefreshExpiredError) {
			await db
				.update(evnexIntegration)
				.set({
					lastPollStatus: 'auth_failed',
					lastPollError: err.message,
					lastPolledAt: new Date().toISOString()
				})
				.where(eqId(row.id));
		}
		throw err;
	}
}

/**
 * Ensures a usable access token for `row`, refreshing it first only if it's expired
 * (or about to be — `isTokenExpired`'s clock-skew margin, plan §6.6 step 2).
 */
export async function ensureAccessToken(row: EvnexIntegrationRow): Promise<string> {
	if (row.refreshToken == null) {
		throw new EvnexRefreshExpiredError();
	}
	if (!isTokenExpired(row.accessTokenExpiresAt, new Date())) {
		return row.accessToken as string;
	}
	return refreshAndPersist(row);
}
