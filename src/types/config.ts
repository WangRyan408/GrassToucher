/**
 * What boot resolves once and passes down: the validated environment, and the Discord objects
 * built out of it.
 *
 * These are `src/index.ts`'s own shapes, but they cannot live there — index.ts *is* the entrypoint
 * and logs the client in at import time, so importing anything from it would boot a bot as a side
 * effect. `Ctx` stays next to `Config` because it's built from one, so splitting them would make
 * every file that takes a `Ctx` name two paths.
 */
import type { Client, ForumChannel, Guild, GuildTextBasedChannel } from 'discord.js';

export interface Config {
  token: string;
  guildId: string;
  forumId: string;
  digestChannelId: string;
  defaultTz: string;
  reminderMinutes: number;
  archiveGraceHours: number;
  placeBias: { lat: number; lon: number } | null;
}

/**
 * Everything resolved once at boot and passed down instead of re-fetched.
 *
 * `Client<true>` is the load-bearing part: it marks the client as logged in, which makes
 * `ctx.client.user` non-null in all four files that read our own user id.
 */
export interface Ctx {
  client: Client<true>;
  config: Config;
  guild: Guild;
  forum: ForumChannel;
  digestChannel: GuildTextBasedChannel;
}
