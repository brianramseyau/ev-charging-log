// Cognito sign-in and refresh for the Evnex consumer Cloud API. The ONLY place in
// the app that knows about Cognito or imports amazon-cognito-identity-js — everything
// outside this file sees a plain token set. See foundational/EVNEX-INTEGRATION-PLAN.md
// §4.2 and §5.6.
//
// Uses SRP (`authenticateUser`/`refreshSession`, i.e. USER_SRP_AUTH /
// REFRESH_TOKEN_AUTH), matching python-evnex and the Evnex mobile app. Do NOT
// substitute USER_PASSWORD_AUTH via a raw InitiateAuth call, even though it's less
// code: the app client belongs to Evnex, ALLOW_USER_PASSWORD_AUTH is an explicit
// per-client setting that is commonly left off, and SRP is demonstrably permitted
// because it's what the mobile app and python-evnex both use. Under SRP the password
// is never transmitted, only a zero-knowledge proof of it — combined with never
// persisting the password (see below), it never touches the database.
import {
	AuthenticationDetails,
	CognitoRefreshToken,
	CognitoUser,
	CognitoUserPool,
	type CognitoUserSession,
	type ICognitoStorage
} from 'amazon-cognito-identity-js';

const USER_POOL_ID = 'ap-southeast-2_zWnqo6ASv';
// This is the mobile app's Cognito client ID, not one issued to this project — it's a
// public client (no client secret) and could be rotated by Evnex at any time. There is
// no published spec for any of this; see plan §4.0.
const CLIENT_ID = 'rol3lsv2vg41783550i18r7vi';

// amazon-cognito-identity-js targets browsers and defaults to `localStorage`, which
// doesn't exist server-side. This shim only needs to survive a single sign-in/refresh
// call — the resulting tokens are persisted to the database by the caller, not by
// this library's own storage.
function memoryStorage(): ICognitoStorage {
	const store = new Map<string, string>();
	return {
		getItem: (key) => store.get(key) ?? null,
		setItem: (key, value) => void store.set(key, value),
		removeItem: (key) => void store.delete(key),
		clear: () => store.clear()
	};
}

function userPool(): CognitoUserPool {
	return new CognitoUserPool({
		UserPoolId: USER_POOL_ID,
		ClientId: CLIENT_ID,
		Storage: memoryStorage()
	});
}

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
 * The refresh token itself is invalid — expired or revoked. This is terminal: no
 * amount of retrying fixes it, only a fresh sign-in (password + reconnect) can. The
 * caller should record `lastPollStatus = 'auth_failed'` and stop (plan §5.1, §6.6 step 2).
 */
export class EvnexRefreshExpiredError extends Error {
	constructor(options?: { cause?: unknown }) {
		super('The Evnex session has expired or been revoked and needs to be reconnected.', options);
		this.name = 'EvnexRefreshExpiredError';
	}
}

/** A network-level failure talking to Cognito (DNS, timeout, connection reset, etc). Retryable. */
export class EvnexNetworkError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = 'EvnexNetworkError';
	}
}

function toTokenSet(session: CognitoUserSession, fallbackRefreshToken: string): EvnexTokenSet {
	const accessToken = session.getAccessToken();
	// Cognito only returns a new refresh token if rotation is enabled on the app
	// client; amazon-cognito-identity-js's own refreshSession already carries the
	// supplied token forward when the response omits one, but falling back here too
	// is cheap insurance against ever writing `undefined` over a live refresh token
	// (which would silently kill the integration at the next access-token expiry —
	// plan §4.2/§6.6).
	const refreshToken = session.getRefreshToken().getToken() || fallbackRefreshToken;
	return {
		accessToken: accessToken.getJwtToken(),
		refreshToken,
		accessTokenExpiresAt: new Date(accessToken.getExpiration() * 1000).toISOString()
	};
}

function isNetworkFailure(err: unknown): boolean {
	// The AWS SDK layer amazon-cognito-identity-js sits on surfaces transport
	// failures as errors without a Cognito `code` (e.g. `NetworkingError`,
	// `TimeoutError`, or a bare fetch/XHR failure) — anything with a recognizable
	// Cognito exception code is an auth decision, not a network problem.
	if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
		return false;
	}
	return true;
}

/**
 * Signs in with email + password, discarding the password once this returns (or
 * throws) — the caller must never persist it. Throws `EvnexMfaRequiredError` if the
 * account has TOTP enabled (this only ever arises at sign-in, never on refresh —
 * plan §4.2).
 */
export function signIn(email: string, password: string): Promise<EvnexTokenSet> {
	const pool = userPool();
	const cognitoUser = new CognitoUser({ Username: email, Pool: pool });
	const authDetails = new AuthenticationDetails({ Username: email, Password: password });

	return new Promise((resolve, reject) => {
		cognitoUser.authenticateUser(authDetails, {
			onSuccess: (session) => {
				try {
					// No prior refresh token exists yet on first sign-in, so there's
					// nothing to fall back to — Cognito always returns one here.
					resolve(toTokenSet(session, ''));
				} catch (err) {
					reject(err instanceof Error ? err : new EvnexSignInError(String(err)));
				}
			},
			onFailure: (err) => {
				if (isNetworkFailure(err)) {
					reject(new EvnexNetworkError('Could not reach Evnex to sign in.', { cause: err }));
				} else {
					reject(new EvnexSignInError(err?.message ?? 'Evnex sign-in failed.', { cause: err }));
				}
			},
			totpRequired: () => reject(new EvnexMfaRequiredError()),
			mfaRequired: () => reject(new EvnexMfaRequiredError()),
			mfaSetup: () => reject(new EvnexMfaRequiredError())
		});
	});
}

/**
 * Resumes a session from a refresh token — no password, no MFA prompt. Throws
 * `EvnexRefreshExpiredError` (terminal) if the refresh token itself is no longer
 * valid, or `EvnexNetworkError` (retryable) on a transport failure.
 */
export function refresh(email: string, refreshToken: string): Promise<EvnexTokenSet> {
	const pool = userPool();
	const cognitoUser = new CognitoUser({ Username: email, Pool: pool });

	return new Promise((resolve, reject) => {
		cognitoUser.refreshSession(
			new CognitoRefreshToken({ RefreshToken: refreshToken }),
			(err, session) => {
				if (err) {
					if (
						err &&
						typeof err === 'object' &&
						'code' in err &&
						(err.code === 'NotAuthorizedException' || err.code === 'UserNotFoundException')
					) {
						reject(new EvnexRefreshExpiredError({ cause: err }));
					} else if (isNetworkFailure(err)) {
						reject(
							new EvnexNetworkError('Could not reach Evnex to refresh the session.', { cause: err })
						);
					} else {
						reject(new EvnexRefreshExpiredError({ cause: err }));
					}
					return;
				}
				try {
					resolve(toTokenSet(session as CognitoUserSession, refreshToken));
				} catch (e) {
					reject(e instanceof Error ? e : new EvnexRefreshExpiredError({ cause: e }));
				}
			}
		);
	});
}
