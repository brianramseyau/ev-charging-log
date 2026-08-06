// Formatting for Nominatim (OpenStreetMap) geocoding results, kept dependency-free
// so it's cheap to unit test. Network calls to Nominatim live in the /api/address
// routes, not here.

export interface NominatimAddress {
	house_number?: string;
	road?: string;
	suburb?: string;
	city?: string;
	town?: string;
	village?: string;
	municipality?: string;
	state?: string;
	postcode?: string;
	country_code?: string;
}

const STATE_ABBREVIATIONS: Record<string, string> = {
	'new south wales': 'NSW',
	victoria: 'VIC',
	queensland: 'QLD',
	'south australia': 'SA',
	'western australia': 'WA',
	tasmania: 'TAS',
	'northern territory': 'NT',
	'australian capital territory': 'ACT'
};

// Builds a single-line "123 Example St, Suburb VIC 2000" address string —
// matching how addresses are already typed elsewhere in the app — with no
// country, since this app is Australia-only.
export function formatAustralianAddress(address: NominatimAddress): string {
	const street = [address.house_number, address.road].filter(Boolean).join(' ');
	const suburb =
		address.suburb ?? address.city ?? address.town ?? address.village ?? address.municipality;
	const state = address.state
		? (STATE_ABBREVIATIONS[address.state.toLowerCase()] ?? address.state)
		: undefined;
	const suburbLine = [suburb, [state, address.postcode].filter(Boolean).join(' ')]
		.filter(Boolean)
		.join(' ');

	return [street, suburbLine].filter(Boolean).join(', ');
}
