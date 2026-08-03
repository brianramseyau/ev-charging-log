import type { Handle } from '@sveltejs/kit';

// Importing the db client here (rather than lazily in routes) forces the connection
// to open — and pending migrations to run — as soon as the server process starts.
import '$lib/server/db';

export const handle: Handle = ({ event, resolve }) => resolve(event);
