import { json } from '@sveltejs/kit';
import { formatAustralianAddress, type NominatimAddress } from '$lib/server/geocoding';
import { nominatimFetch } from '$lib/server/nominatim';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, fetch }) => {
	const lat = Number(url.searchParams.get('lat'));
	const lon = Number(url.searchParams.get('lon'));
	if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
		return json({ address: null });
	}

	const res = await nominatimFetch(fetch, '/reverse', {
		format: 'jsonv2',
		addressdetails: '1',
		lat: String(lat),
		lon: String(lon),
		zoom: '18'
	});
	if (!res.ok) return json({ address: null });

	const data = (await res.json()) as { address?: NominatimAddress };
	const address = data.address;
	// Current GPS position may be outside Australia — only ever fill AU addresses.
	if (!address || address.country_code?.toLowerCase() !== 'au') {
		return json({ address: null });
	}

	const label = formatAustralianAddress(address);
	return json({ address: label || null });
};
