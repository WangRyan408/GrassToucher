/**
 * Its own file because `src/time.ts` and `src/places.ts` both answer with these, so it belongs
 * to neither.
 */

/** One autocomplete suggestion, shaped for `interaction.respond()`, which wants name/value. */
export interface Choice {
  name: string;
  value: string;
}
