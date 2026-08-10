Evnex charger integration

## Evnex charger integration
- Automatically pull recent home-charging sessions from your Evnex charger as drafts (missing only the odometer), via a new "Pull from charger" button on Sessions — sign in once from Settings.
- The charge-point list on Settings now loads client-side after the page mounts instead of blocking page load, is cached in memory, and has a manual refresh button.
- A session with 0 kWh (plugged in and immediately stopped) is now skipped instead of being imported as a junk draft.

## Sessions & billing periods
- Sessions page: the manual entry form is now collapsed behind an "Add Charge" button, matching the Periods page.
- New billing periods default their start/end dates to the previous period + 1 month.
- Historical import moved into Settings; the header cog menu is gone.
- Manual kWh entry now accepts 3 decimal places, matching the historical importer and the Evnex integration's derived values.

## Dashboard
- Restructured: the current, still-open billing period now gets its own stats row at the top. Historical charts and KPIs below only look at completed periods, so an in-progress period no longer skews the trend lines.

## Reports
- Generated `.xlsx` reports now end with a footer linking back to the project repository.

## Other
- Standardized page heading font size across routes.
- Cleared the eslint backlog that a broken lint script had been silently masking.
- Added dev DB seeding and an Evnex demo-reset script for local development.

**Full diff**: https://github.com/brianramseyau/ev-charging-log/compare/v0.1.5...v0.1.6
