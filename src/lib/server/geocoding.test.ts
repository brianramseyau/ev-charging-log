import { describe, expect, it } from 'vitest';
import { formatAustralianAddress } from './geocoding';

describe('formatAustralianAddress', () => {
	it('formats a full address with an abbreviated state and no country', () => {
		const result = formatAustralianAddress({
			house_number: '123',
			road: 'Example Street',
			suburb: 'Richmond',
			state: 'Victoria',
			postcode: '3121',
			country_code: 'au'
		});
		expect(result).toBe('123 Example Street, Richmond VIC 3121');
	});

	it('falls back to city/town/village/municipality when suburb is missing', () => {
		expect(formatAustralianAddress({ road: 'Main Rd', city: 'Bendigo' })).toBe('Main Rd, Bendigo');
		expect(formatAustralianAddress({ road: 'Main Rd', town: 'Bendigo' })).toBe('Main Rd, Bendigo');
		expect(formatAustralianAddress({ road: 'Main Rd', village: 'Bendigo' })).toBe(
			'Main Rd, Bendigo'
		);
		expect(formatAustralianAddress({ road: 'Main Rd', municipality: 'Bendigo' })).toBe(
			'Main Rd, Bendigo'
		);
	});

	it('leaves an unrecognised state name as-is', () => {
		const result = formatAustralianAddress({ suburb: 'Somewhere', state: 'Some Territory' });
		expect(result).toBe('Somewhere Some Territory');
	});

	it('omits missing pieces without leaving stray punctuation', () => {
		expect(formatAustralianAddress({ suburb: 'Richmond', state: 'Victoria' })).toBe('Richmond VIC');
		expect(formatAustralianAddress({ road: 'Example Street' })).toBe('Example Street');
		expect(formatAustralianAddress({})).toBe('');
	});

	it('never includes the country', () => {
		const result = formatAustralianAddress({
			house_number: '1',
			road: 'Test St',
			suburb: 'Test Suburb',
			state: 'New South Wales',
			postcode: '2000',
			country_code: 'au'
		});
		expect(result.toLowerCase()).not.toContain('australia');
	});
});
