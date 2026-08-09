# Offline Mode — Design & Implementation Plan

Status: **agreed, not yet started**
Branch: `claude/pwa-offline-caching-sync-rgqwku`

Supersedes parts of [PLAN.md](../PLAN.md) §3, §5.6, §7 and extends §11.2 — see
[§11](#11-documentation-to-update) for the exact edits owed once this lands.

---

## 1. Why

Public charging happens in carparks, basements, and regional towns where there
is often no usable mobile signal. The app's primary job — logging a session
while standing at the charger — currently fails completely in that situation.

The requirement is therefore:

1. The app loads and runs with no network.
2. A charging session logged offline is durably stored and syncs automatically
   once connectivity returns.
3. The user can see, at a glance, whether their data is safe — a cloud
   indicator in the app bar next to the settings cog, plus a detail view on tap.

## 2. Why today's PWA config doesn't deliver this

`vite.config.ts` registers `SvelteKitPWA` with the default `generateSW`
strategy and a `globPatterns` precache of build assets. That yields an
installable icon and a cached JS/CSS bundle — and nothing else that matters
here.

Every route in the app is server-rendered: each `+page.svelte` is fed by a
`+page.server.ts` `load` that queries SQLite directly, and every mutation is a
form action doing the same (`src/routes/sessions/+page.server.ts`). With no
network:

- **Reads fail** — there is no HTML to serve for `/sessions`, and no cached
  data to render it from.
- **Writes fail** — the form POST has nowhere to go and the data is lost.

So "make it work offline" is three separate problems: rendering, writing, and
reporting status. This plan addresses each.

---

## 3. Architectural decision: detach the frontend from the backend

### 3.1 The decision

Replace server-side `load` functions and form actions with an explicit JSON API
under `/api/*`, consumed by client-side universal loads and `fetch` calls. The
SvelteKit server becomes a JSON API plus a static shell host; the client owns
rendering and UI state.

`export const ssr = false` is set app-wide.

### 3.2 Why, and why not the smaller option

The originally-considered alternative was to leave SSR in place and cache
around it: `NetworkFirst` on navigation HTML, a second `NetworkFirst` cache for
SvelteKit's `__data.json` payloads, and a precached `/offline` fallback for
routes never visited. That works, but it means three caching layers, pages
rendered from HTML with stale data baked into it, and an offline write path
that exists _alongside_ the online one and therefore only ever executes when
offline — the classic arrangement where sync code rots untested and fails in
the field.

Detaching collapses that to one caching layer (shell + JSON), and produces two
further benefits that are not merely cosmetic:

- **`/api/sync` stops being a special case.** Under the SSR design it is a
  bolt-on duplicating what the form actions already do. Detached, it is one
  endpoint among siblings sharing the same validation, so online and offline
  writes cannot drift apart. This resolves the earlier "dual vs single write
  path" question in favour of a single path, by construction.
- **Optimistic cost calculation becomes possible.** `src/lib/server/rates.ts`
  and `sessions.ts` are already pure and dependency-free; they sit under
  `$lib/server/` (which SvelteKit blocks from client import) only because
  nothing needed them client-side. Detached, moving the pure helpers to shared
  is natural, and a queued session can display a real cost instead of
  "pending sync".

### 3.3 Important: `ssr = false` alone is not the change

Setting `export const ssr = false` while keeping `+page.server.ts` loads does
**not** detach anything. SvelteKit would still fetch data from the server via
`__data.json` — just after shell boot instead of inlined. That loses SSR's
first paint, keeps the coupling, and still requires the `__data.json` cache
layer. Strictly worse than either option.

The detachment _is_ the move of loads and actions to endpoints. `ssr = false`
is a consequence of it, not the mechanism.

### 3.4 This reverses a founding decision, deliberately

PLAN.md §3 and §7, and CLAUDE.md, all state that having no separate API layer
is a deliberate choice rather than an omission. That decision was made before
offline support was a requirement, and offline support is the new information
that changes it. The reversal is intentional and must be recorded in those
documents rather than left to silently contradict them (§11).

---

## 4. What the refactor actually touches

### 4.1 Keep universal loads — the read path stays close to mechanical

The choice is not "loads or no loads", it is _where_ the load runs:

|                           | Runs                         | Data source          |
| ------------------------- | ---------------------------- | -------------------- |
| `+page.server.ts` (today) | Server only                  | Direct Drizzle calls |
| `+page.ts` (universal)    | Browser, given `ssr = false` | `fetch('/api/…')`    |

`+page.svelte` still receives a `data` prop of the same shape, and
`invalidateAll()` still re-runs the load after a mutation — the natural
replacement for form actions' automatic re-render. Everything that renders
lists, tables, and charts is untouched.

```ts
// src/routes/sessions/+page.server.ts  →  src/routes/sessions/+page.ts
export const load: PageLoad = async ({ fetch }) => {
	const res = await fetch('/api/sessions');
	return res.json(); // same { sessions, homeAddress } shape as today
};
```

The body of the old server load moves near-verbatim into
`src/routes/api/sessions/+server.ts` as a `GET`, still importing
`$lib/server/db` and the same pure helpers.

### 4.2 The write path is the real work

Currently each mutation is a form action plus `use:enhance`, an `ActionData`
`form` prop, `form?.errors` / `form?.values`, and re-seeding effects (e.g.
`src/routes/sessions/+page.svelte:76`), with `fail(400, { errors, values })`
server-side.

Each becomes an explicit `fetch`, local `$state` for errors and submitting
flags, and a JSON 400 the client parses. The `form` prop and `ActionData` type
disappear.

Inventory: **6 server loads, ~15 actions across 6 files.**

| Route           | Load | Actions                  |
| --------------- | ---- | ------------------------ |
| `/` (dashboard) | yes  | —                        |
| `/sessions`     | yes  | create, complete, delete |
| `/periods`      | yes  | yes                      |
| `/periods/[id]` | yes  | yes                      |
| `/rates`        | yes  | yes                      |
| `/settings`     | yes  | yes                      |
| `/import`       | —    | yes                      |

### 4.3 Route layout

A `+server.ts` cannot sit in the same directory as a `+page.svelte`. The
codebase already works around this — `periods/[id]/export/+server.ts` lives in
a child directory rather than alongside `periods/[id]/+page.svelte`, and
`/api/address/*` is a separate tree. Endpoints therefore go under `/api/…`,
following the pattern already established.

```
src/routes/
  api/
    sessions/+server.ts          GET, POST
    sessions/[id]/+server.ts     PATCH (complete), DELETE
    sync/+server.ts              batch replay (§6.3)
    ping/+server.ts              reachability probe (§6.4)
    dashboard/+server.ts
    periods/+server.ts, periods/[id]/+server.ts
    rates/+server.ts, settings/+server.ts
    address/…                    unchanged
  sessions/
    +page.svelte                 reads unchanged, writes rewritten
    +page.ts                     new, ~4 lines
```

URLs are unchanged.

### 4.4 Unchanged by the refactor

- Drizzle schema and migrations (beyond the one addition in §6.3)
- `src/lib/server/*.ts` pure logic and its co-located tests
- All list/table/chart rendering
- `adapter-node`, Dockerfile, entrypoint, Unraid template
- `electron/main.cjs` (§5)

### 4.5 Accepted cost

Progressive enhancement is lost — forms stop working without JavaScript. For
an installed PWA on a phone this is already a given, and it would have been
conceded under the single-write-path option regardless.

### 4.6 Endpoints that stay server-only

The `.xlsx` export (`periods/[id]/export/+server.ts`) streams a binary, and the
historical import parses an uploaded workbook with `exceljs`. Both remain plain
server routes, are never cached, and are disabled in the UI when offline with
an explanatory hint rather than being allowed to fail.

`AddressField` degrades to a plain text input when `/api/address/search` is
unreachable.

---

## 5. Electron impact

**`electron/main.cjs` requires no changes.** The detachment moves rendering,
not the server. SQLite, migrations-on-boot, and every API endpoint still live
in the forked `build/index.js` on `127.0.0.1` — the `fork()` at `main.cjs:86`
and `loadURL` at `main.cjs:147` are untouched. The server simply returns a
shell instead of pre-rendered HTML.

### 5.1 Do not give Electron its own SSR build

Maintaining SSR for Electron while the web build is detached would mean every
route existing twice — a `+page.server.ts` load _and_ an endpoint/client-load
pair — permanently, in two rendering modes required to stay behaviourally
identical. That is the dual-path drift problem applied to the whole app, the
exact opposite of the surface-area reduction this plan exists to achieve. There
is no upside: over loopback the first-paint difference is imperceptible for a
single-user app.

### 5.2 Do not switch to `adapter-static`

A detached frontend superficially looks like a static-adapter job. It is not:
`adapter-node` is still required for the API routes, SQLite, the `.xlsx`
export, and the import parser, and Electron's fork model depends on it.

### 5.3 The one genuine Electron bug to avoid

In Electron the SvelteKit server is a local child process and is _always_
reachable, but `navigator.onLine` reports the **machine's** internet
connectivity. Working offline on a laptop would otherwise produce:

- a red `cloud_off` icon despite a perfectly healthy local server
- writes queued into Electron's `userData` IndexedDB instead of going straight
  to the SQLite file sitting on disk
- that queue draining only when the machine rejoins the internet, for no reason

This is why the reachability probe (§6.4) is load-bearing rather than a
refinement: **`/api/ping` is the only source of truth; `navigator.onLine` is a
hint that triggers a probe, never a state.** Over loopback the probe is
sub-millisecond and always succeeds, so Electron self-corrects into the green
state regardless of the machine's connectivity.

### 5.4 Electron gating

A single `offlineEnabled = !__ELECTRON_BUILD__` constant in
`src/lib/offline/` gates both the sync indicator and outbox engagement,
mirroring the existing pattern. `__ELECTRON_BUILD__` continues to do exactly
what it does now — skip the PWA plugin (`vite.config.ts:29`) and skip service
worker registration (`+layout.svelte:17`) — plus hiding the indicator, which
would otherwise be a permanently-green icon reporting on a sync that cannot
happen. No config fork beyond that.

---

## 6. Offline mechanics

### 6.1 Service worker

Switch `@vite-pwa/sveltekit` from `generateSW` to `strategies: 'injectManifest'`
with a custom worker at **`src/sw.ts`** — deliberately _not_
`src/service-worker.ts`, which SvelteKit auto-registers and would fight the
plugin.

With the frontend detached, caching reduces to two concerns:

| Target                                   | Strategy       | Notes                                                                    |
| ---------------------------------------- | -------------- | ------------------------------------------------------------------------ |
| App shell + build assets + icons         | Precache       | The shell is always available, so no `/offline` fallback route is needed |
| `/api/*` GET responses                   | `NetworkFirst` | Short timeout; serves last-known data offline                            |
| `/api/sync`, `/api/ping`, export, import | Never cached   |                                                                          |

Pages served from cached API data show a subtle "showing saved data" note.

### 6.2 Outbox

- `src/lib/offline/outbox.ts` — IndexedDB queue via `idb` (~2 KB). Operations:
  `session.create`, `session.complete`, `session.delete`.

  ```ts
  {
  	clientId: (uuid, op, payload, createdAt, attempts, lastError);
  }
  ```

- `src/lib/offline/sync.ts` — flush with backoff, reconciling per-operation
  responses back into the queue.
- `src/lib/offline/status.svelte.ts` — runes store:
  `{ reachable, pending, syncing, lastSyncedAt, failures }`.

Every write enqueues, then flushes immediately when reachable. One path, always
exercised.

### 6.3 Idempotency — the critical correctness detail

**Schema change:** add `client_id TEXT UNIQUE` (nullable, for existing rows) to
`charging_sessions`, generated client-side with `crypto.randomUUID()`.
Generate the migration with `npm run db:generate`; it applies on boot in both
Docker and Electron via `hooks.server.ts`.

Carpark connectivity fails in exactly the way that causes a request to succeed
server-side and time out client-side. Without a dedupe key every retry
double-posts sessions into a billing report submitted to a lease company. Insert
dedupes on `client_id`.

`POST /api/sync` accepts `{ operations: [...] }`, applies them in order, and
returns per-operation `applied | duplicate | rejected(reason)`. Validation lives
in a pure `src/lib/server/sync.ts` with a co-located test, per the layering
convention in CLAUDE.md; the route wires it to Drizzle.

Cost and billing-period assignment are computed **server-side at flush time**
using the existing `resolveRatePlan` and `findBillingPeriodId`, so a session
logged offline and synced days later still resolves against the rate plan that
was in effect on its own date.

Rejections are permanent and cannot be retried away — a queued session whose
billing period was submitted while offline (the `isPeriodSubmitted` guard at
`sessions/+page.server.ts:107`) will never apply. These surface in the sync
panel with a discard action.

### 6.4 Reachability

`navigator.onLine` reports `true` on carpark wifi behind a captive portal —
precisely the environment this feature exists for — and lies in the opposite
direction under Electron (§5.3). Truth comes from `GET /api/ping` with a ~2 s
timeout. Browser events are triggers for a probe, never a state.

### 6.5 Flush triggers

App load, `online` event, `visibilitychange`, manual **Sync now**, and
Background Sync where available.

**Background Sync is Chrome/Android only** — iOS Safari has never shipped it.
On an iPhone the foreground triggers _are_ the mechanism, not a fallback, and
the design must not assume otherwise.

---

## 7. Sync status indicator

`src/lib/components/SyncStatus.svelte`, placed in the app bar immediately
before the settings cog (`src/routes/+layout.svelte:42`), using the existing
`Icon.svelte` + `@mdi/js` pattern.

| State                   | Icon                 | Colour          |
| ----------------------- | -------------------- | --------------- |
| Reachable, outbox empty | `mdiCloudCheck`      | green `#4ade80` |
| Unreachable             | `mdiCloudOffOutline` | red `#f87171`   |
| Pending count           | numeric badge        |                 |

Colours are chosen for contrast against the teal `#0f766e` app bar rather than
raw `#22c55e` / `#ef4444`.

Tapping opens an SMUI Dialog (mobile-first bottom sheet) showing:

```
Offline — 3 changes waiting
Online — syncing 3 changes…
Online — synced (2 minutes ago)
Online — 1 change couldn't sync    [needs attention]
```

…plus the queued operations listed with kind/date/kWh/location, last successful
sync time, a **Sync now** button, and any rejected operations with their reason
and a discard action.

---

## 8. Testing

**Vitest** (`src/**`, pure logic only, per the configured test project):

- outbox reducer, dedupe, and ordering
- status derivation from `{ reachable, pending, syncing, failures }`
- `src/lib/server/sync.ts` ingest validation
- existing `rates.ts` / `sessions.ts` tests must continue to pass unchanged
  through the refactor — they are the regression net for §4

**Playwright**, per the browser-testing requirement in CLAUDE.md:

- `context.setOffline(true)` → log a session → assert red `cloud_off` and the
  queued entry in the dialog
- return online → assert flush, green cloud, and the session present in history
- screenshots in **both light and dark** — the badge and dialog are new
  surfaces and SMUI/MDC resets have caused real regressions here before

**Manual:** install to home screen, airplane mode, cold start.

---

## 9. Phasing

Each phase should land green (`npm run check`, `npm run lint`, `npm run test`).

| #   | Phase                                                    | Notes                                                                                                                                       |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Detach** — endpoints + universal loads + `ssr = false` | Pure refactor, no offline behaviour. Recommended: spike `/sessions` end-to-end first to confirm the diff shape before doing the other five. |
| 2   | Shell precache + `/api/*` runtime caching + `/api/ping`  | Custom `src/sw.ts`, `injectManifest`                                                                                                        |
| 3   | `client_id` migration + `/api/sync`                      | The correctness core (§6.3)                                                                                                                 |
| 4   | Outbox + sync engine                                     | `src/lib/offline/*`                                                                                                                         |
| 5   | Cloud indicator + detail sheet                           | §7                                                                                                                                          |
| 6   | Playwright verification + documentation updates          | §8, §11                                                                                                                                     |

### 9.1 Scope reduction, if phase 1 proves too large

Detach only `/sessions` and `/` (dashboard); leave periods, rates, settings, and
import as SSR and simply unavailable offline. Two routes instead of six, and the
`__data.json` cache layer is still avoided because the SSR routes fall through
to the offline shell. This covers the actual use case — logging at a charger —
since everything else is home-wifi work.

---

## 10. Open decisions

| #   | Question                                                                                                                               | Default if unanswered                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Amber `mdiCloudSync` state for "online, changes still in flight"? Without it the icon reads green while work is genuinely outstanding. | Green/red only, per the original request, plus the pending-count badge |
| 2   | Full six-route detachment, or the two-route reduction in §9.1?                                                                         | Full, decided after the `/sessions` spike                              |

---

## 11. Documentation to update

Owed once this lands — these files currently state the opposite of §3:

- **CLAUDE.md** — the "No separate API/backend" section and the layering
  convention, which both describe `+page.server.ts` as the only place importing
  `$lib/server/db`
- **PLAN.md §3** — the Framework row of the decisions table
- **PLAN.md §5.6** — PWA section, currently "app shell/offline shell and
  installability" only
- **PLAN.md §7** — tech stack summary
- **PLAN.md §11.2** — Electron config divergence, extended per §5.4
- **PLAN.md "Ongoing: Enhancements"** — add the offline-mode entry
