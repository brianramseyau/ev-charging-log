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

export const db = drizzle(client, { schema });

// Applies any pending migrations from ./drizzle on boot, so both local dev and the
// Docker image (which ships without the drizzle-kit CLI) end up on the same schema.
// Resolved relative to cwd by default — MIGRATIONS_FOLDER lets the Electron build
// override that with an absolute path, since its forked server process can't have
// its cwd set to a location inside app.asar (spawn's cwd is a real OS chdir, which
// can't target a virtual asar path, unlike plain fs reads used to load this folder).
migrate(db, { migrationsFolder: env.MIGRATIONS_FOLDER || 'drizzle' });
