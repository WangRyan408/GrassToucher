import { resolveTimeZone } from './time.ts';
import type { Config } from './types/config.ts';

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (!env.DISCORD_TOKEN) throw new Error('Missing required env vars: DISCORD_TOKEN');

  // Through the same resolver the slash option uses, so `DEFAULT_TZ=EST` can't boot into the
  // fixed-offset zone that ignores daylight saving.
  const defaultTz = resolveTimeZone(env.DEFAULT_TZ ?? 'UTC');
  if (!defaultTz) throw new Error(`DEFAULT_TZ is not a timezone I recognise: ${env.DEFAULT_TZ}`);

  const num = (key: string, fallback: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a positive number`);
    return value;
  };

  // Coordinates get their own parser: num() rejects negatives, and half the planet has a
  // negative longitude. Reusing it would refuse to boot west of Greenwich.
  const coord = (key: string, limit: number) => {
    if (!env[key]) return null;
    const value = Number(env[key]);
    if (!Number.isFinite(value) || Math.abs(value) > limit) {
      throw new Error(`${key} must be a number between -${limit} and ${limit}`);
    }
    return value;
  };

  const lat = coord('PLACE_BIAS_LAT', 90);
  const lon = coord('PLACE_BIAS_LON', 180);
  // One without the other silently does nothing, which surfaces as "why is it suggesting
  // Argentina" rather than as a config error.
  if ((lat === null) !== (lon === null)) {
    throw new Error('Set both PLACE_BIAS_LAT and PLACE_BIAS_LON, or neither');
  }

  return {
    databasePath: env.DATABASE_PATH?.trim() || './data/grasstoucher.sqlite',
    placeBias: lat === null || lon === null ? null : { lat, lon },
    token: env.DISCORD_TOKEN,
    defaultTz,
    reminderMinutes: num('REMINDER_MINUTES', 60),
    archiveGraceHours: num('ARCHIVE_GRACE_HOURS', 12),
  };
}
