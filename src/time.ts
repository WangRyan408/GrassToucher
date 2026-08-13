import * as chrono from 'chrono-node/en';
import type { Choice } from './types/autocomplete.ts';

/**
 * The canonical spelling: what `zonedToDate` reads, what every autocomplete choice submits, and
 * the one form guaranteed to mean exactly one instant. People no longer have to type it —
 * `parseWhenInput` takes most of what they'd write instead — so it survives only in the
 * complaint shown when nothing parsed at all.
 */
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

/** A wall-clock reading in some zone. Deliberately not a Date: it isn't an instant yet. */
interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Parts → the canonical string, which is the only input `zonedToDate` accepts. */
const canonical = (p: Parts) =>
  `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;

/** The UTC-component trick from `wallClockAsUTC`, read back out as fields. */
function partsInZone(ts: number, tz: string): Parts {
  const shown = new Date(wallClockAsUTC(ts, tz));
  return {
    year: shown.getUTCFullYear(),
    month: shown.getUTCMonth() + 1,
    day: shown.getUTCDate(),
    hour: shown.getUTCHours(),
    minute: shown.getUTCMinutes(),
  };
}

/** Calendar arithmetic on parts. `Date.UTC` carries the month and year rollover for us. */
function shiftDays(p: Parts, days: number): Parts {
  const moved = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return {
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
    hour: p.hour,
    minute: p.minute,
  };
}

/**
 * An instant back to the canonical string, in `tz`. This is what an autocomplete choice carries
 * as its `value`, so picking a suggestion submits something the strict parser reads exactly —
 * the fuzzy reading happens once, here, and never again on the way back.
 */
export function canonicalWhen(date: Date, tz: string): string {
  return canonical(partsInZone(date.getTime(), tz));
}

/**
 * A formatter per zone. Bounded by the ~420 zones ICU knows, so it cannot grow without bound —
 * and autocomplete builds up to 25 labels per keystroke, which is worth not re-constructing.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The 12-hour rendering, and the only place one is built.
 *
 * Note what this is *not* for: the embeds, the digest and the cancellation DMs all use Discord's
 * `<t:…>` markup instead, which every reader's own client renders in their own zone and their own
 * locale's clock. Formatting those here would force one zone and one clock on everybody. This is
 * for the surfaces Discord won't render for us — autocomplete labels and error messages.
 */
export function formatWhen(date: Date, tz: string): string {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      // The zone is part of the echo: "7:00 PM" alone isn't something anyone can check. `short`
      // tracks daylight saving on its own, so August reads PDT and December PST, and a zone with
      // no common abbreviation falls back to a GMT offset rather than to nothing.
      timeZoneName: 'short',
    });
    formatters.set(tz, format);
  }
  // en-US gives "Thu, Aug 13, 2026, 7:00 PM PDT"; the middot reads better and shortens the label.
  return format.format(date).replace(/,\s*(\d{1,2}:\d{2})/, ' · $1');
}

/** Already canonical? Then it means what it has always meant, and chrono never sees it. */
const CANONICAL_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?$/;

/** A lone hour — chrono declines "7" outright, though it reads "7:00" and "7pm" fine. */
const BARE_HOUR_RE = /^([01]?\d|2[0-3])$/;

/**
 * What offset is `tz` on at `ts`, in minutes — chrono's `ParsingReference.timezone`.
 *
 * Without it chrono resolves "tomorrow" and "in 2 hours" against whatever zone the *host* is in,
 * which in a container is UTC and in development is not.
 */
function offsetMinutes(ts: number, tz: string): number {
  // wallClockAsUTC drops seconds, so compare against a `ts` that has also lost them.
  return (wallClockAsUTC(ts, tz) - Math.floor(ts / 60000) * 60000) / 60000;
}

/**
 * chrono's first reading of `text`, as a wall clock in `tz`.
 *
 * The two things this deliberately throws away:
 *
 * `timezoneOffset` — chrono sets one from the reference zone on relative phrases, and from the
 * text itself on "7pm EST". Honouring the latter would walk straight back into the bug
 * `ALIASES` above exists to prevent: chrono maps `EST` to a flat −5 that never observes daylight
 * saving, so a summer "7pm EST" lands an hour off. The `timezone:` option resolves abbreviations
 * properly, and the dropdown names the zone it used, so a zone written into `when:` is ignored
 * rather than half-honoured.
 *
 * An *implied* hour — chrono fills "friday" in at noon and "tonight" at 22:00. Those are its
 * guesses, not the writer's, so `isCertain` decides and a dateless reading falls to midnight,
 * which is what a bare date has always meant here. `searchWhen` is where the alternatives get
 * offered, because there they're visible before anyone commits to one.
 */
function readParts(result: chrono.ParsedResult): { parts: Parts; hasTime: boolean; hasDate: boolean } {
  const { start } = result;
  const hasTime = start.isCertain('hour');
  const at = (c: 'year' | 'month' | 'day') => start.get(c) ?? 0;
  return {
    hasTime,
    hasDate: start.isCertain('day'),
    parts: {
      year: at('year'),
      month: at('month'),
      day: at('day'),
      hour: hasTime ? (start.get('hour') ?? 0) : 0,
      minute: hasTime ? (start.get('minute') ?? 0) : 0,
    },
  };
}

function parseLoosely(input: unknown, tz: string, now: Date): chrono.ParsedResult | null {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const normalized = BARE_HOUR_RE.test(text) ? `${text}:00` : text;
  // forwardDate is what stops a bare "friday" resolving to the one that has already gone.
  const reference = { instant: now, timezone: offsetMinutes(now.getTime(), tz) };
  return chrono.parse(normalized, reference, { forwardDate: true })[0] ?? null;
}

/**
 * Read whatever someone typed into `when:` as an instant — "tomorrow 7pm", "friday 7:30 PM",
 * "Aug 15", "in 2 hours", or the canonical `YYYY-MM-DD HH:MM` this used to demand.
 *
 * Every path lands on `zonedToDate`, and that is the whole design. chrono can produce a Date of
 * its own, but it resolves against a single fixed offset: asked in August for "November 2 1:30 AM"
 * in Los Angeles it answers 08:30Z, an hour off, because it applies the offset that zone is on
 * *now* rather than the one it will be on then. Handing the wall clock to `zonedToDate` instead
 * gets the DST-correct instant and inherits its refusal of times daylight saving skips.
 *
 * `now` is a parameter so the tests don't depend on the clock. Returns null on anything unreadable.
 */
export function parseWhenInput(input: unknown, tz: string, now: Date = new Date()): Date | null {
  if (!isValidTimeZone(tz)) return null;

  const text = String(input ?? '').trim();
  if (CANONICAL_RE.test(text)) return zonedToDate(text, tz);

  const result = parseLoosely(input, tz, now);
  if (!result) return null;
  return zonedToDate(canonical(readParts(result).parts), tz);
}

/**
 * Wall clocks worth offering for `result`, before any of them is checked against the calendar.
 *
 * Two readings earn their place here. A time whose meridiem was never written ("7:30") is
 * genuinely two times, and guessing silently is how someone ends up with a 7 AM party. And when
 * the *date* was chrono's guess too, the clock time is what the writer meant, so each reading is
 * re-anchored to today and pushed to tomorrow only if that hour has already gone — which is how
 * "7:30" at 10 AM offers 7:30 PM today ahead of 7:30 AM tomorrow.
 */
function candidateParts(result: chrono.ParsedResult, tz: string, now: Date): Parts[] {
  const { parts, hasTime, hasDate } = readParts(result);
  if (!hasTime) {
    // Midnight first — it's what submitting this date plainly does, so it has to be visible
    // rather than a surprise. The rest are there because midnight is rarely the plan.
    return [parts, ...[12, 18, 19, 20].map((hour) => ({ ...parts, hour, minute: 0 }))];
  }

  const readings = result.start.isCertain('meridiem')
    ? [parts]
    : [parts, { ...parts, hour: (parts.hour + 12) % 24 }];
  if (hasDate) return readings;

  const today = partsInZone(now.getTime(), tz);
  return readings.map((reading) => {
    const onToday = { ...today, hour: reading.hour, minute: reading.minute };
    const at = zonedToDate(canonical(onToday), tz);
    return at && at.getTime() > now.getTime() ? onToday : shiftDays(onToday, 1);
  });
}

/** Ready-made answers for an empty box, so the dropdown is useful before the first keystroke. */
function presetParts(tz: string, now: Date): Parts[] {
  const today = partsInZone(now.getTime(), tz);
  const at = (days: number, hour: number) => ({ ...shiftDays(today, days), hour, minute: 0 });
  // Past ones are filtered downstream, so "tonight" quietly drops out as the evening goes on.
  return [at(0, 18), at(0, 19), at(0, 20), at(1, 12), at(1, 19), at(2, 19), at(5, 19), at(6, 12)];
}

/**
 * Suggestions for the `when:` option, ready to hand to `interaction.respond()`.
 *
 * Synchronous and can't fail, like `searchTimeZones` and unlike `searchPlaces` — chrono runs
 * in-process, so there's no network here to time out.
 *
 * Every choice carries a canonical `value`, so what gets submitted is exact even though what was
 * typed was not. Echoing the resolved instant back *before* submit is what makes loose parsing
 * safe rather than surprising, and it's why nothing is offered that the calendar rejects: past
 * instants and times daylight saving skips are dropped rather than shown and then refused.
 *
 * An unreadable query returns `[]` — the same designed silence as `where:`. No error toast, and
 * the text still submits to `parseWhen`, which explains itself properly.
 */
export function searchWhen(
  query: string | undefined | null,
  tz: string,
  now: Date = new Date(),
): Choice[] {
  if (!isValidTimeZone(tz)) return [];

  const text = query?.trim() ?? '';
  let parts: Parts[];
  if (!text) {
    parts = presetParts(tz, now);
  } else {
    const result = parseLoosely(text, tz, now);
    if (!result) return [];
    parts = candidateParts(result, tz, now);
  }

  const seen = new Set<string>();
  return parts
    .map((p) => canonical(p))
    .filter((value) => !seen.has(value) && seen.add(value))
    .map((value) => ({ value, at: zonedToDate(value, tz) }))
    // A DST-gap candidate resolves to null, and a past one can't be created anyway.
    .filter((c): c is { value: string; at: Date } => c.at !== null && c.at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, SUGGESTION_LIMIT)
    .map(({ value, at }) => ({ name: label(at, tz, now), value }));
}

/** `Thu, Aug 13, 2026 · 7:00 PM · tomorrow`, inside Discord's 100-character cap on a choice. */
function label(at: Date, tz: string, now: Date): string {
  const days = dayGap(now, at, tz);
  const hint = days === 0 ? ' · today' : days === 1 ? ' · tomorrow' : '';
  // The weekday is already in formatWhen, so nothing past tomorrow needs a hint.
  return `${formatWhen(at, tz)}${hint}`.slice(0, 100);
}

/** Whole days between two instants as the calendar in `tz` counts them, not as 24-hour blocks. */
function dayGap(from: Date, to: Date, tz: string): number {
  const a = partsInZone(from.getTime(), tz);
  const b = partsInZone(to.getTime(), tz);
  const midnight = (p: Parts) => Date.UTC(p.year, p.month - 1, p.day);
  return Math.round((midnight(b) - midnight(a)) / 86400000);
}
