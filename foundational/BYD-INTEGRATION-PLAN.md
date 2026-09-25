# BYD Odometer Integration (Home Assistant push) — Design & Implementation Plan

Status: **scoped, not started.** Confirmed: the user already runs the
[`hass-byd-vehicle`](https://github.com/jkaberg/hass-byd-vehicle) Home Assistant
integration, and it reads the odometer from this car.
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
all**, and let a manually-logged public session pick up the latest reading with
a tap instead of the user reading the dash.

Non-goals: anything else the car or Home Assistant exposes. This integration
receives one number and the time the car reported it.

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Home Assistant pushes readings to the app; the app never calls Home Assistant.** An HA automation fires whenever the car reports fresh telemetry and sends `{ km, unit, carReportedAt }` to one endpoint on this app, using HA's built-in `rest_command`. The app holds **no Home Assistant credential at all**. See §4 for why pulling was rejected.                                                          |
| 2   | **The only credential is a push secret that this app generates.** It can do exactly one thing: add an odometer reading. The app stores only its SHA-256 hash, so it's shown once, at generation. It lives in HA's `secrets.yaml`. If it leaks, the worst an attacker can do is post false odometer readings, and the matching rules in §6.2 would treat any that disagree with neighbouring sessions as suspect. |
| 3   | **The app keeps its own history of readings** in a `car_odometer_readings` table. Matching a reading to a charge (§6) runs entirely on local data: no network call at match time, and no dependence on how long HA's recorder keeps history.                                                                                                                                                                     |
| 4   | **A reading is only written to a session automatically when it provably belongs to that session**, meaning the car reported it while that charge was running (§6.2). Anything else pre-fills the odometer field as a suggestion the user confirms. Odometer values end up on the lease report, and a silently wrong value is worse than an empty one.                                                            |
| 5   | **Works only on the server deployment (Docker/Unraid).** HA can reach a server on the LAN, but not the Electron desktop app, which listens on `127.0.0.1` on a random port and keeps its own database (`electron/main.cjs`). The desktop build hides the feature (§11 #1).                                                                                                                                       |
| 6   | **No new dependency and no new deployment configuration.** The endpoint is a `+server.ts` route, and the secret is generated in `/settings`.                                                                                                                                                                                                                                                                     |

## 3. What the user does, end to end

One-time setup:

1. Opens `/settings` and finds a new **Car odometer (Home Assistant)** heading
   below the Evnex one. Enters the two entity IDs from HA (the BYD
   **Odometer** sensor and its **Telemetry last updated** sensor), which the
   app only uses to fill in the snippet, and taps **Generate push secret**.
2. The page shows, **once**, a ready-to-paste block: a `secrets.yaml` line
   holding the secret, plus the `rest_command` and automation YAML with this
   app's URL and the two entity IDs already filled in (§5.3). A **Copy**
   button is next to each. A note warns that the secret won't be shown again,
   and that generating a new one replaces it.
3. Pastes the YAML into HA and reloads (or restarts) it.
4. Back in `/settings`, the status line changes from "Waiting for first
   reading…" to "Last reading 118,204 km — car reported 4 min ago, received
   4 min ago" the first time the car reports. That's the setup check: there's
   no separate Test button, because the app can't ask HA for anything.

Day to day:

- **Home, with Evnex:** taps **Pull from charger** on `/sessions` as today.
  Straight after the import, the same server action runs odometer matching
  over local readings. Every draft whose charge the car reported during gets
  its exact odometer and completes. The rest get a **From car** suggestion in
  their _Add odometer_ field.
- **Public, or home without Evnex:** in the Add form, taps **Use latest from
  car** next to the Odometer field. It fills with the most recent reading and
  a hint showing its age (§7.2). It reads the app's own table, so it's
  instant and works even if HA is down.

---

## 4. Why push, and what was rejected

| Option                                                                                   | Why not                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **App pulls from HA's REST API with a long-lived token** (this plan's previous revision) | HA tokens have no scopes. Even a non-admin HA user's token can read every entity and call every service, which with `hass-byd-vehicle` includes unlocking the car. Storing that in a database that's only protected by file permissions, to read two sensors, is a poor trade. |
| **HA webhook trigger, called by the app**                                                | HA webhooks run an automation and return nothing useful, so the app would still get no data back. They're for pushing _into_ HA, the wrong direction.                                                                                                                          |
| **A reverse proxy in front of HA that only allows `GET /api/states/<two ids>`**          | It would work, but it adds infrastructure (another container, config, and the real token stored in the proxy) to get what push gives for free.                                                                                                                                 |
| **MQTT (HA publishes to a broker, the app subscribes)**                                  | It would need a broker, and a long-lived subscriber inside a request/response SvelteKit server. It's more moving parts than a single HTTP POST.                                                                                                                                |
| **Direct BYD API**                                                                       | See [Appendix A](#appendix-a-the-direct-byd-api-route-not-taken): an obfuscated protocol, a stored plaintext BYD password, and a second BYD account.                                                                                                                           |

What push costs, stated plainly:

- **The app must be reachable from HA**, so this is server deployment only
  (§2 #5).
- **Pushes are fire-and-forget.** If the app is down (restarting, updating)
  when the car reports, that reading is lost. HA's `rest_command` doesn't
  retry. That's tolerable: the car reports every poll interval (HA's default
  is 300 s), and a home charge lasts hours, so one missed push almost never
  empties a charge window. When it does, the draft falls back to a
  suggestion, which is safe.
- **"Read from car" means "latest reading HA sent", not a fresh live read.**
  In practice that's the same thing: HA's own state is only as fresh as its
  last poll anyway.
- **Readings from before setup don't exist.** Drafts older than the first push
  get suggestions at best. There's no backfill from HA history, since that
  would need the HA token this design exists to avoid.

---

## 5. The push contract

### 5.1 What `hass-byd-vehicle` exposes

From `custom_components/byd_vehicle/sensor.py` and `translations/en.json`:

| Entity (name in HA)        | Key             | Details                                                                                                                    |
| -------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Odometer**               | `total_mileage` | `device_class: distance`, `state_class: total_increasing`, native unit `km`, integer-rounded, from the realtime poll.      |
| **Telemetry last updated** | `last_updated`  | `device_class: timestamp`, diagnostic. Its state is when the car produced the realtime data, as opposed to when HA polled. |

Entity IDs depend on the car's name in HA (something like
`sensor.sealion_7_odometer`), which is why the user types them in once for the
snippet.

### 5.2 Endpoint: `POST /api/car-odometer/readings`

It lives at `src/routes/api/car-odometer/readings/+server.ts`, next to the
existing `api/address`.

```http
POST /api/car-odometer/readings
Authorization: Bearer <push secret>
Content-Type: application/json

{ "km": "118204", "unit": "km", "carReportedAt": "2026-09-24T21:14:03+00:00" }
```

- **Auth:** hash the bearer value with SHA-256 and compare it to the stored
  hash with `crypto.timingSafeEqual`. A missing or wrong secret gets `401`
  with an empty body. If no secret has been generated, or the integration is
  disabled, the response is `404`, so the endpoint doesn't exist until it's
  switched on.
- **Validation** is done by a pure function in `car-odometer.ts` (§6.1). `km`
  can arrive as a string or a number, because HA templates produce strings.
  It's accepted only if it's finite and `> 0`, so `unavailable`, `unknown`,
  `0` and `-1` are rejected. `unit` must be exactly `km`: HA can convert
  units into the display system, and a miles/km mixup on a lease report is
  worse than a gap. `carReportedAt` must parse as a date and must be no more
  than 5 minutes in the future (clock skew).
- **Responses:** `204` when stored; `200 {"ignored": "<reason>"}` for a
  well-formed but unusable reading (unavailable, wrong unit). It's deliberately
  not a `4xx`, so HA's logs don't fill with errors every time the car is
  asleep. `400` means a malformed body.
- **Idempotent:** a unique index on `car_reported_at` makes a duplicate push
  (for example, an HA restart re-firing the automation with unchanged state)
  a no-op instead of a second row.
- **Updates `lastReceivedAt`** on the integration row for the `/settings`
  status line, whether the reading was stored or ignored, so "HA is talking to
  us but the car is asleep" can be told apart from "HA isn't reaching us".
- **Size limit:** reject bodies over 1 KB before parsing.

The app has no user authentication at all (single user, LAN only; see
CLAUDE.md), so anyone on the LAN can already edit sessions through the UI.
The push secret isn't meant to secure the app. It stops the endpoint from
being a way to feed in readings for anything that can reach the port, which
matters if the app is ever put behind a reverse proxy or exposed further.

### 5.3 The Home Assistant side (generated in `/settings`)

In `secrets.yaml`:

```yaml
ev_log_odometer_auth: 'Bearer 3q2+7w…' # generated by the app, shown once
```

In `configuration.yaml`:

```yaml
rest_command:
  ev_log_odometer:
    url: 'http://<app host>:<port>/api/car-odometer/readings'
    method: post
    headers:
      authorization: !secret ev_log_odometer_auth
    content_type: 'application/json'
    payload: >-
      {"km": {{ states('sensor.sealion_7_odometer') | tojson }},
       "unit": {{ state_attr('sensor.sealion_7_odometer', 'unit_of_measurement') | tojson }},
       "carReportedAt": {{ states('sensor.sealion_7_telemetry_last_updated') | tojson }}}
```

The automation (in `automations.yaml`, or through the UI in YAML mode):

```yaml
- alias: 'EV charging log: push odometer'
  mode: queued
  triggers:
    - trigger: state
      entity_id: sensor.sealion_7_telemetry_last_updated
  conditions:
    - condition: template
      value_template: "{{ states('sensor.sealion_7_odometer') | is_number }}"
  actions:
    - action: rest_command.ev_log_odometer
```

- The trigger is the **telemetry timestamp**, not the odometer. It changes
  every time the car reports, including while it sits on the charger with an
  unchanged odometer. Those unchanged readings during a charge are exactly
  the evidence §6.2 needs. A trigger on the odometer would only fire while
  driving, and would never produce a reading inside a charge window.
- `<app host>:<port>` is filled in from the request's origin when the snippet
  is generated, with an editable field in case HA reaches the app by a
  different address than the browser does (Docker networking).
- The syntax is the current HA form (`triggers:`/`trigger:`,
  `actions:`/`action:`). Phase 0 checks it against the user's HA version.
- **Volume:** one reading per poll, about 288 a day at HA's 300 s default,
  which is around 100k small rows a year. §5.4 prunes old ones.

### 5.4 Data model

New table **`car_odometer_integration`**, a single row following the same
pattern as `evnex_integration`:

```ts
export const carOdometerIntegration = sqliteTable('car_odometer_integration', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(false),
	pushSecretHash: text('push_secret_hash'), // SHA-256 hex. The secret itself is never stored.
	odometerEntityId: text('odometer_entity_id'), // only used to render the HA snippet
	telemetryEntityId: text('telemetry_entity_id'), // likewise
	lastReceivedAt: text('last_received_at'), // any push, stored or ignored
	lastIgnoredReason: text('last_ignored_reason')
});
```

New table **`car_odometer_readings`**:

```ts
export const carOdometerReadings = sqliteTable('car_odometer_readings', {
	id: integer('id').primaryKey({ autoIncrement: true }),
	km: real('km').notNull(),
	carReportedAt: text('car_reported_at').notNull().unique(), // ISO UTC; the car's timestamp
	receivedAt: text('received_at').notNull() // ISO UTC; when the push arrived
});
```

Pruning: on each insert, delete readings older than 90 days, except that the
latest reading is always kept. Charge matching only ever looks back as far
as the Evnex lookback window, so 90 days is generous. It's a constant, not a
setting.

**`charging_sessions`** gets two changes:

1. **`odometer_source`**: `text('odometer_source', { enum: ['manual', 'car'] })`,
   nullable, with existing rows staying `NULL` (which reads as manual). It
   answers "where did this odometer figure come from?" for the lease company,
   and the history list's provenance icon (§7.3) reads it. This is the
   "source column" the Evnex plan deferred until a second integration
   appeared (EVNEX-INTEGRATION-PLAN.md §12 #2), scoped to the one field it
   concerns.
2. **`started_at` / `ended_at`**: nullable ISO UTC instants, filled by the Evnex
   import from `startDate`/`endDate`. Imported drafts currently keep only local
   `date`/`time`, and converting those back into instants breaks across DST
   changes (the Evnex plan's §6.3 trap run in reverse). A still-open imported
   draft gets them on its next poll, through a small `planImport` addition
   alongside the existing kWh-update path.

All four schema changes are new tables or plain `ADD COLUMN`s, so there's no
table rebuild and the foreign-key caveat in `db/index.ts` doesn't come into
play.

---

## 6. Matching logic: `src/lib/server/car-odometer.ts`

This is pure and dependency-free, like `evnex.ts`, with a co-located
`car-odometer.test.ts`. The route files handle the DB reads and writes.

### 6.1 `parseReading(body)`

This is the validation from §5.2. It returns
`{ ok: true, reading: { km, carReportedAt } } | { ok: false, status: 400 | 200, reason }`,
so the endpoint is a thin wrapper around a function that's fully tested.

### 6.2 `planOdometerFill(drafts, readings, neighbours)`

The car can't move while it's charging. So a reading the car reported inside
a charge's `[startedAt, endedAt]` is exactly that session's plug-in odometer.

| Outcome   | When                                                                                                                                                                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fill`    | At least one reading has `carReportedAt` inside `[startedAt, endedAt]` (a still-charging session counts as `endedAt = now`), **and** every reading inside the window has the same `km` (the car didn't move), **and** it passes `isOdometerBelowLastRecorded` against the session's neighbours. Written with `odometer_source = 'car'`. |
| `suggest` | No reading inside the window, but there's a reading at or before `startedAt` (the latest such one) that passes the neighbour check. The value is pre-filled in the draft's input with the hint _"From car — not confirmed during this charge"_, and is never saved without the user tapping it.                                         |
| `skip`    | No usable reading: before the first push ever arrived, readings that disagree inside the window, or a value below the previous session's odometer.                                                                                                                                                                                      |

The timestamps compared are **`carReportedAt`**, never `receivedAt`. A push
can arrive late, or be replayed after an HA restart. Only the car's own
timestamp says when the car was in that state.

Deliberately **not** used as evidence: the BYD charging-state sensors. `pyBYD`
itself notes that the "gun connected" value "does not change when the
charging gun is disconnected". Timestamps and odometer ordering are the only
evidence the rule uses.

### 6.3 `latestReading(readings, now)`

This backs **Use latest from car**. It returns `{ km, carReportedAt, ageMinutes }`,
and the page decides how to show the age (§7.2).

---

## 7. UI

### 7.1 `/settings`: "Car odometer (Home Assistant)" heading

- Hidden entirely in the Electron build (§2 #5), with a one-line note
  explaining why.
- **Not set up:** the two entity ID fields, the app URL (prefilled), and
  **Generate push secret**.
- **Just generated:** the three YAML blocks from §5.3 with **Copy** buttons,
  and a "shown once" warning.
- **Set up:** the enabled switch, the status line ("Last reading 118,204 km —
  car reported 4 min ago, received 4 min ago", or "No readings yet", or "Last
  push ignored: car unavailable 2 h ago"), **Regenerate secret** (behind a
  confirm dialog, since it breaks HA until the new YAML is pasted), and
  **Show HA snippet again** (entity IDs and URL only, with the secret line
  shown as `<your existing secret>`).

### 7.2 `/sessions`

- **Add form:** a small **Use latest from car** icon button next to the
  Odometer field, shown only when readings exist. It fills the field from the
  `load` data (no request, since it's local), with the hint _"From car,
  reported 3 min ago."_ If the reading is more than 30 minutes old, the hint
  becomes a warning: _"Car last reported 2 days ago — check this matches the
  dash."_ The saved row gets `odometer_source = 'car'` only if the submitted
  value still equals the suggested one; otherwise the user edited it, and it
  counts as `manual`. The existing below-last-recorded warning still applies.
- **Pull from charger:** the `?/pollEvnex` action runs `planOdometerFill` over
  all open imported drafts straight after the import, in the same request.
  That's safe to do now because it's local and can't fail on a network call.
  It writes the `fill`s and returns the `suggest`ions to pre-fill. The result
  message gains "…N odometers filled from car".
- **Draft rows:** suggestions show pre-filled in _Add odometer_ with their
  hint. Drafts without `started_at` (manual ones) get the same **Use latest
  from car** button as the Add form.

### 7.3 Provenance icon

A session whose `odometer_source === 'car'` gets a small car icon beside the
km figure in the history list, with a tooltip ("Odometer reported by the car
via Home Assistant"). It's an icon rather than another coloured chip because
the chip slot already carries kind. Screenshot it in both themes (CLAUDE.md
"Browser testing").

---

## 8. Security summary

- **No Home Assistant credential is stored anywhere in this app.**
- **The push secret** is 32 random bytes (`crypto.randomBytes`), base64url.
  It's shown once, stored as a SHA-256 hash, compared in constant time, and
  never logged. Request logging must not record the `Authorization` header.
  Its blast radius is false odometer readings, which the neighbour check
  in §6.2 limits, and which never become a `fill` unless they're consistent
  inside a real charge window.
- **What HA learns about the app:** one URL. **What the app learns about HA:**
  two sensor values per poll. There's no location, and no VIN (the payload
  template doesn't include it).
- **Transport:** plain `http://` on the LAN, the same as the rest of the app
  today. If the app is ever exposed beyond the LAN, the secret is what
  protects this endpoint, and TLS becomes the reverse proxy's job.

---

## 9. Testing

- **`car-odometer.test.ts`:**
  - `parseReading`: string and number `km`, `unavailable`/`unknown`/`0`/`-1`,
    a non-km unit, a missing field, a bad timestamp, a timestamp too far in
    the future, and an oversized body.
  - `planOdometerFill`, the whole §6.2 table: a reading exactly on each window
    boundary and one second either side; a reading _received_ inside the
    window but _reported_ outside it (a late push must not `fill`);
    disagreeing readings inside a window; a still-charging window; no readings
    at all; a value below the previous session's odometer; several drafts
    sharing one run of readings; and a window spanning a DST change (instants
    only).
- **The endpoint:** a small Vitest test that calls the `+server.ts` handler
  with a `Request` (401 on a bad secret, 404 when disabled, 204 then a
  no-op on a duplicate).
- **`evnex.test.ts`:** `planImport` cases for the `startedAt`/`endedAt`
  pass-through and the backfill-on-existing-draft path.
- **Playwright:** the settings card in all states (including the one-time
  snippet), the Use latest from car hint (fresh vs. stale), a pre-filled
  suggestion on a draft, and the provenance icon, in light and dark and with
  CLAUDE.md's `en-GB` locale recipe. Seed readings with `curl` against the
  dev server, since the endpoint is the only way in. No fake HA is needed.

---

## 10. Phasing

Each phase lands green (`npm run check`, `npm run lint`, `npm run test`).

| #   | Phase                                                                                                  | Notes                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | **Check the HA side by hand** (about 15 minutes, no app code)                                          | Point the §5.3 `rest_command` at `https://webhook.site` or a `nc -l` on the LAN for a day. That confirms the entity IDs, the telemetry timestamp format, that the automation syntax works on the user's HA version, and that an overnight charge produces several unchanged readings inside its window at the user's poll interval. |
| 1   | Schema: the two new tables, `odometer_source`, `started_at`/`ended_at` + the `planImport` pass-through | Migration only, plus the Evnex import populating the instants from then on.                                                                                                                                                                                                                                                         |
| 2   | `car-odometer.ts` pure logic + full Vitest suite                                                       | No network, no UI.                                                                                                                                                                                                                                                                                                                  |
| 3   | The push endpoint + the `/settings` card (secret generation, snippet, status line)                     | Ends with real readings arriving from the user's HA.                                                                                                                                                                                                                                                                                |
| 4   | **Use latest from car** in the Add form and on manual draft rows                                       | The first payoff, and useful for public sessions even without Evnex.                                                                                                                                                                                                                                                                |
| 5   | Auto-fill inside **Pull from charger** + provenance icon                                               | The main payoff: a home session goes from charger to complete with no typing.                                                                                                                                                                                                                                                       |
| 6   | Playwright verification + §12 documentation                                                            |                                                                                                                                                                                                                                                                                                                                     |

---

## 11. Open decisions

| #   | Question                                                                    | Default if unanswered                                                                                                  |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | **The Electron build gets no car readings.** Acceptable?                    | **Yes.** The server deployment is the primary one. The desktop build hides the feature rather than half-supporting it. |
| 2   | **How long to keep readings?**                                              | **90 days**, with the latest always kept.                                                                              |
| 3   | **Auto-fill on every Pull from charger, or only behind a separate button?** | **Automatically.** A `fill` is proven exact (§6.2), and a second button would be a step that's always pressed.         |
| 4   | **How stale can "Use latest from car" be before it warns?**                 | **30 minutes**, as a constant. Tune it after a billing period of use.                                                  |
| 5   | **Fill `settings.vehicleLabel` from the car?**                              | **No.** Never write report-identity settings automatically, and the push doesn't carry the VIN anyway.                 |

---

## 12. Documentation to update

Owed once this lands:

- **CLAUDE.md, "Key domain logic":** a car-odometer bullet covering push-only
  (the app never calls HA, and this is deliberate; don't "simplify" it into a
  pull with an HA token), the §6.2 rule (the car's `carReportedAt` inside the
  charge window, never `receivedAt`), that charging-state sensors are
  deliberately ignored, and the `km`-only unit rule.
- **CLAUDE.md, layering convention:** `car-odometer.ts` (pure), and the
  `api/car-odometer/readings/+server.ts` endpoint as the one route that
  accepts requests from outside the browser.
- **CLAUDE.md, "Privacy":** the DB holds a hash of the push secret (never the
  secret) and a 90-day odometer history.
- **README.md:** a "Car odometer via Home Assistant" section covering what it
  needs (`hass-byd-vehicle`, or any HA odometer plus a car-timestamp sensor in
  km), the `/settings` snippet flow, and that it's server-deployment only.
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
