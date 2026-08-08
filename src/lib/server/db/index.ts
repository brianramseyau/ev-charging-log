import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';
import { env } from '$env/dynamic/private';

if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

mkdirSync(dirname(env.DATABASE_URL), { recursive: true });

const client = new Database(env.DATABASE_URL);

// SQLite implements column-constraint changes (e.g. dropping NOT NULL) as a table
// rebuild (CREATE __new_x / INSERT SELECT / DROP x / RENAME). With foreign keys
// enforced — which better-sqlite3 does by default, unlike the sqlite3 CLI — the DROP
// cascades into any table referencing x and silently deletes rows the rebuild meant
// to preserve. drizzle-kit does emit `PRAGMA foreign_keys=OFF` around those blocks,
// but its migrator runs each migration inside BEGIN/COMMIT and the pragma is a no-op
// within a transaction. Setting it here, before migrate() opens one, is what actually
// takes effect.
client.pragma('foreign_keys = OFF');

export const db = drizzle(client, { schema });

// Applies any pending migrations from ./drizzle on boot, so both local dev and the
// Docker image (which ships without the drizzle-kit CLI) end up on the same schema.
// Resolved relative to cwd by default — MIGRATIONS_FOLDER lets the Electron build
// override that with an absolute path, since its forked server process can't have
// its cwd set to a location inside app.asar (spawn's cwd is a real OS chdir, which
// can't target a virtual asar path, unlike plain fs reads used to load this folder).
migrate(db, { migrationsFolder: env.MIGRATIONS_FOLDER || 'drizzle' });

// Step 10 of SQLite's documented table-rebuild procedure: confirm the rebuild left
// nothing dangling before enforcement is restored for the app's own queries. A
// migration that boots "successfully" onto a corrupted relational state is worse
// than one that refuses to boot at all.
const violations = client.pragma('foreign_key_check') as unknown[];
if (violations.length > 0) {
	throw new Error(
		`Migration left ${violations.length} foreign key violation(s): ${JSON.stringify(violations)}`
	);
}

client.pragma('foreign_keys = ON');
