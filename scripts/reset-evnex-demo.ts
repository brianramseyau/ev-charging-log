// Clears Evnex import state so the next poll pulls sessions in as if for the
// first time — for demoing/testing the import flow repeatedly without
// re-authenticating. Deletes:
//   - evnex_dismissed_sessions (tombstones from deleted/invalid/zero-energy
//     sessions, which otherwise permanently block a session from being
//     re-imported — see schema.ts)
//   - charging_sessions rows with a non-null external_id (previously-imported
//     Evnex sessions), so the poll's dedupe-on-externalId doesn't just skip
//     them straight back out
// Leaves evnex_integration's connection itself (tokens, org/charge-point ids)
// untouched — this is not a sign-out, just a "forget what's been imported
// before." Only resets its last-poll status fields so /settings shows a clean
// "never polled" state.
//
// Run via `npm run db:reset-evnex`. Refuses to run without an interactive
// confirmation unless --yes is passed.
import { createInterface } from 'node:readline/promises';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { isNotNull } from 'drizzle-orm';
import {
	chargingSessions,
	evnexDismissedSessions,
	evnexIntegration
} from '../src/lib/server/db/schema.ts';

if (!process.env.DATABASE_URL) {
	throw new Error(
		'DATABASE_URL is not set (this script reads it the same way the app does — see .env).'
	);
}

async function confirm(message: string): Promise<boolean> {
	if (process.argv.includes('--yes') || process.argv.includes('-y')) return true;
	if (!process.stdin.isTTY) {
		console.error('Refusing to run non-interactively without --yes.');
		return false;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const answer = await rl.question(message);
	rl.close();
	return answer.trim().toLowerCase() === 'y';
}

async function main() {
	const databaseUrl = process.env.DATABASE_URL as string;
	mkdirSync(dirname(databaseUrl), { recursive: true });
	const client = new Database(databaseUrl);
	client.pragma('foreign_keys = OFF');
	const db = drizzle(client);
	migrate(db, { migrationsFolder: 'drizzle' });
	client.pragma('foreign_keys = ON');

	const proceed = await confirm(
		`This will delete Evnex tombstones and previously-imported Evnex sessions from ${databaseUrl}, so the next poll re-imports everything. The Evnex sign-in itself is left connected. Continue? (y/N) `
	);
	if (!proceed) {
		console.log('Aborted.');
		client.close();
		return;
	}

	const { changes: tombstones } = db.delete(evnexDismissedSessions).run();
	const { changes: importedSessions } = db
		.delete(chargingSessions)
		.where(isNotNull(chargingSessions.externalId))
		.run();
	db.update(evnexIntegration)
		.set({ lastPolledAt: null, lastPollStatus: null, lastPollError: null })
		.run();

	console.log(
		`Cleared ${tombstones} tombstone(s) and ${importedSessions} previously-imported session(s). Next Evnex poll will re-import from scratch.`
	);
	client.close();
}

main();
