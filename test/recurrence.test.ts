import { expect, test } from 'vitest';
import { isRecurrenceFrequency, nextOccurrence } from '../src/recurrence.ts';
import { zonedToDate } from '../src/time.ts';
import type { Recurrence, RecurrenceFrequency } from '../src/types/recurrence.ts';

function series(frequency: RecurrenceFrequency, when: string, timeZone = 'UTC'): Recurrence {
  const anchor = zonedToDate(when, timeZone);
  expect(anchor, `${when} must exist in ${timeZone}`).not.toBeNull();
  return { frequency, timeZone, anchor };
}

test.each([
  ['daily', '2030-01-02T19:00:00.000Z'],
  ['weekly', '2030-01-08T19:00:00.000Z'],
  ['bi-weekly', '2030-01-15T19:00:00.000Z'],
  ['monthly', '2030-02-01T19:00:00.000Z'],
] as const)('%s advances by the requested calendar interval', (frequency, expected) => {
  const recurrence = series(frequency, '2030-01-01 19:00');
  expect(nextOccurrence(recurrence, recurrence.anchor!)?.toISOString()).toBe(expected);
});

test.each([
  ['daily', '2026-03-07 19:00', '2026-03-09T02:00:00.000Z'],
  ['weekly', '2026-03-01 19:00', '2026-03-09T02:00:00.000Z'],
  ['bi-weekly', '2026-02-22 19:00', '2026-03-09T02:00:00.000Z'],
  ['daily', '2026-10-31 19:00', '2026-11-02T03:00:00.000Z'],
  ['weekly', '2026-10-25 19:00', '2026-11-02T03:00:00.000Z'],
  ['monthly', '2026-10-15 19:00', '2026-11-16T03:00:00.000Z'],
] as const)('%s at %s keeps the local clock time through daylight saving', (frequency, when, expected) => {
  const recurrence = series(frequency, when, 'America/Los_Angeles');
  expect(nextOccurrence(recurrence, recurrence.anchor!)?.toISOString()).toBe(expected);
});

test('monthly clamps a short month without losing the original day', () => {
  const recurrence = series('monthly', '2030-01-31 19:00');
  const february = nextOccurrence(recurrence, recurrence.anchor!)!;
  expect(february.toISOString()).toBe('2030-02-28T19:00:00.000Z');
  expect(nextOccurrence(recurrence, february)?.toISOString()).toBe('2030-03-31T19:00:00.000Z');
  expect(nextOccurrence(recurrence, new Date('2030-12-31T19:00:00Z'))?.toISOString())
    .toBe('2031-01-31T19:00:00.000Z');
});

test('monthly respects leap years', () => {
  const recurrence = series('monthly', '2028-01-31 09:00');
  expect(nextOccurrence(recurrence, recurrence.anchor!)?.toISOString()).toBe('2028-02-29T09:00:00.000Z');
});

test('a nonexistent local clock time skips that occurrence instead of changing later clock times', () => {
  const recurrence = series('daily', '2026-03-07 02:30', 'America/Los_Angeles');
  expect(nextOccurrence(recurrence, recurrence.anchor!)?.toISOString()).toBe('2026-03-09T09:30:00.000Z');
});

test('catch-up jumps to the first future occurrence while keeping the original interval', () => {
  const daily = series('daily', '2000-01-01 19:00');
  expect(nextOccurrence(daily, new Date('2030-01-01T12:00:00Z'))?.toISOString())
    .toBe('2030-01-01T19:00:00.000Z');
  expect(nextOccurrence(daily, new Date('2030-01-01T19:00:00Z'))?.toISOString())
    .toBe('2030-01-02T19:00:00.000Z');
  const fortnightly = series('bi-weekly', '2030-01-01 19:00');
  expect(nextOccurrence(fortnightly, new Date('2030-01-16T12:00:00Z'))?.toISOString())
    .toBe('2030-01-29T19:00:00.000Z');
});

test('TBD, legacy and invalid schedules cannot invent an occurrence', () => {
  const recurrence = series('weekly', '2030-01-01 19:00');
  const after = recurrence.anchor!;
  for (const invalid of [
    { ...recurrence, anchor: null }, { ...recurrence, frequency: null },
    { ...recurrence, timeZone: 'Mars/Olympus' }, { ...recurrence, timeZone: null },
    { ...recurrence, anchor: new Date(NaN) },
  ]) {
    expect(nextOccurrence(invalid, after)).toBeNull();
  }
  expect(nextOccurrence(recurrence, new Date(NaN))).toBeNull();
});

test('a future first occurrence and timestamp precision are preserved', () => {
  const recurrence = series('daily', '2030-01-01 19:00');
  recurrence.anchor!.setUTCMilliseconds(123);
  expect(nextOccurrence(recurrence, new Date('2030-01-01T12:00:00Z'))).toEqual(recurrence.anchor);
  expect(nextOccurrence(recurrence, recurrence.anchor!)?.toISOString()).toBe('2030-01-02T19:00:00.123Z');
});

test('only the four advertised cadences are accepted', () => {
  for (const frequency of ['daily', 'weekly', 'bi-weekly', 'monthly']) expect(isRecurrenceFrequency(frequency)).toBe(true);
  for (const frequency of ['true', 'false', 'yearly', 'biweekly', 'toString', '']) expect(isRecurrenceFrequency(frequency)).toBe(false);
});
