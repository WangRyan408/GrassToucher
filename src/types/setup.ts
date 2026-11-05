import type { Guild } from 'discord.js';
import type { Ctx } from './config.ts';

export interface GuildSetup {
  forumId: string;
  digestChannelId: string;
}

export interface GuildConfigStore {
  getGuildSetup(guildId: string): GuildSetup | null;
  saveGuildSetup(guildId: string, setup: GuildSetup): void;
}

export interface GuildContexts {
  get(guildId: string): Ctx | string;
  refresh(guild: Guild): Promise<void>;
  configure(guild: Guild, setup: GuildSetup): Promise<Ctx | string>;
  /** With a channel ID, returns false when that change cannot affect this server's setup. */
  invalidate(guildId: string, channelId?: string): boolean;
  remove(guildId: string): void;
}
