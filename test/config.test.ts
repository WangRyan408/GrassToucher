import { expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';

test('only the token is required for a multi-server install', () => {
  expect(loadConfig({ DISCORD_TOKEN: 'test-token' })).toEqual({
    databasePath: './data/grasstoucher.sqlite',
    token: 'test-token',
    defaultTz: 'UTC',
    reminderMinutes: 60,
    archiveGraceHours: 12,
    placeBias: null,
  });
  expect(() => loadConfig({})).toThrow('DISCORD_TOKEN');
});

test('old environment IDs cannot bypass per-server setup', () => {
  const config = loadConfig({
    DISCORD_TOKEN: 'test-token',
    GUILD_ID: 'old-guild',
    EVENT_FORUM_ID: 'old-forum',
    DIGEST_CHANNEL_ID: 'old-digest',
  });
  expect(config).not.toHaveProperty('forumId');
  expect(config).not.toHaveProperty('digestChannelId');
  expect(config).not.toHaveProperty('guildId');
});

test('keeps timezone, numeric and coordinate validation when IDs are omitted', () => {
  const env = { DISCORD_TOKEN: 'test-token' };
  expect(loadConfig({ ...env, DEFAULT_TZ: 'EST' }).defaultTz).toBe('America/New_York');
  expect(() => loadConfig({ ...env, DEFAULT_TZ: 'not a zone' })).toThrow('DEFAULT_TZ');
  expect(() => loadConfig({ ...env, REMINDER_MINUTES: '-1' })).toThrow('REMINDER_MINUTES');
  expect(() => loadConfig({ ...env, ARCHIVE_GRACE_HOURS: 'NaN' })).toThrow('ARCHIVE_GRACE_HOURS');
  expect(() => loadConfig({ ...env, PLACE_BIAS_LAT: '37' })).toThrow('Set both');
  expect(() => loadConfig({ ...env, PLACE_BIAS_LAT: '91', PLACE_BIAS_LON: '-122' })).toThrow('PLACE_BIAS_LAT');
  expect(loadConfig({ ...env, PLACE_BIAS_LAT: '37', PLACE_BIAS_LON: '-122' }).placeBias)
    .toEqual({ lat: 37, lon: -122 });
});
