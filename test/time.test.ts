import { expect, test } from 'vitest';
import { isValidTimeZone, zonedToDate } from '../src/time.ts';

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
