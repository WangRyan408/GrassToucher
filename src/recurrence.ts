import { canonicalWhen, isValidTimeZone, zonedToDate } from './time.ts';
import type { Recurrence, RecurrenceFrequency } from './types/recurrence.ts';

const LABELS: Record<RecurrenceFrequency, string> = {
  daily: 'Daily', weekly: 'Weekly', 'bi-weekly': 'Every 2 weeks', monthly: 'Monthly',
};

export const RECURRENCE_CHOICES = Object.keys(LABELS).map((value) => ({ name: value, value }));

export const isRecurrenceFrequency = (value: string): value is RecurrenceFrequency =>
  Object.hasOwn(LABELS, value);

export const recurrenceLabel = (recurrence: Recurrence): string =>
  recurrence.frequency ? LABELS[recurrence.frequency] : 'Schedule not set';

function calendarParts(date: Date, timeZone: string) {
  const [year, month, day, hour, minute] = canonicalWhen(date, timeZone).split(/[- :]/).map(Number);
  return { year, month, day, hour, minute };
}

/** The first occurrence strictly after `after`, anchored in the organizer's original timezone. */
export function nextOccurrence(recurrence: Recurrence, after: Date): Date | null {
  const { frequency, timeZone, anchor } = recurrence;
  if (!frequency || !timeZone || !anchor || !isValidTimeZone(timeZone) ||
    !Number.isFinite(anchor.getTime()) || !Number.isFinite(after.getTime())) return null;

  const origin = calendarParts(anchor, timeZone);
  const current = calendarParts(after, timeZone);
  const days = frequency === 'daily' ? 1 : frequency === 'weekly' ? 7 : 14;
  const originDay = Date.UTC(origin.year, origin.month - 1, origin.day);
  const currentDay = Date.UTC(current.year, current.month - 1, current.day);
  // Jump near the current date instead of replaying years of missed daily occurrences.
  let step = Math.max(0, frequency === 'monthly'
    ? (current.year - origin.year) * 12 + current.month - origin.month
    : Math.floor((currentDay - originDay) / (days * 86_400_000)));
  const pad = (value: number) => String(value).padStart(2, '0');

  for (;; step++) {
    let year: number;
    let month: number;
    let day: number;
    if (frequency === 'monthly') {
      const months = origin.year * 12 + origin.month - 1 + step;
      year = Math.floor(months / 12);
      month = months % 12 + 1;
      day = Math.min(origin.day, new Date(Date.UTC(year, month, 0)).getUTCDate());
    } else {
      const moved = new Date(originDay + step * days * 86_400_000);
      year = moved.getUTCFullYear();
      month = moved.getUTCMonth() + 1;
      day = moved.getUTCDate();
    }
    // The existing wall-clock codec accepts four-digit years.
    if (!Number.isFinite(year) || year > 9999 || year < 100) return null;
    const candidate = zonedToDate(
      `${year}-${pad(month)}-${pad(day)} ${pad(origin.hour)}:${pad(origin.minute)}`,
      timeZone,
    );
    // A daylight-saving gap skips that occurrence, keeping later ones at the intended clock time.
    if (!candidate) continue;
    candidate.setTime(candidate.getTime() + anchor.getUTCSeconds() * 1000 + anchor.getUTCMilliseconds());
    if (candidate.getTime() > after.getTime()) return candidate;
  }
}
