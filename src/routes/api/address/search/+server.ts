import { json } from '@sveltejs/kit';
import { formatAustralianAddress, type NominatimAddress } from '$lib/server/geocoding';
import { nominatimFetch } from '$lib/server/nominatim';
import type { RequestHandler } from './$types';

interface NominatimSearchResult {
	lat: string;
	lon: string;
	address?: NominatimAddress;
}

// GPS-biasing "soft" viewbox around the given point — Nominatim treats this as a
// preference, not a hard filter, so results outside it can still come back.
const BIAS_DEGREES = 0.5;

export const GET: RequestHandler = async ({ url, fetch }) => {
	const q = url.searchParams.get('q')?.trim() ?? '';
	if (q.length < 3) return json({ results: [] });

	const params: Record<string, string> = {
		format: 'jsonv2',
		addressdetails: '1',
		countrycodes: 'au',
		limit: '6',
		q
	};

	const lat = Number(url.searchParams.get('lat'));
	const lon = Number(url.searchParams.get('lon'));
	if (Number.isFinite(lat) && Number.isFinite(lon)) {
		params.viewbox = [
			lon - BIAS_DEGREES,
			lat + BIAS_DEGREES,
			lon + BIAS_DEGREES,
			lat - BIAS_DEGREES
		].join(',');
		params.bounded = '0';
	}

	const res = await nominatimFetch(fetch, '/search', params);
	if (!res.ok) return json({ results: [] });

	const data = (await res.json()) as NominatimSearchResult[];
	const seen = new Set<string>();
	const results = [];
	for (const item of data) {
		const label = formatAustralianAddress(item.address ?? {});
		if (!label || seen.has(label)) continue;
		seen.add(label);
		results.push({ label, lat: Number(item.lat), lon: Number(item.lon) });
	}

	return json({ results });
};
