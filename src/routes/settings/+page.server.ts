import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { settings } from '$lib/server/db/schema';

export const load: PageServerLoad = async () => {
	const [row] = await db.select().from(settings).limit(1);
	return { settings: row ?? null };
};

export const actions: Actions = {
	save: async ({ request }) => {
		const form = await request.formData();
		const fullName = form.get('fullName')?.toString().trim();
		const vehicleLabel = form.get('vehicleLabel')?.toString().trim();

		if (!fullName) return fail(400, { error: 'Full name is required.' });
		if (!vehicleLabel) return fail(400, { error: 'Vehicle rego/VIN is required.' });

		const [existing] = await db.select().from(settings).limit(1);

		if (existing) {
			await db.update(settings).set({ fullName, vehicleLabel });
		} else {
			await db.insert(settings).values({ fullName, vehicleLabel });
		}

		return { success: true };
	}
};
