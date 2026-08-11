import { expect, test } from 'vitest';
import { formatPlace, searchPlaces } from '../src/places.ts';

// Every fixture below except the two synthetic ones was copied out of a live Photon
// response, so the shapes are what the API really sends rather than what its docs imply.

test('a POI with a street address reads as one line', () => {
  expect(
    formatPlace({
      name: 'Google Headquarters',
      housenumber: '1600',
      street: 'Amphitheatre Parkway',
      city: 'Mountain View',
      state: 'CA',
      country: 'United States',
      postcode: '94043',
    }),
  ).toBe('Google Headquarters, 1600 Amphitheatre Parkway, Mountain View, CA');
});

test('a plain house number has no name to lead with', () => {
  expect(
    formatPlace({
      housenumber: '1234',
      street: 'Sanchez Way',
      city: 'Redwood City',
      state: 'California',
    }),
  ).toBe('1234 Sanchez Way, Redwood City, California');
});

test('a street feature carries its name and no street key', () => {
  expect(
    formatPlace({ name: 'Amphitheatre Parkway', city: 'Mountain View', state: 'California' }),
  ).toBe('Amphitheatre Parkway, Mountain View, California');
});

test('a name that repeats the street is not printed twice', () => {
  // Synthetic: OSM lets a building be named after the street it sits on.
  expect(formatPlace({ name: 'Market Street', street: 'Market Street', city: 'San Francisco' })).toBe(
    'Market Street, San Francisco',
  );
});

test('an over-long address drops whole parts instead of chopping a word', () => {
  const name = 'Dr. Martin Luther King Jr. Memorial Recreation Center and Aquatic Complex';
  const shown = formatPlace({
    name,
    housenumber: '1234',
    street: 'Northwest Twenty-Third Avenue',
    city: 'Saint Petersburg',
    state: 'Florida',
  });

  // Discord rejects a choice over 100 chars, so this bound is the whole point.
  expect(shown.length, `${shown.length} chars: ${shown}`).toBeLessThanOrEqual(100);
  expect(shown, 'kept the leading part whole rather than slicing mid-word').toBe(name);
});

test('a single part longer than the cap is still cut to fit', () => {
  // Nothing left to drop, so the hard slice is the only option left.
  expect(formatPlace({ name: 'g'.repeat(150) }).length).toBe(100);
});

test('missing properties produce nothing rather than throwing', () => {
  expect(formatPlace({})).toBe('');
  expect(formatPlace()).toBe('');
});

test('a query too short to be meaningful never reaches the network', async () => {
  // No fetch mock here on purpose: if this ever hits the wire the suite stops being offline.
  expect(await searchPlaces('ab', null)).toStrictEqual([]);
  expect(await searchPlaces('  ', { lat: 1, lon: 2 })).toStrictEqual([]);
  expect(await searchPlaces(undefined, null)).toStrictEqual([]);
});
