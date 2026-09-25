# BYD Odometer Integration (Home Assistant companion) — Design & Implementation Plan

Status: **scoped, not started.** Confirmed: the user already runs the
[`hass-byd-vehicle`](https://github.com/jkaberg/hass-byd-vehicle) Home Assistant
integration, and it reads the odometer from this car. Approach chosen by the
user: a small companion Home Assistant integration exposing one narrowly
scoped, read-only endpoint (§2). HA is reached through one HTTPS URL
everywhere: a custom domain on Home Assistant Cloud (Nabu Casa), CNAMEd, with
split-horizon DNS pointing it at the local instance at home (§4.5).
Branch: `claude/byd-car-km-integration-pd6prj`

Builds on [EVNEX-INTEGRATION-PLAN.md](EVNEX-INTEGRATION-PLAN.md), which already
made the odometer nullable, added the draft-session flow, and set the pattern
for an integration configured through `/settings` that behaves identically on
every deployment. See [§12](#12-documentation-to-update) for the documentation
edits owed once this lands.

---

## 1. Why

Since the Evnex integration, a home session arrives as a draft that already has
date, time, kWh and location. The one thing left to type is the **odometer**,
and the charger has no way to know it. The car does, and the user's Home
Assistant already records it every few minutes.

Goal: **fill in the odometer from the car so a home session needs no typing at
all**, and let a manually-logged public session fetch the reading with a tap
instead of the user reading the dash.

Non-goals: anything else the car or Home Assistant exposes. This integration
reads one number and the time the car reported it.

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **A companion HA integration, `ev_charging_log`, exposes one read-only endpoint**: `GET /api/ev_charging_log/odometer`. It returns the recorded history of exactly two entities (the odometer and the car's telemetry timestamp), chosen in its setup screen. It has no other endpoints, calls no services, and can't be pointed at any other entity from the request. It lives in its own repo and installs from HACS as a custom repository, the same way the user installed `hass-byd-vehicle`. |
| 2   | **The only credential is a secret scoped to that endpoint.** The app generates it, the user pastes it into the companion's setup screen once, and HA stores only its SHA-256 hash. If it leaks, the most anyone can do is **read odometer history**. It can't unlock the car, read other entities, or call services. This replaces the unscoped long-lived HA token that an earlier revision of this plan would have needed (Appendix B).                                                          |
| 3   | **The app pulls; HA never pushes.** That's what makes the **Electron desktop build work the same as the server deployment**: whenever the app runs and can reach HA, it asks for the history it needs. Readings from while the desktop app was closed aren't lost, because HA's recorder already has them (§4.4).                                                                                                                                                                                  |
| 4   | **The companion is deliberately simple; the logic lives in this app.** The companion checks the secret, reads the recorder, and returns raw state changes. Pairing telemetry with odometer values and deciding what fills a session are pure TypeScript in `src/lib/server/car-odometer.ts`, unit tested like `evnex.ts`. That keeps the Python small (about 150 lines) and rarely touched.                                                                                                        |
| 5   | **A reading is only written to a session automatically when it provably belongs to that session**, meaning the car reported it while that charge was running (§6.2). Anything else pre-fills the odometer field as a suggestion the user confirms. Odometer values end up on the lease report, and a silently wrong value is worse than an empty one.                                                                                                                                              |
| 6   | **No new app dependency and no new deployment configuration.** The HA URL and secret are entered in `/settings`, identically on Docker/Unraid and Electron.                                                                                                                                                                                                                                                                                                                                        |

## 3. What the user does, end to end

One-time setup:

1. In HACS, adds the companion repo as a custom repository, installs **EV
   Charging Log companion**, and restarts HA.
2. In the app's `/settings`, under a new **Car odometer (Home Assistant)**
   heading, enters the HA URL (for example `https://ha.example.com`) and
   taps **Generate secret**. The secret is shown with a Copy button.
3. In HA, goes to Settings → Devices & services → Add integration → **EV
   Charging Log companion**. Picks the **Odometer** and **Telemetry last
   updated** sensors (the picker only offers distance and timestamp sensors)
   and pastes the secret.
4. Back in the app, taps **Test**. It shows "118,204 km — car reported 6 min
   ago", which the user can check against the dash. The integration is then
   switched on and saved.

Day to day:

- **Home, with Evnex:** taps **Pull from charger** on `/sessions` as today.
  Straight after the import, the page asks HA for the odometer history
  covering the open drafts' charge windows. Every draft whose charge the car
  reported during gets its exact odometer and completes. The rest get a
  **From car** suggestion in their _Add odometer_ field.
- **Public, or home without Evnex:** in the Add form, taps **Read from car**
  next to the Odometer field. It fills with the current value and a hint
  showing how old the car's data is.
- **Away from home (desktop app):** nothing changes. The same URL reaches HA
  through Home Assistant Cloud (§4.5). If HA can't be reached at all (HA down,
  no internet, or the Cloud subscription has lapsed), the buttons show "Home
  Assistant unreachable" and everything else works as normal. Drafts can be
  filled later, as long as their charges are still within HA's recorder
  retention (10 days by default).

---

## 4. The Home Assistant side

### 4.1 What `hass-byd-vehicle` provides

From `custom_components/byd_vehicle/sensor.py` and `translations/en.json`:

| Entity (name in HA)        | Key             | Details                                                                                                                      |
| -------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Odometer**               | `total_mileage` | `device_class: distance`, `state_class: total_increasing`, native unit `km`, integer-rounded, from the realtime poll.        |
| **Telemetry last updated** | `last_updated`  | `device_class: timestamp`, diagnostic. Its _state_ is when the car produced the realtime data, as opposed to when HA polled. |

HA's default poll interval for `hass-byd-vehicle` is 300 s. The telemetry
timestamp changes on every car report, including while the car sits on the
charger with an unchanged odometer. Those unchanged reports during a charge
are the evidence §6.2 needs, and HA's recorder keeps every one of them.

The companion doesn't depend on `hass-byd-vehicle` specifically. Any distance
sensor in km plus a car-timestamp sensor works.

### 4.2 The companion integration (`ev_charging_log`)

It lives in its own repo (e.g. `brianramseyau/ha-ev-charging-log`), laid out
like `hass-byd-vehicle`: `custom_components/ev_charging_log/`, `hacs.json`, and
the hassfest and HACS validation workflows.

| File             | Contents                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.json`  | `domain: ev_charging_log`, `config_flow: true`, `dependencies: ["http", "recorder"]`, `iot_class: local_push` (it serves data rather than polling anything), no `requirements`.                                                                                                                                                                                                       |
| `config_flow.py` | One step: an entity selector for the odometer (filtered to `device_class: distance`), one for the telemetry timestamp (filtered to `device_class: timestamp`), and a password-type field for the secret (at least 32 characters). Stores `sha256(secret)`, never the secret. An **options flow** replaces the secret (rotation) or changes the entities. `single_config_entry: true`. |
| `__init__.py`    | On setup, registers one `HomeAssistantView`; on unload, marks it inactive. HA can't unregister views, so the view checks for a loaded entry on every request and returns `404` if there isn't one.                                                                                                                                                                                    |
| `view.py`        | The endpoint, §4.3.                                                                                                                                                                                                                                                                                                                                                                   |

The view sets `requires_auth = False` so that HA's own token isn't required.
Instead, it checks for `Authorization: Bearer <secret>` and compares
`sha256(secret)` to the stored hash with `hmac.compare_digest`. A mismatch
gets a plain `401`.

It deliberately does **not** call HA's `process_wrong_login(request)`, even
though that would feed failures into HA's IP ban. Behind Home Assistant Cloud
or a local reverse proxy, HA may see every request as coming from the same
relay or proxy address, unless `trusted_proxies` is set up exactly right. A
stale secret in the app could then get the relay's address banned, which would
lock the user out of their whole HA, not just this endpoint. It's also
unnecessary: the secret is 256 random bits, so guessing it isn't a realistic
attack, and rate-limiting adds nothing.

Reading history uses the recorder's own API off the event loop:
`get_instance(hass).async_add_executor_job(history.state_changes_during_period, …)`,
with the start-time state included, for the two configured entity IDs only.
The entity IDs come from the config entry and never from the request, so a
leaked secret can't be used to read anything else.

### 4.3 The endpoint: `GET /api/ev_charging_log/odometer`

```http
GET /api/ev_charging_log/odometer?start=2026-09-21T00:00:00Z&end=2026-09-24T09:00:00Z
Authorization: Bearer <secret>
```

```json
{
	"version": 1,
	"odometer": {
		"unit": "km",
		"changes": [
			{ "state": "118102", "at": "2026-09-21T00:00:00+00:00" },
			{ "state": "118204", "at": "2026-09-23T08:41:10+00:00" }
		]
	},
	"telemetry": {
		"changes": [
			{ "state": "2026-09-20T22:59:31+00:00", "at": "2026-09-21T00:00:00+00:00" },
			{ "state": "2026-09-23T08:40:52+00:00", "at": "2026-09-23T08:41:10+00:00" }
		]
	},
	"oldestRecorded": "2026-09-14T03:00:00+00:00"
}
```

- `start` and `end` are optional. By default `end` is now and `start` equals
  `end`, which returns just the current state for **Read from car**. The
  window is capped at 31 days, and `start` must be before `end`. Anything else
  gets a `400`.
- The first entry in each `changes` array is the state in effect at `start`,
  with `at` clamped to `start`. That's how the recorder reports the
  start-time state, and it's what the app needs for "what did the odometer
  read at plug-in?".
- `state` is passed through verbatim, including `unavailable`/`unknown`. The
  app decides what's usable (§6.1), not the companion.
- `unit` is the odometer entity's current `unit_of_measurement`.
- `oldestRecorded` tells the app where history runs out, so it can say "too
  old to look up" instead of "no data".
- `version` lets the app detect an incompatible companion and show "update
  the companion" rather than misreading the response.
- Every response sets `Cache-Control: no-store`. A `401` has an empty body.
  If no entry is configured, the response is `404`.

### 4.4 Recorder retention and exclusions

The recorder keeps 10 days of history by default (`purge_keep_days`). The
Evnex lookback defaults to 3 days, so an ordinary flow is well inside that. A
draft whose charge has aged out gets `skip`, reason `too_old` (§6.2). If the
user has excluded either entity from the recorder, `changes` comes back empty.
The companion's config flow warns about that at setup time, by checking the
recorder's entity filter.

### 4.5 Remote access: Home Assistant Cloud with a custom domain

The user's HA is reached through one hostname everywhere. It's a custom
domain on Home Assistant Cloud (Nabu Casa's remote UI, CNAMEd to their
relay). At home, split-horizon DNS resolves the same name to the local
instance, which also serves a valid certificate. So the app stores **one**
`https://` URL, and the Docker server and the desktop app (at home or away)
all use it unchanged. That's the setup this plan targets, and none of it is
special-cased in code: the app just calls a URL.

What this means for the design:

- **The companion's endpoint is reachable from the internet.** The Cloud
  remote UI relays every HTTP path to HA, custom integration views included.
  The scoped secret (§2 #2) is what makes that acceptable, and it's the main
  reason the companion exists rather than exposing a broad token. The relay
  is end-to-end encrypted to the HA instance, so Nabu Casa's servers never
  see the secret in the clear.
- **Only HTTPS URLs are accepted, with one exception.** The app rejects an
  `http://` base URL unless the host is a private-range IP address or
  `localhost`. A secret sent as a header must not cross the internet in
  plaintext, and this makes that mistake impossible to save.
- **Certificates are verified normally.** Node's `fetch` checks the
  certificate against its bundled CA list, which covers a public CA such as
  Let's Encrypt on both paths. There's no "skip TLS verification" switch.
  The Electron build runs the same server code on its bundled Node, so the
  behaviour is the same there.
- **The relay adds latency.** The timeout is 10 s (§6), not the 5 s you'd
  pick for a LAN-only call. Recorder queries for a few days of two entities
  are small, so there's plenty of headroom.
- **If the Cloud subscription lapses,** only the away-from-home path breaks.
  At home, split DNS still reaches the local instance. The app just reports
  "unreachable" when away, with no data loss (§3).
- **Phase 0 checks both paths** (§10): the endpoint over the Cloud relay from
  outside the LAN (a phone hotspot), and over split DNS from inside it.

### 4.6 Maintaining the companion

It's a second codebase, but a small one. The HA internals it touches (views,
config flows, the recorder history API) are the same ones HA's own core
integrations use, so they change rarely and with deprecation warnings.
`hacs.json` pins a minimum HA version, and the CI runs hassfest plus
`pytest-homeassistant-custom-component` tests against current HA. Expect to
bump it a few times a year.

---

## 5. App data model

New table **`car_odometer_integration`**, a single row following the same
pattern as `evnex_integration`:

```ts
export const carOdometerIntegration = sqliteTable('car_odometer_integration', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	baseUrl: text('base_url'), // e.g. https://ha.example.com; https required (§4.5)
	secret: text('secret'), // companion secret; scoped to reading odometer history (§8)
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
	lastReadAt: text('last_read_at'),
	lastSuccessAt: text('last_success_at'), // drives the 3-day escalation, §7.3
	lastReadStatus: text('last_read_status', {
		enum: ['ok', 'auth_failed', 'unreachable', 'companion_missing', 'companion_outdated', 'no_data']
	}),
	lastReadError: text('last_read_error')
});
```

There's no readings table. The recorder is the history, and the app asks for
exactly the windows it needs.

**`charging_sessions`** gets two changes:

1. **`odometer_source`**: `text('odometer_source', { enum: ['manual', 'car'] })`,
   nullable, with existing rows staying `NULL` (which reads as manual). It
   answers "where did this odometer figure come from?" for the lease company,
   and the history list's provenance icon (§7.4) reads it. This is the
   "source column" the Evnex plan deferred until a second integration
   appeared (EVNEX-INTEGRATION-PLAN.md §12 #2), scoped to the one field it
   concerns.
2. **`started_at` / `ended_at`**: nullable ISO UTC instants, filled by the Evnex
   import from `startDate`/`endDate`. Imported drafts currently keep only local
   `date`/`time`, and converting those back into instants breaks across DST
   changes (the Evnex plan's §6.3 trap run in reverse). A still-open imported
   draft gets them on its next poll, through a small `planImport` addition
   alongside the existing kWh-update path.

All three changes are a new table or plain `ADD COLUMN`s, so there's no table
rebuild and the foreign-key caveat in `db/index.ts` doesn't come into play.

---

## 6. Matching logic: `src/lib/server/car-odometer.ts`

This is pure and dependency-free, like `evnex.ts`, with a co-located
`car-odometer.test.ts`. The impure edge, `car-odometer-client.ts`, is one
`fetch` with a 10 s timeout (the Cloud relay adds latency; §4.5) plus
response-shape checks.

### 6.1 `toReadings(response)`: pairing the two histories

This turns the companion's two change lists into
`{ km: number; carReportedAt: string }[]`, one reading per telemetry change:

- `carReportedAt` is the telemetry change's **state** (the car's timestamp),
  not its `at` (when HA recorded it). HA can re-poll and record the same stale
  cloud data while the car is asleep. Only the car's own timestamp says when
  the car was in that state.
- `km` is the odometer state in effect at that telemetry change's `at`.
- A reading is dropped if either state is unusable. The `km` value must parse
  as a finite number `> 0`, so `unavailable`, `unknown`, `0` and `-1` are out.
  The `unit` must be exactly `km`: HA can convert units into the display
  system, and a miles/km mixup on a lease report is worse than a gap.
- Duplicate `carReportedAt` values (the same report recorded twice) collapse
  to one reading.

### 6.2 `planOdometerFill(drafts, readings, neighbours, oldestRecorded)`

The car can't move while it's charging. So a reading the car reported inside
a charge's `[startedAt, endedAt]` is exactly that session's plug-in odometer.

| Outcome   | When                                                                                                                                                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fill`    | At least one reading has `carReportedAt` inside `[startedAt, endedAt]` (a still-charging session counts as `endedAt = now`), **and** every reading inside the window has the same `km` (the car didn't move), **and** it passes `isOdometerBelowLastRecorded` against the session's neighbours. Written with `odometer_source = 'car'`. |
| `suggest` | No reading inside the window, but there's a reading at or before `startedAt` (the latest such one) that passes the neighbour check. The value is pre-filled in the draft's input with the hint _"From car — not confirmed during this charge"_, and is never saved without the user tapping it.                                         |
| `skip`    | `too_old` (the window starts before `oldestRecorded`), `no_data`, `inconsistent` (readings disagree inside the window), or `below_previous`.                                                                                                                                                                                            |

Deliberately **not** used as evidence: the BYD charging-state sensors. `pyBYD`
itself notes that the "gun connected" value "does not change when the
charging gun is disconnected". Timestamps and odometer ordering are the only
evidence the rule uses.

### 6.3 One request per pull

Before calling the companion, the app computes a single `[start, end]` that
covers every open imported draft: from the earliest `startedAt`, clamped to
31 days back, until now. It makes one request and matches every draft
locally. **Read from car** makes a separate request with no `start`, so it
gets just the current state.

---

## 7. UI

### 7.1 `/settings`: "Car odometer (Home Assistant)" heading

- **Not set up:** the HA URL field, **Generate secret** (showing the secret
  with a Copy button and a link to the companion's install instructions), and
  **Test**.
- **Set up:** the enabled switch, the last-read status line, **Test**, and
  **Rotate secret**. Rotating generates a new secret and shows it for pasting
  into the companion's options flow; the old one stops working as soon as HA
  saves the new one. Once saved, the secret is masked. It's needed for every
  request, so it can't be write-only the way the Evnex password is, but it's
  never shown again after setup.
- **Errors**, each with a specific message: `401` means "secret doesn't match —
  paste it again in HA"; `404` means the companion isn't installed or
  configured; a `version` mismatch means "update the companion"; a timeout
  means HA is unreachable. A certificate error shows up as a connection
  error: there's no "skip TLS verification" switch.
- **After a `401`, automatic calls stop, and the app says so loudly.**
  `lastReadStatus = 'auth_failed'` stops Pull from charger from calling the
  companion until **Test** succeeds again. That way, changing the secret in
  only one of the two places doesn't turn every pull into a failed request.
  Stopping must never be silent, though. §7.3 covers how it's shown
  everywhere the feature is used.

**Test** calls `src/routes/settings/car-odometer/+server.ts` with `fetch`
rather than running in `load`, for the same reason as `charge-points/+server.ts`:
a network dependency mustn't block page render.

### 7.2 `/sessions`

- **Add form:** a small **Read from car** icon button next to the Odometer
  field, shown when the integration is enabled. It calls
  `src/routes/sessions/car-odometer/+server.ts`, fills the field, and shows
  _"From car, reported 3 min ago."_ If the car's data is more than 30 minutes
  old, the hint becomes a warning: _"Car last reported 2 days ago — check this
  matches the dash."_ The saved row gets `odometer_source = 'car'` only if the
  submitted value still equals the fetched one; otherwise the user edited it,
  and it counts as `manual`. The existing below-last-recorded warning still
  applies.
- **Pull from charger:** after the Evnex form action returns, the page posts
  to the same endpoint with `?apply=1`. The server runs §6.3, writes the
  `fill`s, and returns the `suggest`ions to pre-fill. The two stay as separate
  requests so that HA being slow or unreachable never delays or fails an
  Evnex import. The result message gains "…N
  odometers filled from car", or "Home Assistant unreachable — odometers not
  filled".
- **Draft rows:** suggestions show pre-filled in _Add odometer_ with their
  hint. Each draft also gets a **Read from car** button. It runs the history
  rule for that one draft when the draft has `started_at`, and reads the
  current value otherwise.

### 7.3 A broken integration must be obvious

When odometers stop filling, the user notices by _not_ noticing: drafts just
quietly go back to needing typed odometers. So a broken setup gets surfaced
wherever the feature would have acted, not only on `/settings`.

Two kinds of failure, treated differently:

| Kind                                                              | Statuses                                                         | Why                                                                                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Broken:** needs the user to fix something, and won't fix itself | `auth_failed`, `companion_missing` (`404`), `companion_outdated` | Retrying can't help, and calls are paused (§7.1).                                      |
| **Transient:** likely to fix itself                               | `unreachable`, timeouts, `5xx`                                   | HA restarting, no internet, or the relay briefly down. The next call may well succeed. |

**Broken**, while the integration is enabled:

- **A persistent warning banner on `/sessions`**, above the history list,
  using the same error colour as the rest of the app in both themes. It
  reads: _"Car odometer paused — Home Assistant rejected the secret. Odometers
  won't fill from the car until it's fixed."_ It has a **Fix in Settings**
  button, and a message specific to each status (not installed: "The Home
  Assistant companion isn't installed or set up"; outdated: "Update the Home
  Assistant companion"). It can't be dismissed. It goes away only when the
  status stops being broken: after a successful **Test**, or when the
  integration is switched off.
- **The Pull from charger result** carries the same message instead of "…N
  odometers filled from car". So a pull that imports sessions but skips
  odometers says why, in the place the user is looking.
- **The Read from car buttons** stay visible but show an error state (a
  warning icon instead of the car icon, with the reason as a tooltip). Tapping
  one opens the same message with the **Fix in Settings** link. It doesn't make
  a request, because the button existing is itself how the user notices.
- **A warning dot on the Settings item in the navigation**, since `/settings`
  is where the fix happens and the rest of the app has to point there.
- **In `/settings`,** the card opens in its error state, with the reason in
  plain words, the time of the last successful read, and **Test** as the
  primary action.

**Transient:** reported where it happened, without a banner.

- The Pull result says "Home Assistant unreachable — odometers not filled",
  and Read from car shows the same message inline.
- **It escalates to a banner if it doesn't clear.** If there hasn't been a
  successful read for 3 days while calls kept failing, the `/sessions` banner
  appears with _"Can't reach Home Assistant since Tue 23 Sep"_. Three days
  matches the Evnex lookback: past that point, charges start slipping out of
  what the next pull could still fill. This requires `lastSuccessAt` alongside
  `lastReadAt` in `car_odometer_integration` (§5).

All of this is driven by `load` data (the integration row's status), never by
a network call on page load. The banner shows whether or not HA is up right
now, and costs nothing to render.

The banner, nav dot and error-state button are built generically: a
`status`, a message and a link. The Evnex integration can then show its
existing `auth_failed` state the same way. Today Evnex only shows that on
`/settings`, so it has the same "silently stops" gap (§11 #5).

### 7.4 Provenance icon

A session whose `odometer_source === 'car'` gets a small car icon beside the
km figure in the history list, with a tooltip ("Odometer reported by the car
via Home Assistant"). It's an icon rather than another coloured chip because
the chip slot already carries kind. Screenshot it in both themes (CLAUDE.md
"Browser testing").

---

## 8. Security summary

| Credential       | Where it lives                                                           | What a leak allows                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companion secret | Plaintext in the app DB (it has to be sent); only its SHA-256 hash in HA | Reading the odometer and car-report timestamps, within recorder retention. That reveals when the car moved and how far, but nothing else: no location, no other entities, no control. |
| HA token         | **Nowhere.** None is created.                                            | n/a                                                                                                                                                                                   |

- The secret is 32 random bytes (`crypto.randomBytes`), base64url. It's never
  returned by a `load` function or rendered after setup, and never logged,
  including in error messages from a failed `fetch`.
- It's sent as a header, over HTTPS with a valid certificate, whether through
  the Home Assistant Cloud relay or split DNS at home (§4.5). Plain `http://`
  is refused except to a private-range IP address.
- The endpoint is reachable from the internet through the Cloud relay,
  protected only by the secret. That's acceptable because the secret is 256
  random bits and its blast radius is the table row above. It's deliberately
  not wired into HA's IP ban (§4.2).

---

## 9. Testing

- **The companion repo:** `pytest-homeassistant-custom-component` tests for
  the config flow (only the hash is stored; entity filters), `401` with a bad
  or missing secret, `404` with no entry, requests that try to name another
  entity (ignored), the 31-day window cap, and a history response built from
  states written in the test. hassfest and HACS validation run in CI.
- **`car-odometer.test.ts`:**
  - `toReadings`: pairing (the odometer changes before, at, and after a
    telemetry change); `unavailable`/`unknown`/`0`/`-1`; a non-km unit;
    duplicate reports; and a telemetry `at` inside a window while its _state_
    is outside it (a stale re-poll).
  - `planOdometerFill`, the whole §6.2 table: a reading exactly on each window
    boundary and one second either side; readings disagreeing inside a
    window; a still-charging window; `too_old` against `oldestRecorded`; a
    value below the previous session's odometer; several drafts sharing one
    response; and a window spanning a DST change (instants only).
  - The `version` check and response-shape validation.
- **`evnex.test.ts`:** `planImport` cases for the `startedAt`/`endedAt`
  pass-through and the backfill-on-existing-draft path.
- **Playwright:** the settings card in all states, the Read from car hint
  (fresh vs. stale), a pre-filled suggestion on a draft, the unreachable
  message, every §7.3 broken state (the banner, the nav dot, the error-state
  buttons, and the banner clearing after a successful Test), the 3-day
  escalation, and the provenance icon, in light and dark and with CLAUDE.md's
  `en-GB` locale recipe. A dev-only `CAR_ODOMETER_FAKE=1` stub behind the two
  `+server.ts` endpoints serves a fixture response. It's dev-only, and **not**
  a deployment setting.

---

## 10. Phasing

Each app phase lands green (`npm run check`, `npm run lint`, `npm run test`).

| #   | Phase                                                                                                              | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Capture a real history by hand** (about 15 minutes, no code)                                                     | Using the user's own browser session or a temporary token that's deleted right after, `curl` HA's built-in `/api/history/period` for the two entities over a recent overnight charge, once through the Cloud URL from outside the LAN (a phone hotspot) and once from inside it. This confirms both network paths (§4.5), the entity IDs, the telemetry timestamp format, and that the charge window contains several unchanged odometer readings at the user's poll interval. The redacted output becomes the fixture for both repos. The temporary token never goes near the app. |
| 1   | **The companion integration** (its own repo)                                                                       | View, config flow, options flow, tests, HACS metadata. Ends with the user installing it from HACS and `curl`-ing the endpoint with the secret.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2   | App schema: `car_odometer_integration`, `odometer_source`, `started_at`/`ended_at` + the `planImport` pass-through | Migration only, plus the Evnex import populating the instants from then on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3   | `car-odometer.ts` pure logic + full Vitest suite                                                                   | No network, no UI. It can run in parallel with Phase 1, using the Phase 0 fixture.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 4   | `car-odometer-client.ts` + the `/settings` card + Test                                                             | First real contact with the companion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5   | **Read from car** in the Add form and on draft rows                                                                | The first payoff, and useful for public sessions even without Evnex.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 6   | Auto-fill after **Pull from charger** + provenance icon                                                            | The main payoff: a home session goes from charger to complete with no typing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 7   | Playwright verification (server and Electron builds) + §12 documentation                                           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## 11. Open decisions

| #   | Question                                                                                             | Default if unanswered                                                                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Auto-fill after every Pull from charger, or only behind a separate button?**                       | **Automatically.** A `fill` is proven exact (§6.2), and a second button would be a step that's always pressed.                                                 |
| 2   | **How stale can "Read from car" be before it warns?**                                                | **30 minutes**, as a constant. Tune it after a billing period of use.                                                                                          |
| 3   | **Publish the companion to the default HACS store, or keep it as a custom repository?**              | **Custom repository.** It's built for this app. Publishing brings review requirements and users to support.                                                    |
| 4   | **Fill `settings.vehicleLabel` from the car?**                                                       | **No.** Never write report-identity settings automatically, and the endpoint doesn't return the VIN anyway.                                                    |
| 5   | **Should the Evnex integration's `auth_failed` get the same `/sessions` banner and nav dot (§7.3)?** | **Yes, as a small follow-up** once the shared banner component exists. It's the same "silently stops" gap, and the Evnex refresh token will expire eventually. |

---

## 12. Documentation to update

Owed once this lands:

- **CLAUDE.md, "Key domain logic":** a car-odometer bullet covering the §6.2
  rule (the car's own timestamp inside the charge window, never HA's recorded
  time), that charging-state sensors are deliberately ignored, the `km`-only
  unit rule, and recorder retention. Also a "do not" note: don't replace the
  companion with a long-lived HA token "to simplify setup". The scoped secret
  is the reason the companion exists (Appendix B).
- **CLAUDE.md, layering convention:** `car-odometer.ts` (pure),
  `car-odometer-client.ts` (impure), and the two new `+server.ts` exceptions
  (`settings/car-odometer`, `sessions/car-odometer`) and why they exist.
- **CLAUDE.md, "Privacy":** the DB holds the companion secret. It's
  low-sensitivity compared to the Evnex refresh token (read-only, odometer
  only), but the same "never log, render, or return" rule applies.
- **README.md:** a "Car odometer via Home Assistant" section covering what it
  needs (`hass-byd-vehicle`, or any km odometer plus a car-timestamp sensor),
  a link to the companion repo, and the setup flow.
- **No deployment-config changes.** `.env.example`, the `Dockerfile`, the
  Unraid template and Electron's `config.json` are untouched.

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

## Appendix B: Home Assistant approaches considered

| Option                                                                       | Outcome                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **App pulls from HA's REST API with a long-lived token**                     | Rejected. HA tokens have no scopes: even a non-admin HA user's token can read every entity and call every service, which with `hass-byd-vehicle` includes unlocking the car. That's too much to store for reading two sensors.                                                              |
| **HA pushes to the app** (automation + `rest_command` to an app endpoint)    | Rejected. It has no HA credential and needs no custom code, but the desktop app is only running while it's open and listens on `127.0.0.1` on a random port (`electron/main.cjs`), so HA can't reach it and would miss overnight charges anyway. The Electron build would lose the feature. |
| **MQTT** (HA publishes, the app subscribes with a topic-scoped broker login) | A viable runner-up. It works with the desktop app too, because the broker queues messages while the app is closed. But it needs a broker with access rules, a long-lived subscriber inside the app, and queue limits tuned so a few days offline doesn't drop readings.                     |
| **A readings file in HA's `/local/` folder under a random path**             | Rejected. `/local/` is served without authentication, so the path is the only protection, and it's exposed to the internet whenever HA is.                                                                                                                                                  |
| **An HA webhook trigger**                                                    | Not applicable. Webhooks push data _into_ HA and return nothing useful to the caller.                                                                                                                                                                                                       |
| **Companion integration with a scoped secret**                               | **Chosen** (§2).                                                                                                                                                                                                                                                                            |
