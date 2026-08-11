// Session construction and terminal-failure recording for the Evnex integration.
// Not a "pure" module in the sense the rest of src/lib/server/*.ts is (CLAUDE.md's
// layering convention keeps db imports confined to +page.server.ts) — this is a
// deliberate, narrow exception so the two things a caller needs a database for
// (persisting every token the SDK issues, and recording a terminal auth failure)
// exist in exactly one place instead of copies that could drift apart.
import { eq } from 'drizzle-orm';
import { db } from './db';
import { evnexIntegration } from './db/schema';
import { buildEvnexAuth, type EvnexRefreshExpiredError } from './evnex-auth';
import type { EvnexAuth } from 'evnex-client/auth';

type EvnexIntegrationRow = typeof evnexIntegration.$inferSelect;

function eqId(id: number) {
	return eq(evnexIntegration.id, id);
}

/**
 * Builds an `EvnexAuth` resumed from `row`'s stored tokens, with `onTokenUpdate`
 * wired to persist every token the SDK issues from here on back to this same row —
 * a proactive refresh before expiry, or a reactive one after a 401, both handled
 * entirely inside the SDK (see evnex-auth.ts). Pass the result to
 * `clientFor` (evnex-client.ts) to make API calls.
 */
export function sessionFor(row: EvnexIntegrationRow): EvnexAuth {
	return buildEvnexAuth(
		{
			accessToken: row.accessToken,
			refreshToken: row.refreshToken,
			accessTokenExpiresAt: row.accessTokenExpiresAt
		},
		async (tokens) => {
			await db
				.update(evnexIntegration)
				.set({
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					accessTokenExpiresAt: tokens.accessTokenExpiresAt
				})
				.where(eqId(row.id));
		}
	);
}

/**
 * Records a terminal `EvnexRefreshExpiredError` — caught by the caller from a
 * `sessionFor`-backed API call — as `lastPollStatus = 'auth_failed'`, so `/settings`
 * shows the Reconnect prompt (plan §7.1).
 */
export async function recordAuthFailure(id: number, err: EvnexRefreshExpiredError): Promise<void> {
	await db
		.update(evnexIntegration)
		.set({
			lastPollStatus: 'auth_failed',
			lastPollError: err.message,
			lastPolledAt: new Date().toISOString()
		})
		.where(eqId(id));
}
