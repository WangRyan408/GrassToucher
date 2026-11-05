import { ChannelType, Collection, PermissionsBitField } from 'discord.js';
import type { Client, ForumChannel, Guild, Message, NonThreadGuildBasedChannel, TextChannel } from 'discord.js';
import { vi } from 'vitest';

let nextMessage = 100000000000000000n;

export function forum(id: string, name = 'any-forum'): ForumChannel {
  return {
    id, name, type: ChannelType.GuildForum,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    threads: {
      create: vi.fn(async () => ({ toString: () => `<#${id}-post>` })),
      fetchActive: vi.fn(async () => ({ threads: new Collection() })),
      fetchArchived: vi.fn(async () => ({ threads: new Collection() })),
    },
  } as unknown as ForumChannel;
}

export function textChannel(id: string, name = 'any-board'): TextChannel {
  const messages = new Collection<string, Message>();
  return {
    id, name, type: ChannelType.GuildText,
    permissionsFor: () => new PermissionsBitField(PermissionsBitField.All),
    messages: {
      fetchPins: vi.fn(async () => ({
        items: [...messages.values()].filter((message) => message.pinned)
          .map((message) => ({ message, pinnedAt: new Date(), pinnedTimestamp: Date.now() })),
        hasMore: false,
      })),
      fetch: vi.fn(async () => messages),
    },
    send: vi.fn(async (options) => {
      const embeds = (data: typeof options) => data.embeds.map((embed: { toJSON?: () => unknown }) =>
        embed.toJSON ? embed.toJSON() : embed);
      const record = {
        id: String(nextMessage++), channelId: id, author: { id: 'bot' },
        embeds: embeds(options), pinned: false,
        pin: vi.fn(async () => { record.pinned = true; }),
        unpin: vi.fn(async () => { record.pinned = false; }),
        edit: vi.fn(async (data) => {
          record.embeds = embeds(data);
          return record as unknown as Message;
        }),
        delete: vi.fn(async () => { messages.delete(record.id); }),
      };
      const message = record as unknown as Message;
      messages.set(message.id, message);
      return message;
    }),
  } as unknown as TextChannel;
}

export function server(id: string, ...entries: NonThreadGuildBasedChannel[]) {
  const channels = new Collection<string, NonThreadGuildBasedChannel | null>(
    entries.map((channel) => [channel.id, channel]),
  );
  const guild = {
    id, available: true,
    channels: { cache: channels, fetch: vi.fn(async () => channels) },
  } as unknown as Guild;
  const client = {
    user: { id: 'bot' }, guilds: { cache: new Collection([[id, guild]]) },
  } as unknown as Client<true>;
  return { guild, client, channels };
}
