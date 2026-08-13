/**
 * The Photon response shape. `src/places.ts` is the adapter that fetches and formats it.
 */

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
