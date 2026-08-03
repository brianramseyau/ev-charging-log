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
migrate(db, { migrationsFolder: 'drizzle' });
