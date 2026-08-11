/**
 * Address lookup for the `where:` option, backed by Photon (photon.komoot.io).
 *
 * Photon is OpenStreetMap data, needs no API key, and is built for search-as-you-type. It
 * also matters that ODbL lets us *store* the result: this bot writes the address into an
 * embed and keeps it forever, which Google's and Mapbox's standard terms forbid.
 *
 * Nominatim is not an option here — its usage policy lists auto-complete under
 * "Unacceptable Use".
 */
import { tryCatch } from './utils/tryCatch.ts';

const ENDPOINT = 'https://photon.komoot.io/api/';

/** Discord fires an autocomplete interaction on every keystroke, including the first. */
const MIN_QUERY = 3;
/** Discord allows 25 choices. Past about 8 it's just scrolling. */
const LIMIT = 8;
/** Autocomplete cannot be deferred and the interaction dies at 3s, so leave headroom. */
const TIMEOUT_MS = 2000;
/** Discord caps a choice's name and value at 100 characters each. */
const CHOICE_CAP = 100;

const UA = 'GrassToucher (Discord event bot; https://github.com/WangRyan408/GrassToucher)';

/**
 * The five keys we read off a Photon feature. It sends a dozen more (country, postcode,
 * osm_*, extent), hence the index signature — they're ignored, not rejected.
 */
export interface PhotonProperties {
  name?: string;
  housenumber?: string;
  street?: string;
  city?: string;
  state?: string;
  [key: string]: unknown;
}

/** Shaped for `interaction.respond()`, which wants name/value pairs. */
export interface Choice {
  name: string;
  value: string;
}

/**
 * Photon GeoJSON properties → one human-readable line.
 *
 * Pure, and the only part of this file worth testing: everything else is a fetch.
 */
export function formatPlace(properties: PhotonProperties = {}): string {
  const { name, housenumber, street, city, state } = properties;

  const parts = [
    // A street feature puts the street in `name`, so using both would repeat it.
    name === street ? null : name,
    [housenumber, street].filter(Boolean).join(' '),
    city,
    state,
  ].filter(Boolean);

  // Drop from the tail — losing "California" reads better than a word cut in half.
  while (parts.length > 1 && parts.join(', ').length > CHOICE_CAP) parts.pop();
  return parts.join(', ').slice(0, CHOICE_CAP);
}

/**
 * ponytail: crude bound, not an LRU — past the ceiling the whole thing goes. Photon's own
 * `Cache-Control: max-age=3600` says caching is welcome, so this is politeness to them more
 * than speed for us. Swap in an LRU only if the hit rate ever matters.
 */
const cache = new Map<string, Choice[]>();
const CACHE_MAX = 500;

/** The fallible half, split out so `tryCatch` can wrap it: throws, and the caller decides. */
async function fetchChoices(url: URL): Promise<Choice[]> {
  const response = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Photon answered ${response.status}`);

  const { features } = (await response.json()) as { features?: { properties?: PhotonProperties }[] };
  return (features ?? [])
    .map((feature) => formatPlace(feature.properties))
    .filter(Boolean)
    .map((label) => ({ name: label, value: label }));
}

/**
 * Suggestions for `query`, ready to hand to `interaction.respond()`.
 *
 * Never throws and never returns an over-long choice. An autocomplete that errors shows the
 * user "loading options failed" with no way to dismiss it, so every failure here is an empty
 * list instead.
 *
 * `bias` is `{lat, lon}` or null. Without it results are scattered worldwide — "dolores par"
 * returns Argentina and Spain rather than the park two miles away — so it is close to
 * mandatory in practice, but a missing one must not break the search.
 */
export async function searchPlaces(
  query: string | undefined | null,
  bias: { lat: number; lon: number } | null,
): Promise<Choice[]> {
  const q = query?.trim() ?? '';
  if (q.length < MIN_QUERY) return []; // Short prefixes never leave the process.

  const key = q.toLowerCase();
  const hit = cache.get(key); // An empty array is a real answer, and still truthy.
  if (hit) return hit;

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(LIMIT));
  if (bias) {
    url.searchParams.set('lat', String(bias.lat));
    url.searchParams.set('lon', String(bias.lon));
  }

  const { data: choices, error } = await tryCatch(fetchChoices(url));
  if (error) {
    console.error(`Place lookup for "${q}" failed:`, error.message);
    return []; // Deliberately uncached: a timeout shouldn't poison the query for an hour.
  }

  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, choices);
  return choices;
}
