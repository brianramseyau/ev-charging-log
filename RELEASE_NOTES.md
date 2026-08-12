Odds and ends

## Evnex integration
- Rebuilt on the `evnex-client` npm package instead of the hand-rolled Cognito/fetch implementation, so token refresh and session handling now come from a maintained package rather than bespoke auth code.

## Sessions & billing periods
- Sessions sharing the exact same date/time (e.g. demo data) now sort deterministically everywhere — the sessions list, the period view, and its `.xlsx` export — instead of depending on incidental database fetch order.
- Historical import now flags a row whose date falls outside the sheet's claimed period range as a review issue, catching a stale or copied-forward date before it lands silently in the wrong billing period.
- New billing periods default their label to "{Month} {Year}" of the start date (e.g. "August 2026") until you type your own.

## Settings
- The installed app version is now shown on the Settings page.
- Docker builds off `main` (untagged, "nightly" style) now show a `dev-<sha>` version there instead of a stale release number.
