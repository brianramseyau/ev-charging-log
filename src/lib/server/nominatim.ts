// Thin fetch wrapper around Nominatim (OpenStreetMap geocoding), shared by the
// /api/address/search and /api/address/reverse routes.
import { env } from '$env/dynamic/private';

const DEFAULT_BASE_URL = 'https://nominatim.openstreetmap.org';

// Nominatim's usage policy requires a descriptive User-Agent identifying the
// calling application (this is a self-hosted, single-user app, well under its
// rate limits). NOMINATIM_BASE_URL lets a self-hoster point at their own instance.
const USER_AGENT = 'ev-charging-log (self-hosted personal app)';

export async function nominatimFetch(
	fetchFn: typeof fetch,
	path: '/search' | '/reverse',
	params: Record<string, string>
): Promise<Response> {
	const baseUrl = env.NOMINATIM_BASE_URL || DEFAULT_BASE_URL;
	const query = new URLSearchParams(params);
	return fetchFn(`${baseUrl}${path}?${query}`, {
		headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
	});
}
