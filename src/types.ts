/**
 * The shapes that cross module boundaries.
 *
 * These live here rather than in index.ts because index.ts *is* the entrypoint — it logs the
 * client in at import time, so importing a value from it would boot a bot as a side effect.
 */
import type {
  Client,
  ForumChannel,
  Guild,
  GuildTextBasedChannel,
  Message,
  ThreadChannel,
} from 'discord.js';

export type RsvpChoice = 'going' | 'maybe' | 'no';

export type Rsvp = Record<RsvpChoice, string[]>;

/**
 * One event, as stored in its forum post's embed. This is the record — `fromEmbed` produces
 * it, `toEmbed` renders it, and the digest, the sweep and every handler read it.
 *
 * `organizerId` is nullable because it's parsed out of the footer, and a footer we can't
 * read is still an event we have to render.
 */
export interface Event {
  title: string;
  description: string | null;
  startsAt: Date;
  where: string | null;
  organizerId: string | null;
  reminded: boolean;
  cancelled: boolean;
  rsvp: Rsvp;
}

/** An event plus the two Discord objects you need to change it. */
export interface EventEntry {
  thread: ThreadChannel;
  message: Message;
  event: Event;
}

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
