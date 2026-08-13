import { expect, test } from 'vitest';
import {
  canonicalWhen,
  formatWhen,
  isValidTimeZone,
  parseWhenInput,
  resolveTimeZone,
  searchTimeZones,
  searchWhen,
  zonedToDate,
} from '../src/time.ts';

const iso = (input: unknown, tz: string) => zonedToDate(input, tz)?.toISOString() ?? null;

const LA = 'America/Los_Angeles';
/** 10:00 on Wednesday 12 August 2026 in Los Angeles. Passed explicitly so nothing reads a clock. */
const NOW = new Date('2026-08-12T17:00:00Z');
const loose = (input: unknown, tz = LA, now = NOW) =>
  parseWhenInput(input, tz, now)?.toISOString() ?? null;

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

test('reads a 12-hour clock, with or without minutes', () => {
  expect(loose('Aug 15 7pm')).toBe('2026-08-16T02:00:00.000Z'); // 19:00 PDT
  expect(loose('Aug 15 7:30 PM')).toBe('2026-08-16T02:30:00.000Z');
  expect(loose('Aug 15 7:30 AM')).toBe('2026-08-15T14:30:00.000Z');
  expect(loose('Aug 15 12:00 AM')).toBe('2026-08-15T07:00:00.000Z'); // Midnight, not noon.
  expect(loose('Aug 15 12:00 PM')).toBe('2026-08-15T19:00:00.000Z');
});

test('reads relative days and durations against the reference instant', () => {
  expect(loose('tomorrow 7pm')).toBe('2026-08-14T02:00:00.000Z'); // Thu 13th, 19:00 PDT.
  expect(loose('in 2 hours')).toBe('2026-08-12T19:00:00.000Z'); // 10:00 + 2 = 12:00 PDT.
  expect(loose('in 30 minutes')).toBe('2026-08-12T17:30:00.000Z');
  // A day-granularity offset names no hour, so it lands on midnight like a bare date does —
  // "in 3 days" is a date, not a time. searchWhen is where the evening times get offered.
  expect(loose('in 3 days')).toBe(iso('2026-08-15 00:00', LA));
});

test('a bare weekday resolves forward, never into the week just gone', () => {
  // NOW is a Wednesday, so an unqualified "friday" has one sensible reading and one useless one.
  expect(loose('friday 7pm')).toBe('2026-08-15T02:00:00.000Z'); // Fri 14th, 19:00 PDT.
  expect(loose('next friday 7:30pm')).toBe('2026-08-22T02:30:00.000Z'); // Fri 21st.
  // And the reading that matters: whatever it picks must be in the future.
  for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'saturday', 'sunday']) {
    const at = parseWhenInput(`${day} 7pm`, LA, NOW);
    expect(at, `${day} did not parse`).not.toBeNull();
    expect(at!.getTime(), `${day} resolved into the past`).toBeGreaterThan(NOW.getTime());
  }
});

test('a bare hour parses, though chrono alone declines it', () => {
  // "7" on its own is not a date to chrono, so parseWhenInput pads it to "7:00" first. Without
  // that, the single most likely thing anyone types into a time box returns nothing at all.
  expect(loose('7')).toBe('2026-08-13T14:00:00.000Z'); // 07:00 tomorrow, chrono's AM reading.
  expect(loose('19')).toBe('2026-08-13T02:00:00.000Z'); // 19:00 today.
});

test('the loose parser hands the wall clock to zonedToDate rather than trusting chrono', () => {
  // The regression guard for the whole design. chrono resolves against one fixed offset, so asked
  // in August for a November date in Los Angeles its own Date lands an hour early — 08:30Z, on
  // the PDT offset the zone has now instead of the PST one it will have then. Anything that
  // "simplifies" parseWhenInput to chrono.parseDate() fails here.
  expect(loose('November 2 1:30 AM')).toBe('2026-11-02T09:30:00.000Z');
  expect(loose('November 2 1:30 AM')).toBe(iso('2026-11-02 01:30', LA));
  // The same in the other direction: a summer date read from a winter reference.
  const winter = new Date('2026-12-15T18:00:00Z');
  expect(loose('July 4 12:00 PM', LA, winter)).toBe(iso('2027-07-04 12:00', LA));
});

test('the daylight-saving gap is still refused through the loose path', () => {
  // Clocks jump 02:00 -> 03:00 on 2027-03-14 in Los Angeles — the first spring-forward after NOW.
  expect(parseWhenInput('March 14 2027 2:30 AM', LA, NOW)).toBeNull();
  expect(loose('March 14 2027 1:30 AM')).toBe('2027-03-14T09:30:00.000Z');
  expect(loose('March 14 2027 3:30 AM')).toBe('2027-03-14T10:30:00.000Z');
  // And nothing unusable is ever suggested for it.
  expect(searchWhen('March 14 2027 2:30 AM', LA, NOW)).toStrictEqual([]);
});

test('the canonical format keeps working, and means exactly what it did before', () => {
  // The old input is the fast path, so a canonical string never reaches chrono at all.
  for (const input of ['2026-08-15 19:30', '2026-08-15', '2026-11-02 01:30']) {
    expect(loose(input), `${input} drifted`).toBe(iso(input, LA));
  }
});

test('a date with no time still means midnight', () => {
  // Unchanged on purpose — searchWhen offers the evening times instead of inventing one here.
  expect(loose('Aug 15')).toBe(iso('2026-08-15 00:00', LA));
  expect(loose('friday')).toBe(iso('2026-08-14 00:00', LA));
});

test('the wall clock is read in the given zone, not the host one', () => {
  expect(loose('tomorrow 7pm', 'UTC')).toBe('2026-08-13T19:00:00.000Z');
  expect(loose('tomorrow 7pm', 'Asia/Tokyo')).toBe('2026-08-14T10:00:00.000Z');
  expect(loose('tomorrow 7pm', 'America/New_York')).toBe('2026-08-13T23:00:00.000Z');
});

test('the loose parser rejects junk rather than guessing', () => {
  for (const bad of ['', '   ', null, undefined, 'asdfqwer', 'the usual spot', '99/99/9999']) {
    expect(loose(bad), `should reject ${JSON.stringify(bad)}`).toBeNull();
  }
  expect(parseWhenInput('tomorrow 7pm', 'Mars/Olympus', NOW)).toBeNull();
});

test('every time suggestion is submittable, future, and fits what Discord accepts', () => {
  // The same guard as the zone list: a choice whose value parseWhenInput can't read, or that
  // resolves to a time already gone, would be rejected the moment someone picked it.
  for (const query of ['', '7', '7:30', 'friday', 'tomorrow', 'Aug 15', 'in 2 hours', 'tonight']) {
    const choices = searchWhen(query, LA, NOW);
    expect(choices.length, `"${query}" returned ${choices.length}`).toBeLessThanOrEqual(25);
    expect(choices.length, `"${query}" returned nothing`).toBeGreaterThan(0);
    for (const { name, value } of choices) {
      const at = zonedToDate(value, LA);
      expect(at, `${value} (for "${query}") is not a usable time`).not.toBeNull();
      expect(at!.getTime(), `${value} (for "${query}") is in the past`).toBeGreaterThan(NOW.getTime());
      expect(name.length, `${name} is too long for a Discord choice`).toBeLessThanOrEqual(100);
    }
  }
});

test('an unwritten AM/PM is offered both ways instead of guessed', () => {
  // "7:30" is genuinely two times, and silently picking one is how somebody ends up at a 7 AM
  // party. Soonest first, so the evening reading of a morning-typed time leads.
  const choices = searchWhen('7:30', LA, NOW);
  expect(choices.map((c) => c.value)).toStrictEqual(['2026-08-12 19:30', '2026-08-13 07:30']);
  expect(choices[0]?.name).toContain('7:30 PM');
  expect(choices[1]?.name).toContain('7:30 AM');
  // A written meridiem is not second-guessed.
  expect(searchWhen('7:30pm', LA, NOW).map((c) => c.value)).toStrictEqual(['2026-08-12 19:30']);
});

test('a date with no time offers midnight first, then the evening', () => {
  // Midnight leads because it is what submitting the bare date does — visible, not a surprise.
  const values = searchWhen('Aug 15', LA, NOW).map((c) => c.value);
  expect(values[0]).toBe('2026-08-15 00:00');
  expect(values).toContain('2026-08-15 19:00');
});

test('suggestions are offered before anything is typed, and never for junk', () => {
  const presets = searchWhen('', LA, NOW);
  expect(presets.length).toBeGreaterThan(3);
  expect(presets[0]?.name).toContain('today');
  // Sorted soonest-first, so the dropdown reads as a timeline.
  const times = presets.map((c) => zonedToDate(c.value, LA)!.getTime());
  expect(times).toStrictEqual([...times].sort((a, b) => a - b));
  expect(searchWhen('asdfqwer', LA, NOW)).toStrictEqual([]);
  expect(searchWhen('7:30', 'Mars/Olympus', NOW)).toStrictEqual([]);
});

test('a picked suggestion round-trips back to the same instant', () => {
  // canonicalWhen is what a choice carries as its value, so this is the whole submit path:
  // fuzzy text in, canonical string out, same instant back.
  for (const query of ['tomorrow 7pm', 'friday 8:30pm', 'Aug 15 7pm', 'in 2 hours']) {
    const at = parseWhenInput(query, LA, NOW)!;
    expect(zonedToDate(canonicalWhen(at, LA), LA)?.toISOString(), query).toBe(at.toISOString());
  }
});

test('times are rendered on a 12-hour clock, with the zone that resolved them', () => {
  const at = parseWhenInput('Aug 15 7:30pm', LA, NOW)!;
  expect(formatWhen(at, LA)).toBe('Sat, Aug 15, 2026 · 7:30 PM PDT');
  // Same instant, two zones — the reader can tell which one they are looking at.
  expect(formatWhen(at, 'UTC')).toBe('Sun, Aug 16, 2026 · 2:30 AM UTC');
  // Midnight and noon are the two a 12-hour clock gets wrong when it is hand-rolled.
  expect(formatWhen(zonedToDate('2026-08-15 00:00', LA)!, LA)).toContain('12:00 AM');
  expect(formatWhen(zonedToDate('2026-08-15 12:00', LA)!, LA)).toContain('12:00 PM');
});
