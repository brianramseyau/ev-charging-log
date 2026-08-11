-- Data fix: one session was logged with a mistyped year (2023 instead of
-- 2026), which sorted it ahead of every other session instead of between the
-- 2026-04-12 and 2026-04-25 home sessions it actually belongs with (its
-- odometer reading of 1790km only makes sense between those two: 1568km on
-- 04-12, 2010km on 04-25). Matches on date/time/odometer/kWh — already
-- specific enough that this can only ever touch that one row — rather than
-- also matching on location, which would put a real home address in a
-- migration file committed to source control. A no-op once already applied.
UPDATE charging_sessions
SET date = '2026-04-19'
WHERE date = '2023-04-19'
	AND time = '09:00'
	AND odometer_km = 1790
	AND kwh_used = 46.60;