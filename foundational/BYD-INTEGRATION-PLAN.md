# BYD Vehicle Integration — Design & Implementation Plan

Status: **scoped, not started. Phase 0 (a throwaway spike against the real
account, §11) has to happen before any app code.** Several of the answers
below are marked _verify in spike_ because only the real car can settle them.
Branch: `claude/byd-car-km-integration-pd6prj`

Builds on [EVNEX-INTEGRATION-PLAN.md](EVNEX-INTEGRATION-PLAN.md), which already
made the odometer nullable, added the draft-session flow, and set the pattern
for an unofficial third-party API (a separate typed client package, pure logic
in `src/lib/server/`, credentials entered through `/settings`). This plan
reuses all of that. See [§13](#13-documentation-to-update) for the
documentation edits owed once it lands.

---

## 1. Why

Since the Evnex integration, a home session arrives as a draft that already has
date, time, kWh and location. The one thing left to type is the **odometer**,
and the charger has no way to know it. The car does: BYD's cloud reports the
odometer (`totalMileage`) to the BYD app, and that API has been
reverse-engineered by the Home Assistant community.

Goal: **fill in the odometer from the car so a home session needs no typing at
all**, and let a manually-logged public session fetch the reading with a tap
instead of the user reading the dash.

Non-goals: remote control (lock, climate and so on), GPS/location, battery %,
range, tyre pressure, and anything else the BYD API offers. This integration
reads one number.

## 2. Proposed decisions

These are the defaults the rest of the document is written against. Items 2
and 3 need a decision from you (§12, #1 and #2); the rest follow from how the
API works.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Read-only, odometer only.** No control PIN is ever asked for or stored, and no command endpoint is ever called. The client package won't even contain command code (§5).                                                                                                                                                                                                                                                                                        |
| 2   | **The app uses a dedicated BYD account, shared from the owner's account with the least permissions that still expose vehicle status.** In practice this isn't optional. BYD allows one live session per account, so this app signing in would log the phone app out (the HA integration's README gives the same warning), and §4.3 means that would happen on every re-login. A shared account also limits the damage if its stored password (item 3) ever leaks. |
| 3   | **The BYD password is persisted**, unlike the Evnex password. The BYD login has no refresh token (§4.3): when the session expires, the only way back in is a fresh login, and that needs the password in plaintext. The alternative is asking for the password every time the session lapses (§12 #1).                                                                                                                                                            |
| 4   | **A car reading is only written to a session automatically when it provably belongs to that session.** That means the car reported it while that charge was running (§7.2). Any other reading is shown in the odometer field as a pre-filled suggestion that the user confirms. Odometer values end up on the lease report, and the user has already been caught out by mistyped data (commit `946adcb`), so a silently wrong value is worse than an empty one.   |
| 5   | **The API calls go in a separate `byd-client` npm package**, a TypeScript port of the relevant parts of [`jkaberg/pyBYD`](https://github.com/jkaberg/pyBYD). This follows the `evnex-client` / `typescript-evnex` precedent, keeping the crypto and wire format out of this app. The app then gets `byd.ts` (pure logic), `byd-auth.ts`/`byd-client.ts` (impure edges) and `byd-token.ts` (the one DB-touching helper), mirroring the Evnex files one-for-one.    |
| 6   | **No background polling in the first release.** Reads happen when the user asks: the **Read from car** button, and a car read piggybacked on **Pull from charger**. A background sampler that can fill drafts with no interaction is Phase 6, gated on the spike's battery-drain and data-freshness findings (§12 #3).                                                                                                                                            |
| 7   | **No new deployment configuration.** As with Evnex, it's configured entirely through `/settings`, identically on Docker/Unraid and the Electron build.                                                                                                                                                                                                                                                                                                            |

## 3. What the user does, end to end

One-time setup:

1. In the BYD app, creates (or reuses) a second BYD account and shares the car
   with it from the owner account (§4.8). The README will cover this step.
2. Opens `/settings`, finds a new **BYD vehicle** heading below the Evnex one,
   and enters that account's email/phone, password, and country (default
   Australia).
3. The app signs in, generates and stores a device fingerprint (§4.7), and lists
   the vehicles on the account. The user picks theirs (usually the only one).
   A **Test read** button shows the current odometer and when the car reported
   it, so the user can check it matches the dash before trusting it.
4. Switches the integration on and saves.

Day to day:

- **Home, with Evnex:** taps **Pull from charger** on `/sessions` as today.
  Once the Evnex import finishes, the page also reads the car. New drafts whose
  charge window contains the car's reading get their odometer filled in and
  complete with no typing at all. Other drafts get a **From car** suggestion in
  their _Add odometer_ field (§8.2).
- **Public, or home without Evnex:** in the Add form, taps **Read from car**
  next to the Odometer field. The field fills with the reading and a hint
  saying how old it is. The user saves as normal.

---

## 4. API contract

### 4.0 This API is unofficial, and more fragile than Evnex's

There is no published spec. Everything here comes from `pyBYD` (MIT, used by
[`jkaberg/hass-byd-vehicle`](https://github.com/jkaberg/hass-byd-vehicle),
which pins `pybyd==0.0.75`). It's cross-checked against
[`TA2k/ioBroker.byd`](https://github.com/TA2k/ioBroker.byd) (MIT, a JavaScript
implementation), and both credit
[`Niek/BYD-re`](https://github.com/Niek/BYD-re) for the original reverse
engineering.

It's riskier than Evnex in ways that matter for planning:

- **The transport is obfuscated.** The API isn't plain JSON over HTTPS. Every
  request and response is wrapped in a "Bangcle" envelope encrypted with a
  white-box AES whose lookup tables were extracted from BYD's Android native
  library (§4.2). If BYD rotates those tables in an app update, every client
  breaks until someone extracts new ones. We can't fix that ourselves.
- **The client pretends to be a specific app version on a specific phone.**
  `pyBYD` bumps its `appVersion` string regularly (its latest commit is "bump
  byd app version"). An outdated version string could be rejected
  server-side, which means an occasional forced upgrade of `byd-client`.
- **Using it is almost certainly against BYD's terms.** The realistic worst
  case is the account being banned. Using a dedicated shared account (§2 #2)
  confines that to an account nobody else uses.
- **Field meanings are still being mapped upstream** (the HA README links
  pyBYD issue #20). The odometer field itself is well established across all
  three projects (HA exposes it as a sensor, and ioBroker's captured
  vehicle-list sample includes `"totalMileage": 13060`), but its units and
  sentinel values need defensive handling (§4.5).

### 4.1 Endpoints and region

The API host is chosen per region. For Australia (HA's `NODE_METADATA` node 3):

|                  | Value                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| Base URL         | `https://dilinkappoversea-au.byd.auto`                                                                    |
| Country code     | `AU`                                                                                                      |
| Transport        | `POST {base}{endpoint}`, body `{"request": "<Bangcle envelope>"}`                                         |
| Required headers | `content-type: application/json; charset=UTF-8`, `user-agent: okhttp/4.12.0`, `accept-encoding: identity` |
| Cookies          | Kept across calls in a cookie jar (pyBYD relies on its session's jar)                                     |

Store the base URL and country together as a `region` choice. Don't make them
free-text: getting the region wrong shows up as an _authentication_ failure,
not a clear error (HA's troubleshooting tip is "verify credentials first, then
verify selected country").

### 4.2 Wire format: four layers

Taken from pyBYD's `_transport.py`, `_api/login.py`, `_api/_envelope.py` and
`_crypto/*`:

1. **Inner payload.** A JSON object of request fields (VIN, timestamps, a
   random nonce, device fields), encrypted with standard AES-128-CBC, zero IV,
   PKCS7, uppercase hex, and sent as `encryData`.
   - Login key: `MD5(MD5(password))` (uppercase hex).
   - Post-login key ("content key"): `MD5(encryToken)`.
2. **Signature.** The inner fields plus some outer fields, sorted by key and
   joined as `k=v&…&password=<key>`, then passed through a nonstandard SHA-1
   ("mixed case", with some zero characters dropped; see `sha1_mixed`). The
   key is `MD5(password)` at login and `MD5(signToken)` afterwards.
3. **Checkcode.** An MD5 of the compact outer JSON with its hex digest split
   into four 8-character chunks and reordered `[24:32] + [8:16] + [16:24] + [0:8]`.
   The whole outer object is serialized with Python's
   `json.dumps(separators=(",", ":"), ensure_ascii=False)`, and **key order
   matters**, because the checkcode is computed over that exact serialization.
   `JSON.stringify` preserves insertion order, so the TypeScript port has to
   build the outer object in pyBYD's field order.
4. **Bangcle envelope.** The outer JSON, PKCS7-padded, encrypted with the
   white-box AES in CBC mode with a zero IV, base64-encoded, and prefixed with
   `F`. The response comes back the same way under `"response"`; decoding
   yields `{code, message, respondData}`, and `respondData` is AES-hex
   decrypted with the key from layer 1. There's one quirk: a stray leading `F`
   occasionally appears on the decoded JSON and has to be stripped.

The white-box tables total about 830 KB (`bangcle_tables.bin` in pyBYD, and
the same data base64-embedded in ioBroker's `bangcle_auth_tables.js`). They're
data, not a key we can derive, so they ship with the client package (§5).

Layers 1–3 use Node's built-in `crypto` (`aes-128-cbc`, `md5`, `sha1`), so
there's no dependency to add. Layer 4 is about 300 lines of table-lookup code.
ioBroker's `lib/bangcle.js` is already JavaScript and makes a near-direct
reference for it.

### 4.3 Login and session lifetime: there is no refresh token

`POST /app/account/login` with `functionType: "pwdLogin"`. A successful
response yields `{ userId, signToken, encryToken }`, and every later request
is keyed off those three values.

What makes this unlike Evnex:

- **The plaintext password goes over the wire.** pyBYD sends it as the outer
  `signKey` field, inside the Bangcle envelope, and derives two keys from it.
  A stored hash won't do: every login needs the password itself.
- **There's no refresh flow.** When the session dies, the API returns code
  `1002`, `1005` or `1010` (pyBYD's `SESSION_EXPIRED_CODES`), and the client
  logs in again. pyBYD also re-logs in proactively after a 12-hour TTL, but
  that's a client-side guess, not a server-documented lifetime. **The real
  server-side lifetime needs measuring in the spike.** If tokens turn out to
  last weeks, "ask for the password again when the session lapses" becomes
  bearable (§12 #1).
- **Retry exactly once.** On a session-expired code: log in again, retry the
  call once, and if that fails, record it as an auth failure. This matches
  pyBYD's `_call_with_reauth` and the Evnex client's one-retry rule. Never
  loop: repeated failed logins against a consumer account are how accounts
  get locked.
- A non-zero `code` at login is an authentication failure (wrong password or
  wrong region). Other codes worth mapping: `1001` endpoint not supported for
  this vehicle, `1008` service busy, `6002` vehicle unreachable.

### 4.4 Endpoints used

Only these three. Everything else pyBYD supports is out of scope.

| Purpose        | Endpoint                                                                                         | Notes                                                                                                                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in        | `/app/account/login`                                                                             | §4.3                                                                                                                                                                                                    |
| Vehicle list   | `/app/account/getAllListByUserId`                                                                | VIN, `autoAlias`, `autoPlate`, `modelName`, `energyType`, **`totalMileage`**, `vehicleTimeZone`. One call, no polling.                                                                                  |
| Realtime state | `/vehicleInfo/vehicle/vehicleRealTimeRequest`, then `/vehicleInfo/vehicle/vehicleRealTimeResult` | Trigger, then poll using the returned `requestSerial` (pyBYD polls up to 10 times at 1.5 s). The result carries `totalMileage`, `onlineState`, `chargeState` and **`time`** (the car's data timestamp). |

pyBYD waits for MQTT first and falls back to HTTP polling. **We use HTTP
polling only.** MQTT would need a long-lived broker connection with its own
key handling, which a request/response SvelteKit app has nowhere to keep, and
a realtime read taking up to ~15 s is fine behind a spinner (§8).

**Which source to read the odometer from: _verify in spike_.** The vehicle
list is one cheap call and ioBroker's captured sample shows it carries
`totalMileage`, but nothing shows how fresh that value is, and it has no
timestamp. The realtime result has the timestamp (`time`) that §7.2's matching
rule needs. The spike should call both repeatedly over a few days and
answer three questions:

1. Does the vehicle-list `totalMileage` track the realtime value, and how far
   does it lag?
2. Does a realtime trigger against a sleeping car return the cached last-known
   state with a `time` from when it was parked (useful and harmless), or does
   it wake the car?
3. What does `time` look like: epoch seconds or milliseconds, and UTC?

The default design uses the realtime result for anything that fills a
session, and the vehicle list only for the Test read (§3) and as a fallback
suggestion.

### 4.5 The odometer fields: units and sentinel values

- `totalMileage` is a number in km for AU-region cars. `totalMileageV2` comes
  with an explicit `totalMileageV2Unit`. **If a unit field is present and
  isn't km, reject the reading** (don't convert it). A miles/km mixup on a
  lease report is exactly the kind of error that's worse than a blank.
- **`0` and negative values mean "no data", not a reading.** pyBYD's
  `_ZERO_DROP_FIELD_NAMES` includes `total_mileage` and `total_mileage_v2`,
  and `-1` is BYD's usual "unavailable" sentinel, especially on post-wake
  and deep-sleep payloads. Treat either as absent. This is the opposite of
  Evnex's rule, where `0` kWh is a real reading, so it needs its own tests.
- Whole km in practice. The column is `real`, so nothing needs to change.

### 4.6 Waking the car and battery drain

HA's `const.py` comments that frequent polling "wakes the car", measured at
about 0.1 kWh/h at a 300 s interval, and raised its max interval to 8 hours
for that reason. ioBroker added "sleep/wake protection" and skips the
follow-up polling when the trigger response says `onlineState === 2`
(sleeping). We adopt the same guard. If the trigger response says the car is
asleep, use whatever state it returned and don't poll further.

Because Phase 1 only reads when the user taps a button, drain there is
negligible. It only becomes a real concern for the Phase 6 background sampler.

### 4.7 Device fingerprint

Every request carries fake Android device fields (`imei`, `mac`,
`mobileBrand`, `mobileModel`, `osVersion`, …), plus an `imeiMD5` that pyBYD
derives from the username. HA generates a **random but realistic profile once
per account** from a curated device pool, and backfills and persists it for
older installs. We do the same: generate at first sign-in, store it as JSON
on the integration row, and reuse it forever. A device identity that changes
on every login looks like a new phone each time, which is exactly what
account-security heuristics flag.

### 4.8 Shared accounts

A BYD owner can share the vehicle with another account, and that account's
permissions come back in the vehicle list as `rangeDetailList` (pyBYD's
`Vehicle.is_shared` is `empowerType < 0`). _Verify in spike:_ that the
narrowest share still exposes realtime data including `totalMileage`. If it
doesn't, fall back to the smallest share that does, and write down in the
README exactly what that share can do.

---

## 5. The `byd-client` package

It lives in its own repo (e.g. `brianramseyau/typescript-byd`, alongside
`typescript-evnex`) and is published as `byd-client`. It's a **deliberately
narrow** port of pyBYD:

| In scope                                                                                                                                | Out of scope                                      |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Bangcle codec + embedded tables                                                                                                         | All remote commands, control PIN, MQTT            |
| Inner AES, `sha1_mixed`, sign string, checkcode                                                                                         | GPS, HVAC, charging schedules, push notifications |
| `login()` returning a serialisable session `{ userId, signToken, encryToken }`                                                          | Energy-consumption endpoint                       |
| `getVehicles()`, `getRealtime(vin)` (trigger + HTTP poll, sleep guard)                                                                  |                                                   |
| One re-login on `SESSION_EXPIRED_CODES`, surfaced through an `onSessionUpdate` callback, same shape as `evnex-client`'s `onTokenUpdate` |                                                   |
| zod schemas for the three responses, lenient: unknown fields are ignored and sentinels are normalised to `null`                         |                                                   |
| Device-profile generator (the pool and Luhn-valid IMEI from HA's `device_fingerprint.py`)                                               |                                                   |
| Exported error classes: `BydAuthError`, `BydSessionExpiredError`, `BydApiError(code)`, `BydTransportError`                              |                                                   |

**Testing the port.** pyBYD has no crypto test vectors, so we generate them:
a small Python script (kept in the package repo, not this one) runs pyBYD's
`BangcleCodec`, `aes_encrypt_hex`, `sha1_mixed`, `compute_checkcode` and
`build_login_request` (with a fixed clock and nonce) over a set of inputs,
and writes golden JSON. The TypeScript tests have to reproduce those vectors
byte for byte, including checkcode sensitivity to key order (§4.2 layer 3).
That settles almost every port bug before we contact the real API.

**Licensing.** pyBYD and ioBroker.byd are both MIT, so we keep their notices.
The tables come from BYD's own app. That's the same position every one of
these projects is in, but it's worth writing down once in the package README.

**Packaging.** The tables go in as a binary asset loaded with
`fs.readFile(new URL('./bangcle_tables.bin', import.meta.url))`. That's
smaller than ioBroker's 1.1 MB base64 `.js`, and it keeps the tables out of
the JS parse. Phase 2 has to confirm the file survives Vite's SSR bundle, the
Docker image and the Electron `asar` package; the `evnex-client` package has
no binary assets, so nothing we've built so far has tested this.

---

## 6. Data model

### 6.1 New table: `byd_integration`

It's a single row, following the same pattern as `evnex_integration`, and
separate from it because the lifecycles are independent.

```ts
export const bydIntegration = sqliteTable('byd_integration', {
	id: integer('id').primaryKey({ autoIncrement: true }),

	// User-chosen, via /settings
	username: text('username'), // email or phone, shown in /settings
	region: text('region', { enum: ['AU' /* extend as needed */] })
		.notNull()
		.default('AU'),
	vin: text('vin'), // chosen vehicle
	vehicleName: text('vehicle_name'), // autoAlias / modelName, cached for display
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),

	// Credentials: never sent to the browser, never logged (§9)
	password: text('password'), // plaintext; required for re-login (§4.3). See §12 #1.
	deviceProfile: text('device_profile', { mode: 'json' }), // §4.7, generated once
	userId: text('user_id'),
	signToken: text('sign_token'),
	encryToken: text('encry_token'),
	sessionIssuedAt: text('session_issued_at'), // ISO; informs the spike's lifetime measurement

	// Last read, for the /settings status line and the "From car" hint
	lastOdometerKm: real('last_odometer_km'),
	lastOdometerAt: text('last_odometer_at'), // ISO UTC, the CAR's timestamp, not ours
	lastReadAt: text('last_read_at'), // ISO UTC, when we asked
	lastReadStatus: text('last_read_status', {
		enum: ['ok', 'auth_failed', 'network_error', 'api_error', 'no_data']
	}),
	lastReadError: text('last_read_error')
});
```

### 6.2 `charging_sessions`: record where the odometer came from

This adds `odometerSource: text('odometer_source', { enum: ['manual', 'car'] })`,
nullable. Existing rows stay `NULL`, which reads as manual. It's the "source
column" the Evnex plan deferred "until a second integration appears"
(EVNEX-INTEGRATION-PLAN.md §12 #2), scoped to the one field it concerns.
Why bother: when a lease-company query asks "where did this odometer figure
come from?", the answer shouldn't depend on memory. The chip in §8.3 reads
it. It's a plain `ALTER TABLE … ADD COLUMN`, so there's no table rebuild and
the foreign-key caveat in `db/index.ts` doesn't come into play.

The Evnex drafts don't persist the session's start and end instants, only
the local `date`/`time`. Phase 1 doesn't need them, because it matches at
pull time, while the Evnex payloads (which include `endDate`) are in memory.
**Phase 6 does** (§7.3), and it'll add nullable `started_at`/`ended_at` ISO
columns filled for imported sessions. That's deferred until then rather than
added speculatively.

### 6.3 Not needed yet: a readings history table

A `byd_odometer_readings` table (one row per sample) is what makes background
matching work (Phase 6). Phase 1 only needs the latest reading, which lives on
`byd_integration`. The table gets added in Phase 6, together with the sampler
that fills it.

---

## 7. Matching a reading to a session: `src/lib/server/byd.ts`

This is pure and dependency-free, like `evnex.ts`, with a co-located
`byd.test.ts`.

### 7.1 Normalising a reading

```ts
interface CarReading {
	km: number; // > 0, km. Anything else is rejected before this type exists.
	reportedAt: string; // ISO UTC, from the car's `time` field
	source: 'realtime' | 'vehicle_list';
}

function toCarReading(raw: …): CarReading | { rejected: 'no_data' | 'bad_unit' | 'no_timestamp' };
```

A vehicle-list reading has no `time` field. It gets `reportedAt = fetchedAt`
and `source: 'vehicle_list'`, and `planOdometerFill` only ever treats it as a
suggestion, never as exact (§7.2).

### 7.2 The rule: exact vs. suggestion

The car can't move while it's charging. So if the car reported a reading at
an instant inside a charge's `[startDate, endDate]`, that reading is exactly
that session's plug-in odometer. Anything else is a guess.

`planOdometerFill(reading, drafts, existing)` returns, for each draft missing
an odometer, one of the following:

| Outcome   | When                                                                                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fill`    | `reading.source === 'realtime'` **and** `startDate <= reportedAt <= endDate` (a still-charging session counts as `endDate = now`), **and** the km passes `isOdometerBelowLastRecorded` against the session's neighbours. Written with `odometerSource: 'car'`. |
| `suggest` | Not exact, but plausible: the draft is the **most recent** session, the reading is after its start, and the km isn't below the last recorded odometer. The value is pre-filled in the draft's input, never saved without the user tapping it.                  |
| `skip`    | Everything else, including older drafts. A reading from today says nothing about last Tuesday's odometer.                                                                                                                                                      |

Deliberately **not** used as evidence: `chargeState`. pyBYD's own enum
comment says the "connected" value `15` "does not change when the charging
gun is disconnected, so we should not rely on it". (ioBroker's README claims
the opposite; the disagreement is the reason to stay out of it.) Timestamps
and odometer ordering are the only evidence the rule uses.

Instants are compared as instants (ISO UTC). Local `date`/`time` strings are
never compared: the Evnex plan's §6.3 timezone trap applies unchanged, and
converting for display uses the same `formatToParts` rule.

### 7.3 Phase 6 (background): the same rule over a history

With a readings table and stored session instants, the matcher looks for any
realtime reading inside each draft's window, not just the latest one. The
decision table stays the same, so Phase 6 reuses `planOdometerFill` over a
list of readings instead of one.

---

## 8. UI

### 8.1 `/settings`: new "BYD vehicle" heading

Its states mirror the Evnex card's:

- **Signed out:** username, password, region, and a **Sign in** button. A
  line of help text links to the README's shared-account instructions and
  says plainly that the password is stored (§9).
- **Connected:** the account, a vehicle picker (listed through a client-side
  fetch to `src/routes/settings/byd-vehicles/+server.ts`, **not** in `load`,
  for the same reason as `charge-points/+server.ts`: an unofficial API mustn't
  block page render), an **enabled** switch, a **Test read** button showing
  "118,204 km, reported by the car 14 min ago", the last-read status line,
  and **Sign out** (clears password, tokens and VIN; keeps the device profile
  so the account doesn't see a "new phone" if it signs in again).
- **Auth failed:** the password changed or the account was locked. Show the
  error and a password field to sign in again. It's the same pattern as the
  Evnex "refresh token expired" state.

### 8.2 `/sessions`

- **Add form:** a small **Read from car** icon button next to the Odometer
  field, shown only when the integration is enabled. It calls a `+server.ts`
  endpoint (`src/routes/sessions/car-odometer/+server.ts`) with `fetch`, so
  the ~15 s realtime round-trip doesn't block a form action. On success it
  fills the field and shows a hint beneath it: _"From car, reported 3 min
  ago."_ If the car's timestamp is more than, say, 30 minutes old (the car is
  asleep and this is its last-known state), the hint changes to a warning:
  _"Car last reported 2 days ago — check this matches the dash."_ The
  existing `isOdometerBelowLastRecorded` warning still applies on save.
- **Pull from charger:** once the Evnex form action returns, the page calls
  the same endpoint with `?apply=1`. The server runs `planOdometerFill`,
  writes the `fill` outcomes, and returns the `suggest` ones, which pre-fill
  the matching drafts' _Add odometer_ inputs with the same "From car" hint.
  The two stay as separate requests so that a slow or broken BYD API never
  delays or fails an Evnex import.
- **Draft rows:** each _Add odometer_ field gets its own **Read from car**
  button, with the same behaviour as in the Add form.

### 8.3 Provenance chip

A session whose `odometerSource === 'car'` gets a small car icon beside the
km figure in the history list, with a tooltip. It's an icon rather than
another coloured chip because the chip slot already carries kind
(Home / Public / Home - Imported). Screenshot it in both themes (CLAUDE.md
"Browser testing"); the Evnex chip needed a separate dark-mode colour.

---

## 9. Credentials and privacy

Persisting a plaintext password is a step beyond what the Evnex integration
does, so this section is explicit about it.

- The BYD password, the `signToken`/`encryToken`, and the device profile are
  never returned by any `load` function or `+server.ts` response, never
  rendered, and never logged. The client package must redact them from debug
  output the way pyBYD's `_redact.py` does; ship that rule with the package's
  first logging statement, not after an incident.
- **No "encryption at rest" theatre.** The key would have to live next to the
  database (there's no deployment config to put it in, §2 #7), so it would
  protect nothing the file permissions don't. This section says so plainly.
  The real mitigation is §2 #2: the stored password belongs to a secondary
  account with a limited share, not to the owner's account.
- The VIN is personal data in the same class as the home address. It stays
  in the DB and never goes into logs or error messages.
- No location data is ever requested, so the integration can't leak the car's
  location. This is enforced by the client package leaving GPS out of scope
  (§5).
- CLAUDE.md "Privacy" gets a BYD paragraph (§13).

---

## 10. Testing

- **`byd-client` package:** golden vectors from pyBYD (§5), zod schema tests
  against captured responses from the spike (redacted: VIN, plate, userId and
  tokens replaced), sentinel normalisation (`0`, `-1`, missing, non-km unit),
  the one-retry-on-`1005` rule, and the sleep guard (no polling after
  `onlineState: 2`).
- **`byd.test.ts` (this repo):** the whole §7.2 decision table: a reading
  exactly on each boundary, one second either side, a still-charging session,
  a vehicle-list reading (never `fill`), a reading below the last recorded
  odometer, several drafts where only the latest can be `suggest`, a reading
  timestamped in the future (clock skew; treat it as `suggest`, never
  `fill`), and a draft across a DST change, checked against the Evnex
  `toLocalDateTime` conversions.
- **Playwright:** the `/settings` card in all three states, the Read from car
  hint (fresh vs. stale), a pre-filled suggestion on a draft, and the
  provenance icon, all in light and dark and with the `en-GB` locale recipe
  from CLAUDE.md. A `BYD_FAKE=1` dev-only stub behind the `+server.ts`
  endpoints lets this run without a real car. It's dev-only, and **not** a
  deployment setting.

---

## 11. Phasing

Each phase lands green (`npm run check`, `npm run lint`, `npm run test`).

| #   | Phase                                                                                                           | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0   | **Spike, using pyBYD itself, against the real car**                                                             | No TypeScript. `pip install pybyd`, then use a dedicated shared account to log in, list vehicles, read realtime repeatedly over several days, and capture redacted fixtures. It answers: the realtime-vs-vehicle-list freshness question (§4.4); whether a trigger wakes a sleeping car; the `time` field's format; the server-side session lifetime (§4.3); whether a narrow share still exposes the odometer (§4.8); and whether signing in logs the phone app out. **Go/no-go:** if the odometer can't be read reliably from a shared account, stop here. That costs nothing, whereas finding out in Phase 2 wastes a port. |
| 1   | `byd.ts` pure logic + full Vitest suite                                                                         | No network, no UI. It can run in parallel with Phase 2, using the Phase 0 fixtures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | `byd-client` package: crypto, login, vehicle list, realtime                                                     | The largest and riskiest phase. Golden vectors come first, then one live login. Also confirm the tables file survives bundling for Docker and Electron (§5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 3   | Schema (`byd_integration`, `odometer_source`) + `byd-auth.ts`/`byd-client.ts`/`byd-token.ts` + `/settings` card | First real use from inside the app. Ends with a working Test read.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | **Read from car** in the Add form and on draft rows                                                             | The first payoff, and useful even without Evnex (public sessions).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 5   | Auto-fill after **Pull from charger** + provenance icon                                                         | The main payoff: a home session goes from charger to complete with no typing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | _Optional_, background sampler + readings table + session instants                                              | Only if Phase 0 shows a no-wake read path and Phases 4–5 leave you wanting more (§12 #3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | Playwright verification + §13 documentation                                                                     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 12. Open decisions

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                       | Default if unanswered                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Persist the BYD password, or ask again whenever the session lapses?** Persisting it makes the integration work unattended. Asking again keeps the Evnex rule ("password used once, never stored"), but if the server-side lifetime really is ~12 h (§4.3), that means typing it almost every time you use the button.                                                                        | **Persist it**, on a dedicated shared account (§2 #2, §9). Revisit if Phase 0 measures sessions lasting weeks. At that point the Evnex-style reconnect prompt becomes tolerable and the stored password can be dropped. |
| 2   | **Use a dedicated shared BYD account?** Signing the app in with your main account would log out your phone's BYD app, and that would happen on every re-login.                                                                                                                                                                                                                                 | **Yes, and require it:** the `/settings` help text tells you to, and the README walks through the share.                                                                                                                |
| 3   | **Add background sampling (Phase 6) so drafts fill with no interaction at all?** In the typical flow (plug in in the evening, tap Pull the next morning before driving), the car's last-known state is still from while it was parked on the charger, so Phase 5 already fills most home sessions _exactly_ with a single tap. Background sampling mainly helps when you drive before pulling. | **No**, until Phases 4–5 have been in use for a billing period. It adds a scheduler to an app that has none (Electron and Docker would each need one), plus battery drain and a readings table.                         |
| 4   | **Fill `settings.vehicleLabel` from the car's plate/VIN?**                                                                                                                                                                                                                                                                                                                                     | **No.** Show the car's plate beside the vehicle picker so you can confirm you've picked the right car, but never write to report-identity settings automatically.                                                       |
| 5   | **Support more than one region?**                                                                                                                                                                                                                                                                                                                                                              | **AU only in the UI**, with `region` stored as an enum so adding more is a one-line change. The HA integration's region table is the reference when that happens.                                                       |

---

## 13. Documentation to update

Owed once this lands:

- **CLAUDE.md, "Key domain logic":** a BYD bullet covering the exact-vs-suggestion
  rule (§7.2), that `chargeState` is deliberately ignored, that `0`/`-1`
  odometers are sentinels (the opposite of Evnex's kWh `0`), and that the API
  is unofficial and obfuscated (§4.0).
- **CLAUDE.md, layering convention:** `byd.ts` / `byd-auth.ts` /
  `byd-client.ts` / `byd-token.ts`, plus the two new `+server.ts` exceptions
  (`settings/byd-vehicles`, `sessions/car-odometer`) and why they exist.
- **CLAUDE.md, "Stack specifics":** `byd-client` (a narrow port of pyBYD), the
  bundled Bangcle tables, and a "do not" note: don't add MQTT or command
  endpoints to "complete" the port. They're out of scope on purpose (§2 #1).
- **CLAUDE.md, "Privacy":** the DB now holds a plaintext BYD password and BYD
  session tokens, and the VIN. It's the same "never log, render, or return"
  rule as the Evnex refresh token, but stronger, because this one is the
  actual password.
- **README.md:** a "BYD vehicle integration" section: how to create and share
  a dedicated account, that it's configured only in `/settings`, that the
  password is stored, and that it uses an unofficial API that can break
  without notice.
- **No deployment-config changes:** `.env.example`, the `Dockerfile` and the
  Unraid template are untouched, as with Evnex. The only packaging check is
  the tables file (§5).
