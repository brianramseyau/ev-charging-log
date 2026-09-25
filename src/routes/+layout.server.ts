import { db } from '$lib/server/db';
import { carOdometerIntegration } from '$lib/server/db/schema';
import { carOdometerAlert } from '$lib/server/car-odometer';
import type { LayoutServerLoad } from './$types';

// A broken integration must be obvious outside /settings (BYD-INTEGRATION-PLAN.md
// §7.3): the nav's Settings dot and /sessions' banner both read this. Driven by the
// stored status only — never a network call — so it costs one row read per page.
export const load: LayoutServerLoad = async () => {
	const [row] = await db.select().from(carOdometerIntegration).limit(1);
	return { carOdometerAlert: carOdometerAlert(row, new Date()) };
};
