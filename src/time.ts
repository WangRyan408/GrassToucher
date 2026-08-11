export const TIME_FORMAT = 'YYYY-MM-DD HH:MM';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** What UTC instant does the clock in `tz` read as, at instant `ts`? */
function wallClockAsUTC(ts: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ts));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value] as const));
  // Some ICU builds render midnight as hour 24.
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
}

/**
 * Read "YYYY-MM-DD HH:MM" as wall-clock time in `tz` and return the UTC instant.
 *
 * Guess by treating the wall time as UTC, see which clock that instant shows in `tz`,
 * then correct by the difference. Twice, because the first correction can itself cross
 * a DST boundary. Finally verify: a time that doesn't exist (the spring-forward gap)
 * won't round-trip, and we reject it rather than silently shifting someone's event.
 *
 * Returns null on malformed input, an unknown timezone, or a nonexistent local time.
 *
 * `input` is `unknown` rather than `string`: it arrives from a Discord option that may be
 * absent, and rejecting junk is the function's job.
 */
export function zonedToDate(input: unknown, tz: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(String(input ?? '').trim());
  if (!m || !isValidTimeZone(tz)) return null;

  const [year, month, day] = m.slice(1, 4).map(Number);
  const hour = m[4] === undefined ? 0 : Number(m[4]);
  const minute = m[5] === undefined ? 0 : Number(m[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const target = Date.UTC(year, month - 1, day, hour, minute);
  // Reject calendar-invalid dates like 2026-02-30, which Date.UTC silently rolls over.
  const rolled = new Date(target);
  if (rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day) return null;

  let ts = target;
  for (let i = 0; i < 2; i++) {
    const shown = wallClockAsUTC(ts, tz);
    if (shown === target) break;
    ts -= shown - target;
  }
  return wallClockAsUTC(ts, tz) === target ? new Date(ts) : null;
}
