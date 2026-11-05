/**
 * The validated environment, and the Discord objects resolved separately for each guild.
 *
 * They cannot live in index.ts — it *is* the entrypoint and logs the client in at import time,
 * so importing anything from it would boot a bot as a side effect. `Ctx` stays next to `Config`
 * because it's built from one, so splitting them would make every file that takes a `Ctx` name
 * two paths.
 */
import type { Client, ForumChannel, Guild, TextChannel } from 'discord.js';

export interface Config {
  token: string;
  databasePath: string;
  defaultTz: string;
  reminderMinutes: number;
  archiveGraceHours: number;
  placeBias: { lat: number; lon: number } | null;
}

/**
 * One guild's channels, refreshed when its channels change and on each sweep.
 *
 * `Client<true>` is the load-bearing part: it marks the client as logged in, which makes
 * `ctx.client.user` non-null in every consumer that reads our own user id.
 */
export interface Ctx {
  client: Client<true>;
  config: Config;
  guild: Guild;
  forum: ForumChannel;
  digestChannel: TextChannel;
}
