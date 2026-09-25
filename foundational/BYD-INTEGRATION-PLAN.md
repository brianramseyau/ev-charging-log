# BYD Odometer Integration (via Home Assistant) — Design & Implementation Plan

Status: **scoped, not started.** Confirmed: the user already runs the
[`hass-byd-vehicle`](https://github.com/jkaberg/hass-byd-vehicle) Home Assistant
integration and it reads the odometer from this car.
Branch: `claude/byd-car-km-integration-pd6prj`

Builds on [EVNEX-INTEGRATION-PLAN.md](EVNEX-INTEGRATION-PLAN.md), which already
made the odometer nullable, added the draft-session flow, and set the pattern
for an integration configured through `/settings`. See
[§12](#12-documentation-to-update) for the documentation edits owed once this
lands.

---

## 1. Why

Since the Evnex integration, a home session arrives as a draft that already has
date, time, kWh and location. The one thing left to type is the **odometer**,
and the charger has no way to know it. The car does, and the user's Home
Assistant already collects it every few minutes.

Goal: **fill in the odometer from the car so a home session needs no typing at
all**, and let a manually-logged public session fetch the reading with a tap
instead of the user reading the dash.

Non-goals: anything else the car or Home Assistant exposes (location, battery,
range, climate, locks). This integration reads one sensor, plus an optional
timestamp sensor that tells us how fresh that reading is.

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The app reads the odometer from Home Assistant's REST API, not from BYD directly.** HA's REST API is official, documented and stable, and the user already runs `hass-byd-vehicle`. Talking to BYD directly would mean porting BYD's scrambled protocol from `pyBYD`, storing a plaintext BYD password, and running a second BYD account so this app doesn't log out HA or the phone app. HA has already done all of that. The direct route is recorded in [Appendix A](#appendix-a-the-direct-byd-api-route-not-taken) in case HA is ever retired. |
| 2   | **HA's recorder history is the matching engine.** HA records the odometer every time it changes and the car's telemetry timestamp every time the car reports. Together those show what the odometer read _while a given charge was running_. That's exact, and it needs no scheduler in this app: HA already polls the car (§6).                                                                                                                                                                                                                      |
| 3   | **A reading is only written to a session automatically when it provably belongs to that session**, meaning the car reported fresh telemetry while that charge was running (§6.2). Anything else pre-fills the odometer field as a suggestion that the user confirms. Odometer values end up on the lease report, and a silently wrong value is worse than an empty one.                                                                                                                                                                               |
| 4   | **Read-only.** The app only ever calls HA's `GET` state and history endpoints, never `POST /api/services/…`. That can't be enforced from HA's side, since long-lived tokens have no scopes (§8), so it's enforced by the client module having no code path that sends anything else.                                                                                                                                                                                                                                                                  |
| 5   | **No npm package, no new dependency.** HA's REST API is a handful of plain `fetch` calls with a Bearer token. It gets one small impure module, `home-assistant.ts`, rather than the separate-package treatment `evnex-client` needed.                                                                                                                                                                                                                                                                                                                 |
| 6   | **No new deployment configuration.** The HA URL and token are entered in `/settings`, identically on Docker/Unraid and the Electron build.                                                                                                                                                                                                                                                                                                                                                                                                            |

## 3. What the user does, end to end

One-time setup:

1. In Home Assistant, creates a long-lived access token (Profile → Security →
   Long-lived access tokens). §8 recommends creating a dedicated non-admin HA
   user for this first.
2. Opens `/settings`, finds a new **Car odometer (Home Assistant)** heading
   below the Evnex one, and enters the HA URL (for example
   `http://192.168.1.10:8123`) and the token.
3. The app checks the connection and lists candidate odometer sensors (§4.3).
   The BYD **Odometer** sensor is preselected, as is its **Telemetry last
   updated** partner from the same car. A **Test read** shows
   "118,204 km, car reported 6 min ago" so the user can check it against the
   dash.
4. Switches the integration on and saves.

Day to day:

- **Home, with Evnex:** taps **Pull from charger** on `/sessions` as today.
  Once the import finishes, the page asks the server to fill odometers. Every
  draft whose charge HA observed gets its exact odometer and completes. The
  rest get a **From car** suggestion in their _Add odometer_ field.
- **Public, or home without Evnex:** in the Add form, taps **Read from car**
  next to the Odometer field. It fills with HA's current value and a hint
  saying how old the car's data is.

---

## 4. The Home Assistant side

### 4.1 What `hass-byd-vehicle` exposes

From `custom_components/byd_vehicle/sensor.py` and `translations/en.json`:

| Entity (name in HA)        | Key             | Details                                                                                                                      |
| -------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Odometer**               | `total_mileage` | `device_class: distance`, `state_class: total_increasing`, native unit `km`, integer-rounded, from the realtime poll.        |
| **Telemetry last updated** | `last_updated`  | `device_class: timestamp`, diagnostic. Its _value_ is when the car produced the realtime data, as opposed to when HA polled. |

Every entity from the integration has a `vin` attribute (`entity.py`), which
is how the app ties the two together.

Entity IDs depend on the car's name in HA (something like
`sensor.sealion_7_odometer`), so they're chosen in `/settings`, never
hard-coded.

HA's default poll interval for the integration is 300 s. That matters for §6:
the exact rule needs at least one fresh telemetry report _during_ each charge.
A home charge lasts hours, so the default is plenty. If the user has turned the
interval up to several hours to save battery, short charges will fall back to
suggestions. That's safe, just less automatic.

### 4.2 Endpoints used

All calls are `GET`, with `Authorization: Bearer <token>`. The API is documented
at developers.home-assistant.io → REST API.

| Purpose             | Request                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection check    | `GET /api/`, which returns `{"message": "API running."}`. A 401 means a bad token.                                                                         |
| Sensor picker       | `GET /api/states`, filtered client-side (§4.3)                                                                                                             |
| Current reading     | `GET /api/states/<odometer>` and `GET /api/states/<telemetry>`                                                                                             |
| History for a draft | `GET /api/history/period/<start ISO>?end_time=<end ISO>&filter_entity_id=<odometer>,<telemetry>&minimal_response&no_attributes&significant_changes_only=0` |

History quirks to handle:

- **The first entry for each entity is the state in effect at `start`**,
  because HA includes the start-time state by default, with its
  `last_changed` clamped to `start`. That's the value we want at plug-in.
- `minimal_response` drops `entity_id` from every entry after the first in
  each inner array, so match arrays by their first element, not by position.
- `significant_changes_only=0` makes sure every recorded change comes back.
- Timestamps are ISO with an offset (UTC). Parse with `Date`; never compare
  them as strings.
- **Retention:** the HA recorder keeps 10 days by default (`purge_keep_days`).
  A draft older than that has no history. The Evnex lookback default of 3
  days sits comfortably inside it, but an old draft finished late has to
  degrade to "no data", not fail.

### 4.3 Picking the sensors

From `GET /api/states`, offer as odometer candidates the entities where
`attributes.device_class === 'distance'`,
`attributes.state_class === 'total_increasing'`, and
`attributes.unit_of_measurement === 'km'`, sorted with any that also carry a
`vin` attribute first. The telemetry candidates are the `device_class ===
'timestamp'` entities with the **same `vin`**. If exactly one pair matches,
preselect it.

This filter isn't BYD-specific, so any HA odometer sensor would work (another
car make, or an OBD dongle). That's a free side effect, and the design
doesn't depend on it.

### 4.4 Reading values defensively

- The state is a string. Accept it only if it parses to a finite number
  `> 0`. `unavailable`, `unknown`, `0` and negative values mean "no reading"
  (the BYD API sends `0`/`-1` placeholders on wake-up; `hass-byd-vehicle`
  mostly filters these, but not in every path).
- **The unit has to be `km`.** HA can convert units into the user's display
  system, so a changed HA unit setting or a per-entity override could make
  it report miles. If the unit isn't `km`, reject the reading with a clear
  message instead of converting it.
- The value is whole km, and `odometer_km` is `real`, so nothing needs to
  change there.

---

## 5. Data model

### 5.1 New table: `home_assistant_integration`

It's a single row, following the same pattern as `evnex_integration`:

```ts
export const homeAssistantIntegration = sqliteTable('home_assistant_integration', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	baseUrl: text('base_url'), // e.g. http://192.168.1.10:8123, no trailing slash
	accessToken: text('access_token'), // long-lived token; a credential, see §8
	odometerEntityId: text('odometer_entity_id'),
	telemetryEntityId: text('telemetry_entity_id'), // optional; without it nothing is "exact"
	vehicleName: text('vehicle_name'), // friendly_name, cached for display
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),

	lastReadAt: text('last_read_at'),
	lastReadStatus: text('last_read_status', {
		enum: ['ok', 'auth_failed', 'network_error', 'api_error', 'no_data']
	}),
	lastReadError: text('last_read_error')
});
```

It's generic HA state, not BYD state, which is why it isn't named
`byd_integration`. A later HA-sourced feature could reuse the connection
columns.

### 5.2 `charging_sessions`: two changes

1. **`odometer_source`**: `text('odometer_source', { enum: ['manual', 'car'] })`,
   nullable, with existing rows staying `NULL` (which reads as manual). It
   answers "where did this odometer figure come from?" for the lease company
   without relying on memory, and the history list's provenance icon (§7.3)
   reads it. This is the "source column" the Evnex plan deferred until a
   second integration appeared (EVNEX-INTEGRATION-PLAN.md §12 #2), scoped to
   the one field it concerns.
2. **`started_at` / `ended_at`**: nullable ISO UTC instants, filled by the Evnex
   import from `startDate`/`endDate`. Right now an imported draft only keeps
   local `date`/`time`, which is enough for billing but not for asking HA
   "what happened during this charge?". Converting local strings back into
   instants breaks across DST changes (the Evnex plan's §6.3 trap run in
   reverse), so we store the instants the charger gave us. Manual sessions
   leave them `NULL`, since the Add form's **Read from car** doesn't need
   them.
   - Backfill: nothing. Existing completed drafts don't need matching, and a
     still-open imported draft picks the columns up on the next poll, via a
     small `planImport` change: an existing row with `started_at IS NULL` gets
     it set, alongside the existing kWh-update path.

Both are plain `ALTER TABLE … ADD COLUMN`s, so there's no table rebuild and the
foreign-key caveat in `db/index.ts` doesn't come into play.

---

## 6. Matching logic: `src/lib/server/car-odometer.ts`

This is pure and dependency-free, like `evnex.ts`, with a co-located
`car-odometer.test.ts`. `home-assistant.ts` fetches the data, and this file
decides what to do with it.

### 6.1 Inputs

```ts
interface StateChange { value: string; at: string } // one history entry; `at` = last_changed, ISO

interface DraftWindow {
	id: number;
	startedAt: string; // ISO UTC
	endedAt: string;   // ISO UTC
}

// Per draft: odometer history and telemetry history over [startedAt, endedAt]
planOdometerFill(
	drafts: DraftWindow[],
	history: Map<number, { odometer: StateChange[]; telemetry: StateChange[] }>,
	neighbours: …  // for the isOdometerBelowLastRecorded check
): { fill: { id: number; km: number }[]; suggest: { id: number; km: number; reason: string }[]; skipped: … }
```

### 6.2 The rule

The car can't move while it's charging. So if the car sent **fresh
telemetry during the charge**, the odometer HA held right after that report
is exactly the plug-in odometer.

| Outcome   | When                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fill`    | There's at least one telemetry entry whose **value** (the car's own timestamp, not HA's `last_changed`) falls inside `[startedAt, endedAt]`, **and** the odometer in effect at that instant is a valid reading (§4.4), **and** every valid odometer reading inside the window is that same value (the car didn't move), **and** it passes `isOdometerBelowLastRecorded` against the session's neighbours. Written with `odometer_source = 'car'`. |
| `suggest` | No proof of freshness, but the odometer in effect at `startedAt` is a valid reading that passes the neighbour check. The value is pre-filled in the draft's input with the hint _"From car — not confirmed during this charge"_, and is never saved without the user tapping it. This is also what happens with no telemetry entity configured.                                                                                                   |
| `skip`    | No valid reading at all: outside recorder retention, entity unavailable the whole time, wrong unit, or a value below the previous session's odometer.                                                                                                                                                                                                                                                                                             |

Why the telemetry value rather than HA's `last_changed`: HA can re-poll and get
the same _stale_ cloud data back while the car is asleep. HA's timestamps say
when HA looked; the telemetry value says when the car last reported. Only the
second proves the car was in that state during the charge.

Deliberately **not** used as evidence: the BYD charging-state sensors.
`pyBYD` itself notes that the "gun connected" value "does not change when the
charging gun is disconnected", and other implementations disagree about which
field to trust. Timestamps and odometer ordering are the only evidence the
rule uses.

### 6.3 Read from car (Add form, draft rows)

This is simpler: fetch the current odometer and telemetry states. It returns
`{ km, carReportedAt }` for the page to show. Nothing is written until the user
saves, and the saved row gets `odometer_source = 'car'` only if the submitted
value still equals the fetched one. Otherwise the user edited it, and it
counts as `manual`.

---

## 7. UI

### 7.1 `/settings`: new "Car odometer (Home Assistant)" heading

- **Not connected:** HA URL, token, and a **Connect** button. The help text
  links to HA's token page and recommends the dedicated user (§8).
- **Connected:** the odometer and telemetry sensor pickers (loaded by a
  client-side fetch to `src/routes/settings/ha-sensors/+server.ts`, **not** in
  `load`, for the same reason as `charge-points/+server.ts`: a network
  dependency mustn't block page render), a **Test read** button, the enabled
  switch, the last-read status line, and **Disconnect** (clears the token).
- **Error:** a 401 (token revoked) or an unreachable host. Show the error and
  let the user fix the URL or paste a new token in place.

### 7.2 `/sessions`

- **Add form:** a small **Read from car** icon button next to the Odometer
  field, shown only when the integration is enabled. It calls
  `src/routes/sessions/car-odometer/+server.ts` with `fetch`, fills the field,
  and shows _"From car, reported 3 min ago."_ If the car's data is more than
  30 minutes old, the hint becomes a warning: _"Car last reported 2 days ago —
  check this matches the dash."_ The existing below-last-recorded warning
  still applies on save.
- **Pull from charger:** after the Evnex form action returns, the page posts
  to the same endpoint with `?apply=1`. The server runs `planOdometerFill`
  over all open imported drafts (those with `started_at`), writes the `fill`s,
  and returns the `suggest`ions to pre-fill. The two stay as separate
  requests so that HA being down never delays or fails an Evnex import. The
  existing "N sessions imported" message gains "…N odometers filled from car".
- **Draft rows:** each _Add odometer_ field gets its own **Read from car**
  button, which uses the history rule (§6.2) for that one draft when it has
  `started_at`, and the current value (§6.3) otherwise.

### 7.3 Provenance icon

A session whose `odometer_source === 'car'` gets a small car icon beside the
km figure in the history list, with a tooltip ("Odometer read from the car via
Home Assistant"). It's an icon rather than another coloured chip because the
chip slot already carries kind (Home / Public / Home - Imported). Screenshot it
in both themes (CLAUDE.md "Browser testing").

---

## 8. Credentials, privacy and security

- **An HA long-lived token is a powerful credential.** HA has no read-only or
  scoped tokens. Even a non-admin HA user's token can read every entity and
  call services, which with `hass-byd-vehicle` installed includes unlocking the
  car. The token is therefore at least as sensitive as the Evnex refresh token:
  it's never returned by a `load` function or `+server.ts` response, never
  rendered (the settings field is write-only and shows "token saved"), and
  never logged, including in error messages from failed `fetch`es.
- **Recommend a dedicated non-admin HA user** for the token. It doesn't make
  the token read-only (see above), but it can be revoked on its own without
  touching the user's own sessions, and it keeps admin-only APIs out of reach.
  Say this honestly in the help text; don't imply it makes the token safe.
- **Transport.** The token goes in a header on every request. Plain `http://`
  is acceptable on the LAN, since that's where the Docker/Unraid deployment and
  HA both live. If HA uses a self-signed certificate, Node's `fetch` will
  refuse it. Report that as a clear connection error, and never add a "skip
  TLS verification" switch.
- **What's requested:** only the two configured entities, plus the one-time
  `GET /api/states` for the picker, which does see every entity. The picker
  response is filtered server-side to candidate sensors before it reaches the
  browser, so the house's other entities are never sent to the page.
- **Electron away from home.** The desktop build only reaches HA when HA is
  reachable (home network, or the user's own remote URL). If it isn't, the
  **Read from car** button shows a connection error and everything else works
  as normal. No offline queueing: the reading can be fetched later, from the
  history, as long as it's within recorder retention.

---

## 9. Testing

- **`car-odometer.test.ts`** covers the whole §6.2 table: a telemetry value
  exactly on each window boundary and one second either side; telemetry
  `last_changed` inside the window but its _value_ outside it (stale re-poll,
  which must not `fill`); the odometer changing inside the window (must not
  `fill`); `unavailable`/`unknown`/`0`/`-1` states; a non-km unit; an empty
  history (outside retention); no telemetry entity configured (never `fill`);
  a value below the previous session's odometer; a still-charging window; and
  a window spanning a DST change (instants only, never local strings).
- **`home-assistant.ts`** stays thin enough that it isn't unit tested (the same
  policy as `evnex-client.ts`), but its history parser, which turns
  `minimal_response` arrays into `StateChange[]`, lives in `car-odometer.ts`
  and is tested against a captured, redacted response from the user's HA.
- **`evnex.test.ts`** adds `planImport` cases for the new
  `startedAt`/`endedAt` pass-through and the backfill-on-existing-draft
  path.
- **Playwright** covers the settings card in all three states, the Read from
  car hint (fresh vs. stale), a pre-filled suggestion on a draft, and the
  provenance icon, in light and dark and with CLAUDE.md's `en-GB` locale
  recipe. A dev-only `HA_FAKE=1` stub behind the two `+server.ts` endpoints
  lets this run without a real HA. It's dev-only, and **not** a deployment
  setting.

---

## 10. Phasing

Each phase lands green (`npm run check`, `npm run lint`, `npm run test`).

| #   | Phase                                                                                                            | Notes                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Capture fixtures from the real HA** (about 15 minutes, no code)                                                | `curl` the two entity states and one history window covering a recent overnight charge, then redact VIN and friendly names. This confirms the entity IDs, the telemetry value format, and that a charge window contains at least one fresh telemetry report at the user's poll interval. |
| 1   | Schema: `home_assistant_integration`, `odometer_source`, `started_at`/`ended_at` + the `planImport` pass-through | Migration only, plus the Evnex import populating the instants from then on.                                                                                                                                                                                                              |
| 2   | `car-odometer.ts` pure logic + full Vitest suite                                                                 | No network, no UI. Built against the Phase 0 fixtures.                                                                                                                                                                                                                                   |
| 3   | `home-assistant.ts` + `/settings` card + sensor picker + Test read                                               | First real HA contact.                                                                                                                                                                                                                                                                   |
| 4   | **Read from car** in the Add form and on draft rows                                                              | The first payoff, and useful for public sessions even without Evnex.                                                                                                                                                                                                                     |
| 5   | Auto-fill after **Pull from charger** + provenance icon                                                          | The main payoff: a home session goes from charger to complete with no typing.                                                                                                                                                                                                            |
| 6   | Playwright verification + §12 documentation                                                                      |                                                                                                                                                                                                                                                                                          |

This is materially smaller than the direct-BYD plan (Appendix A). There's no
crypto port, no separate package, no stored BYD password, and no background
scheduler.

---

## 11. Open decisions

| #   | Question                                                                                                | Default if unanswered                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1   | **Go through Home Assistant rather than BYD directly?**                                                 | **Yes** (§2 #1). Revisit only if HA stops being part of the setup; Appendix A has the groundwork for that.     |
| 2   | **Auto-fill after every Pull from charger, or only when a separate "Fill odometers" button is tapped?** | **Automatically.** A `fill` is proven exact (§6.2), and a second button would be a step that's always pressed. |
| 3   | **Fill `settings.vehicleLabel` from HA's car name or VIN?**                                             | **No.** Never write report-identity settings automatically.                                                    |
| 4   | **How stale can "Read from car" be before it warns?**                                                   | **30 minutes**, as a constant in `car-odometer.ts`. Tune it after a billing period of use.                     |

---

## 12. Documentation to update

Owed once this lands:

- **CLAUDE.md, "Key domain logic":** a car-odometer bullet covering the §6.2
  rule (telemetry _value_ inside the charge window, not HA's `last_changed`),
  that charging-state sensors are deliberately ignored, the `km`-only unit
  rule, and the recorder-retention limit.
- **CLAUDE.md, layering convention:** `car-odometer.ts` (pure) and
  `home-assistant.ts` (impure), plus the two new `+server.ts` exceptions
  (`settings/ha-sensors`, `sessions/car-odometer`) and why they exist.
- **CLAUDE.md, "Privacy":** the DB now holds an HA long-lived token, which can
  control the house and car, not just read the odometer. The same "never log,
  render, or return" rule as the Evnex refresh token, stated more strongly.
- **README.md:** a "Car odometer via Home Assistant" section: requires
  `hass-byd-vehicle` (or any HA odometer sensor in km), how to create the
  dedicated user and token, and that it's configured only in `/settings`.
- **No deployment-config changes.** `.env.example`, the `Dockerfile` and the
  Unraid template are untouched.

---

## Appendix A: the direct BYD API route (not taken)

This is recorded so the research isn't lost if Home Assistant ever leaves the
setup. The sources are [`jkaberg/pyBYD`](https://github.com/jkaberg/pyBYD)
(MIT; the library `hass-byd-vehicle` pins as `pybyd==0.0.75`) and
[`TA2k/ioBroker.byd`](https://github.com/TA2k/ioBroker.byd) (MIT, JavaScript),
both building on `Niek/BYD-re`.

- **Region:** the AU API base is `https://dilinkappoversea-au.byd.auto`, with
  country code `AU`.
- **Wire format:** four layers. There's AES-128-CBC with a zero IV on the
  inner JSON (the key is `MD5(MD5(password))` at login and `MD5(encryToken)`
  after), a nonstandard "mixed-case" SHA-1 signature over sorted fields, and
  an MD5 "checkcode" over the exact outer JSON serialization, so key order
  matters. The outer layer is a **"Bangcle" envelope**: white-box AES using
  about 830 KB of lookup tables extracted from BYD's Android native library.
  If BYD rotates those tables, every client breaks. ioBroker's
  `lib/bangcle.js` is a working JS implementation to port from.
- **Login** (`/app/account/login`) sends the **plaintext password** (as
  `signKey`, inside the envelope) and returns `{userId, signToken,
encryToken}`. **There's no refresh token.** Session-expired codes
  `1002`/`1005`/`1010` mean logging in again with the password, so the
  password would have to be stored.
- **One live session per account.** Signing in logs out other clients on the
  same account (the HA README warns about this). This app would therefore
  need its own shared BYD account, separate from both the phone app's and
  HA's.
- **Odometer:** `totalMileage` (km) is on both the vehicle list
  (`/app/account/getAllListByUserId`, one call, freshness unknown) and the
  realtime trigger/poll pair
  (`/vehicleInfo/vehicle/vehicleRealTimeRequest` → `…RealTimeResult`, up to
  about 15 s, with a `time` field for the car's timestamp). `0` and `-1` are
  "no data" placeholders.
- **Other obligations:** a persisted fake Android device profile (HA
  generates one per account from a device pool), an `appVersion` string that
  upstream bumps as BYD updates its app, and battery drain if the car is
  polled while asleep (HA measured about 0.1 kWh/h at a 300 s interval).
- **Estimated shape:** a separate `byd-client` npm package (a narrow pyBYD
  port with golden test vectors generated from pyBYD), a stored BYD password,
  and eventually a background sampler to get readings during charges. That's
  several times the work of this plan, for the same number.
