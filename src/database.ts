import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { GuildConfigStore, GuildSetup } from './types/setup.ts';

/** Store each server's channel selection in one row, not one table per server. */
export function openGuildDatabase(path: string): GuildConfigStore & { close(): void } {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });

  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY,
      forum_id TEXT NOT NULL,
      digest_channel_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const readSetup = database.prepare(
    'SELECT forum_id, digest_channel_id FROM guild_config WHERE guild_id = ?',
  );
  const writeSetup = database.prepare(`
    INSERT INTO guild_config (guild_id, forum_id, digest_channel_id)
    VALUES (?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      forum_id = excluded.forum_id,
      digest_channel_id = excluded.digest_channel_id,
      updated_at = CURRENT_TIMESTAMP
  `);

  return {
    getGuildSetup(guildId): GuildSetup | null {
      const row = readSetup.get(guildId) as
        | { forum_id: unknown; digest_channel_id: unknown }
        | undefined;
      if (typeof row?.forum_id !== 'string' || typeof row.digest_channel_id !== 'string') return null;
      return { forumId: row.forum_id, digestChannelId: row.digest_channel_id };
    },
    saveGuildSetup(guildId, setup) {
      writeSetup.run(guildId, setup.forumId, setup.digestChannelId);
    },
    close() {
      database.close();
    },
  };
}
