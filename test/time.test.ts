import { expect, test } from 'vitest';
import {
  isValidTimeZone,
  resolveTimeZone,
  searchTimeZones,
  zonedToDate,
} from '../src/time.ts';

const iso = (input: unknown, tz: string) => zonedToDate(input, tz)?.toISOString() ?? null;

test('reads a plain wall-clock time in the given zone', () => {
  expect(iso('2026-08-15 19:30', 'UTC')).toBe('2026-08-15T19:30:00.000Z');
  // Berlin is UTC+2 in August.
  expect(iso('2026-08-15 19:30', 'Europe/Berlin')).toBe('2026-08-15T17:30:00.000Z');
  // Los Angeles is UTC-7 in August.
  expect(iso('2026-08-15 19:30', 'America/Los_Angeles')).toBe('2026-08-16T02:30:00.000Z');
});

test('picks the right offset on each side of a DST boundary', () => {
  // US DST ends 2026-11-01. 01:30 is PDT (-7) on Oct 31, PST (-8) on Nov 2.
  expect(iso('2026-10-31 01:30', 'America/Los_Angeles')).toBe('2026-10-31T08:30:00.000Z');
  expect(iso('2026-11-02 01:30', 'America/Los_Angeles')).toBe('2026-11-02T09:30:00.000Z');
});

test('rejects a local time that daylight saving skips', () => {
  // Clocks jump 02:00 -> 03:00 on 2026-03-08 in Los Angeles, so 02:30 never happens.
  expect(zonedToDate('2026-03-08 02:30', 'America/Los_Angeles')).toBeNull();
  // The hour either side is real.
  expect(iso('2026-03-08 01:30', 'America/Los_Angeles')).toBe('2026-03-08T09:30:00.000Z');
  expect(iso('2026-03-08 03:30', 'America/Los_Angeles')).toBe('2026-03-08T10:30:00.000Z');
});

test('resolves an ambiguous repeated hour to one real instant', () => {
  // 01:30 happens twice on 2026-11-01 in Los Angeles. Either is defensible; it must not
  // return null or drift to another hour.
  const at = zonedToDate('2026-11-01 01:30', 'America/Los_Angeles');
  expect(at).toBeInstanceOf(Date);
  expect(['2026-11-01T08:30:00.000Z', '2026-11-01T09:30:00.000Z']).toContain(at?.toISOString());
});

test('defaults a bare date to midnight', () => {
  expect(iso('2026-08-15', 'UTC')).toBe('2026-08-15T00:00:00.000Z');
});

test('rejects malformed input rather than guessing', () => {
  for (const bad of ['', null, undefined, 'tomorrow', '15/08/2026 19:30', '2026-08-15 7:30pm']) {
    expect(zonedToDate(bad, 'UTC'), `should reject ${JSON.stringify(bad)}`).toBeNull();
  }
});

test('rejects out-of-range and rolled-over calendar values', () => {
  expect(zonedToDate('2026-02-30 12:00', 'UTC'), 'Feb 30 must not roll to Mar 2').toBeNull();
  expect(zonedToDate('2026-13-01 12:00', 'UTC')).toBeNull();
  expect(zonedToDate('2026-08-15 24:00', 'UTC')).toBeNull();
  expect(zonedToDate('2026-08-15 12:60', 'UTC')).toBeNull();
});

test('rejects an unknown timezone', () => {
  expect(zonedToDate('2026-08-15 19:30', 'Mars/Olympus')).toBeNull();
  expect(isValidTimeZone('Mars/Olympus')).toBe(false);
  expect(isValidTimeZone('Europe/Berlin')).toBe(true);
});

test('resolves a zone from a city, a canonical name or a legacy link', () => {
  expect(resolveTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
  expect(resolveTimeZone('berlin')).toBe('Europe/Berlin');
  expect(resolveTimeZone('new york')).toBe('America/New_York');
  expect(resolveTimeZone('  TOKYO  ')).toBe('Asia/Tokyo');
  // Canonical spelling comes back, whatever the casing going in.
  expect(resolveTimeZone('europe/berlin')).toBe('Europe/Berlin');
  // ICU knows this one but supportedValuesOf doesn't list it, so only the fallback arm saves it.
  expect(resolveTimeZone('US/Eastern')).toBe('US/Eastern');
});

test('maps an abbreviation to a zone that observes daylight saving', () => {
  // The whole point: ICU accepts `EST` as a fixed -5 zone with no DST, so passing it through
  // would put a July event an hour out. These must land on the city zones instead.
  expect(resolveTimeZone('EST')).toBe('America/New_York');
  expect(resolveTimeZone('est')).toBe('America/New_York');
  expect(resolveTimeZone('pst')).toBe('America/Los_Angeles');
  expect(resolveTimeZone('mst')).toBe('America/Denver');
  expect(resolveTimeZone('hst')).toBe('Pacific/Honolulu');
  expect(resolveTimeZone('utc')).toBe('UTC');

  // And the reason it matters, end to end: 4 July noon on the US east coast is 16:00 UTC on
  // EDT (-4), not the 17:00 that fixed `EST` gives.
  expect(zonedToDate('2026-07-04 12:00', resolveTimeZone('EST')!)?.toISOString()).toBe(
    '2026-07-04T16:00:00.000Z',
  );
});

test('refuses to guess when the input matches many zones or none', () => {
  for (const ambiguous of ['america', 'europe', 'asia', 'a']) {
    expect(resolveTimeZone(ambiguous), `should not guess for ${ambiguous}`).toBeNull();
  }
  for (const nonsense of ['', '   ', 'Mars/Olympus', 'zzzz', 'eastern standard time']) {
    expect(resolveTimeZone(nonsense), `should reject ${JSON.stringify(nonsense)}`).toBeNull();
  }
});

test('suggests the default and popular zones before anything is typed', () => {
  const empty = searchTimeZones('', 'Europe/Berlin');
  expect(empty[0]?.value).toBe('Europe/Berlin');
  expect(empty.map((choice) => choice.value)).toContain('Asia/Tokyo');
  // The default is usually in POPULAR too, and must not be listed twice.
  expect(searchTimeZones(undefined, 'UTC').filter((c) => c.value === 'UTC')).toHaveLength(1);
});

test('suggests zones matching what has been typed so far', () => {
  expect(searchTimeZones('berl', 'UTC').map((c) => c.value)).toStrictEqual(['Europe/Berlin']);
  // A city-prefix match outranks one buried mid-name, and an alias is promoted above both.
  expect(searchTimeZones('york', 'UTC')[0]?.value).toBe('America/New_York');
  expect(searchTimeZones('est', 'UTC')[0]?.value).toBe('America/New_York');
  expect(searchTimeZones('Mars/Olympus', 'UTC')).toStrictEqual([]);
});

test('every suggestion is usable and the list fits what Discord accepts', () => {
  // One assertion guarding the whole list: a suggestion that isn't a real zone would be
  // rejected by zonedToDate the moment someone picked it.
  for (const query of ['', 'a', 'america', 'europe/', 'new', 'pacific']) {
    const choices = searchTimeZones(query, 'America/Los_Angeles');
    expect(choices.length, `${query} returned ${choices.length}`).toBeLessThanOrEqual(25);
    for (const { name, value } of choices) {
      expect(isValidTimeZone(value), `${value} (for "${query}") is not a zone`).toBe(true);
      expect(name.length, `${name} is too long for a Discord choice`).toBeLessThanOrEqual(100);
    }
  }
});
