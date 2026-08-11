import type { Choice } from './types.ts';

export const TIME_FORMAT = 'YYYY-MM-DD HH:MM';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Every zone ICU knows — around 420 of them, tracking whatever tzdata the runtime ships, with
 * nothing here to hand-maintain. `UTC` is prepended because `supportedValuesOf` omits it
 * (along with all of `Etc/*`), and it is the fallback `DEFAULT_TZ`.
 */
const ZONES = ['UTC', ...Intl.supportedValuesOf('timeZone')];

/** Discord's hard cap on autocomplete choices. */
const SUGGESTION_LIMIT = 25;

/** Offered before the first keystroke, behind the server's own default. */
const POPULAR = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
];

/**
 * What people type instead of an IANA name.
 *
 * Consulted *before* `isValidTimeZone`, which is the load-bearing part: ICU accepts `EST`,
 * `MST` and `HST` as real zone IDs, but they are fixed offsets that never observe daylight
 * saving, so `timezone: EST` used to put a July event an hour out. Mapping them at a city
 * zone is the fix.
 *
 * `pacific` means the US zone here and shadows all of `Pacific/*` — someone after Auckland
 * types Auckland. Genuinely ambiguous abbreviations are left out on purpose: `ist` is India,
 * Ireland and Israel, `cst` is also China. Those fall through to the candidate list rather
 * than silently picking a country.
 */
const ALIASES: Record<string, string> = {
  utc: 'UTC',
  gmt: 'UTC',
  et: 'America/New_York',
  est: 'America/New_York',
  edt: 'America/New_York',
  eastern: 'America/New_York',
  ct: 'America/Chicago',
  cst: 'America/Chicago',
  cdt: 'America/Chicago',
  central: 'America/Chicago',
  mt: 'America/Denver',
  mst: 'America/Denver',
  mdt: 'America/Denver',
  mountain: 'America/Denver',
  pt: 'America/Los_Angeles',
  pst: 'America/Los_Angeles',
  pdt: 'America/Los_Angeles',
  pacific: 'America/Los_Angeles',
  akst: 'America/Anchorage',
  akdt: 'America/Anchorage',
  alaska: 'America/Anchorage',
  hst: 'Pacific/Honolulu',
  hawaii: 'Pacific/Honolulu',
  uk: 'Europe/London',
  bst: 'Europe/London',
  cet: 'Europe/Berlin',
  cest: 'Europe/Berlin',
};

/** The last path segment — `New York` of `America/New_York`, which is what people type. */
const cityOf = (zone: string) =>
  zone.slice(zone.lastIndexOf('/') + 1).toLowerCase().replace(/_/g, ' ');

/**
 * Zones whose name contains `query`, best first: a hit at the start of the city outranks one
 * buried mid-word, so "york" leads with `America/New_York` instead of alphabetical order.
 * An alias match is promoted to the front of the list.
 */
function matchZones(query: string): string[] {
  const key = query.trim().toLowerCase();
  if (!key) return [];

  const alias = ALIASES[key];
  const needle = key.replace(/\s+/g, '_'); // "new york" has to find New_York.
  // The alias is excluded here so promoting it below can't list the same zone twice.
  const hits = ZONES.filter((zone) => zone !== alias && zone.toLowerCase().includes(needle));
  hits.sort(
    (a, b) =>
      Number(!cityOf(a).startsWith(key)) - Number(!cityOf(b).startsWith(key)) ||
      a.localeCompare(b),
  );
  return alias ? [alias, ...hits] : hits;
}

/**
 * Suggestions for the `timezone:` option, ready to hand to `interaction.respond()`.
 *
 * Synchronous and can't fail, unlike `searchPlaces`: the zone list is in-process, so there is
 * no network here to time out. Discord fires on the very first keystroke, when there is
 * nothing to match yet — hence the popular list rather than an empty dropdown.
 */
export function searchTimeZones(query: string | undefined | null, defaultTz: string): Choice[] {
  const zones = query?.trim()
    ? matchZones(query)
    : [...new Set([defaultTz, ...POPULAR])]; // defaultTz is usually in POPULAR already.

  return zones.slice(0, SUGGESTION_LIMIT).map((zone) => ({ name: zone, value: zone }));
}

/**
 * Anything that pins down exactly one zone → that zone. Otherwise null, and the caller offers
 * candidates instead of guessing.
 *
 * A real IANA name wins right after the alias check, and the `isValidTimeZone` arm is what
 * keeps legacy links such as `US/Eastern` working: ICU accepts them, but `supportedValuesOf`
 * lists only canonical names, so `ZONES` alone would reject them.
 */
export function resolveTimeZone(input: string): string | null {
  const trimmed = input.trim();
  const key = trimmed.toLowerCase();

  if (ALIASES[key]) return ALIASES[key];
  // Case-insensitive, and hands back the canonical spelling rather than what was typed.
  const exact = ZONES.find((zone) => zone.toLowerCase() === key);
  if (exact) return exact;
  if (isValidTimeZone(trimmed)) return trimmed;

  const hits = matchZones(trimmed);
  return hits.length === 1 ? hits[0] : null;
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
