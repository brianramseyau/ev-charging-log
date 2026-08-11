// Session/token lifecycle for the Evnex consumer Cloud API, on top of the
// `evnex-client` npm package's `EvnexAuth`. The ONLY place in the app that
// imports `evnex-client/auth` — everything outside this file sees a plain
// token set (`EvnexTokenSet`) or a ready-built `EvnexAuth` handed back from
// `buildEvnexAuth`/`evnex-token.ts`'s `sessionFor`. See
// foundational/EVNEX-INTEGRATION-PLAN.md §4.2 and §5.6.
//
// `EvnexAuth` signs in via SRP (matching python-evnex and the Evnex mobile
// app — see the package's own README) and, once resumed from a stored
// refresh token, refreshes itself automatically: proactively before an
// access token expires, and reactively on a 401 from any API call, with
// exactly one retry. Neither of those needs this app's own polling or
// retry logic any more — `evnex-client.ts` just makes calls through the
// `EvnexAuth`/`Evnex` pair, and this file's `EvnexRefreshExpiredError` is
// the one signal that means "give up, the user needs to reconnect."
import { EvnexAuth, TokenSet, isAuthChallenge, type TokenUpdateCallback } from 'evnex-client/auth';
import { EvnexAuthError, PasswordChangeRequiredError } from 'evnex-client';

export interface EvnexTokenSet {
	/** JWT. Send as the bare `Authorization` header value — no `Bearer ` prefix (plan §4.3). */
	accessToken: string;
	refreshToken: string;
	/** ISO datetime, from the access token's own `exp` claim. */
	accessTokenExpiresAt: string;
}

/** The account has TOTP/MFA enabled, which this app deliberately doesn't support (plan §7.1). */
export class EvnexMfaRequiredError extends Error {
	constructor() {
		super(
			'This Evnex account requires two-factor authentication, which this app does not yet support.'
		);
		this.name = 'EvnexMfaRequiredError';
	}
}

/** A sign-in attempt failed (bad credentials, unknown user, etc). Not terminal — the user can retry. */
export class EvnexSignInError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'EvnexSignInError';
	}
}

/**
 * The refresh token itself is invalid, revoked, or the session otherwise can't be
 * renewed — surfaced either from a resumed session's own refresh attempt or, via
 * `evnex-client.ts`, from any API call the SDK couldn't recover with its own
 * refresh-and-retry. Terminal: no amount of retrying fixes it, only a fresh sign-in
 * (password + reconnect) can. The caller should record `lastPollStatus = 'auth_failed'`
 * and stop (plan §5.1, §6.6 step 2).
 */
export class EvnexRefreshExpiredError extends Error {
	constructor(options?: { cause?: unknown }) {
		super('The Evnex session has expired or been revoked and needs to be reconnected.', options);
		this.name = 'EvnexRefreshExpiredError';
	}
}

/** A network-level failure talking to Evnex/Cognito (DNS, timeout, connection reset, etc). Retryable. */
export class EvnexNetworkError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'EvnexNetworkError';
	}
}

/**
 * `tokens.accessToken`/`refreshToken`/`expiresAt` are optional at the type level (a
 * partially-populated resumed session), but every path that reaches here — a fresh
 * sign-in, or the SDK's own refresh — always yields all three: Cognito's
 * PASSWORD_VERIFIER/REFRESH_TOKEN_AUTH results always carry an access token, and
 * `TokenSet`'s own carry-forward logic (package `tokensFromCognito`) already handles
 * a refresh response that omits the refresh token.
 */
function toTokenSet(tokens: TokenSet): EvnexTokenSet {
	if (!tokens.accessToken || !tokens.refreshToken || !tokens.expiresAt) {
		throw new EvnexSignInError('Evnex returned an incomplete token set.');
	}
	return {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		accessTokenExpiresAt: tokens.expiresAt.toISOString()
	};
}

/**
 * Signs in with email + password, discarding the password once this returns (or
 * throws) — the caller must never persist it. Throws `EvnexMfaRequiredError` if the
 * account has TOTP enabled (this only ever arises at sign-in, never on refresh —
 * plan §4.2).
 */
export async function signIn(email: string, password: string): Promise<EvnexTokenSet> {
	const auth = new EvnexAuth();
	let result;
	try {
		result = await auth.startAuthentication(email, password);
	} catch (err) {
		if (err instanceof PasswordChangeRequiredError) {
			throw new EvnexSignInError(
				'This Evnex account requires a password change before it can sign in.',
				{ cause: err }
			);
		}
		if (err instanceof EvnexAuthError) {
			throw new EvnexSignInError(err.message, { cause: err });
		}
		throw new EvnexNetworkError('Could not reach Evnex to sign in.', { cause: err });
	}
	// Any challenge at all (SMS/TOTP MFA, a NEW_PASSWORD_REQUIRED that somehow
	// didn't throw) is treated as the one case this app deliberately doesn't support.
	if (isAuthChallenge(result)) {
		throw new EvnexMfaRequiredError();
	}
	return toTokenSet(result);
}

/**
 * Builds an `EvnexAuth` resumed from a previously stored token set, wired so every
 * token the SDK issues from here on — a proactive refresh before expiry, or a
 * reactive one after a 401 — is handed to `onTokenUpdate` before it's used for any
 * request (the package's own persist-before-publish guarantee). `evnex-token.ts`'s
 * `sessionFor` is the only caller: it supplies the `onTokenUpdate` that actually
 * writes the row back to the database, keeping this file free of any db import per
 * CLAUDE.md's layering convention.
 */
export function buildEvnexAuth(
	tokens: {
		accessToken: string | null;
		refreshToken: string | null;
		accessTokenExpiresAt: string | null;
	},
	onTokenUpdate: (tokens: EvnexTokenSet) => Promise<void>
): EvnexAuth {
	const wrappedOnTokenUpdate: TokenUpdateCallback = async (ts) => {
		await onTokenUpdate(toTokenSet(ts));
	};
	return new EvnexAuth({
		tokens: TokenSet.fromJSON({
			access_token: tokens.accessToken,
			refresh_token: tokens.refreshToken,
			expires_at: tokens.accessTokenExpiresAt
		}),
		onTokenUpdate: wrappedOnTokenUpdate
	});
}
