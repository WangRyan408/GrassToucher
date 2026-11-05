import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Client, Guild } from 'discord.js';
import { SETUP_REQUIRED, loadLegacySetup, retireLegacySetup } from './setup.ts';
import type { Config, Ctx } from './types/config.ts';
import type { GuildConfigStore, GuildContexts, GuildSetup } from './types/setup.ts';

const FORUM_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.ManageThreads,
];

const DIGEST_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.PinMessages,
];

/** Resolve only the channels explicitly selected in this guild's setup. */
export async function buildContext(
  client: Client<true>,
  config: Config,
  guild: Guild,
  setup: GuildSetup | null,
): Promise<Ctx | string> {
  if (!setup?.forumId || !setup.digestChannelId) return SETUP_REQUIRED;
  const channels = await guild.channels.fetch();
  const forum = channels.get(setup.forumId);
  const digestChannel = channels.get(setup.digestChannelId);
  if (forum?.type !== ChannelType.GuildForum || digestChannel?.type !== ChannelType.GuildText) {
    return 'The configured forum or digest channel is missing or has the wrong type. ' +
      'Ask someone with Manage Server to run `/setup forum: digest:` again.';
  }
  if (!forum.permissionsFor(client.user)?.has(FORUM_PERMISSIONS)) {
    return 'Grant me View Channel, Send Messages, Send Messages in Threads, Embed Links, ' +
      'Read Message History and Manage Threads in the configured forum, or run `/setup` again.';
  }
  if (!digestChannel.permissionsFor(client.user)?.has(DIGEST_PERMISSIONS)) {
    return 'Grant me View Channel, Send Messages, Embed Links, Read Message History and Pin Messages ' +
      'in the configured digest channel, or run `/setup` again.';
  }
  return { client, config, guild, forum, digestChannel };
}

export function createContexts(
  client: Client<true>,
  config: Config,
  store: GuildConfigStore,
): GuildContexts {
  const contexts = new Map<string, Ctx | string>();
  const settings = new Map<string, GuildSetup>();
  const validating = new Map<string, GuildSetup>();
  const revisions = new Map<string, symbol>();
  const legacyChecked = new Set<string>();
  const running = new Map<string, Promise<unknown>>();

  const isCurrent = (guild: Guild, revision: symbol) =>
    client.guilds.cache.get(guild.id) === guild && revisions.get(guild.id) === revision;

  // Serialize refresh and setup within a guild: an older fetch finishing after /setup must
  // never put the old channels back. Other guilds can still load and configure independently.
  const enqueue = <T>(guildId: string, work: () => Promise<T>): Promise<T> => {
    const previous = running.get(guildId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(work).finally(() => {
      if (running.get(guildId) === task) running.delete(guildId);
    });
    running.set(guildId, task);
    return task;
  };

  return {
    get: (guildId) => contexts.get(guildId) ?? SETUP_REQUIRED,
    refresh(guild) {
      // A refresh requested after invalidation needs its own fetch, even when earlier work
      // is still running. Its response may describe the channels before they changed.
      return enqueue(guild.id, async () => {
        if (client.guilds.cache.get(guild.id) !== guild) return;
        const revision = Symbol();
        revisions.set(guild.id, revision);
        try {
          if (!guild.available) {
            contexts.set(guild.id, 'This server is temporarily unavailable. Try again later.');
            return;
          }
          let setup = settings.get(guild.id) ?? store.getGuildSetup(guild.id);
          if (!setup && !legacyChecked.has(guild.id)) {
            const legacy = await loadLegacySetup(guild, client.user.id);
            if (!isCurrent(guild, revision)) return;
            if (legacy) {
              // Save before retiring the pins, so an interrupted migration can safely retry.
              store.saveGuildSetup(guild.id, legacy.setup);
              setup = legacy.setup;
              legacyChecked.add(guild.id);
              await retireLegacySetup(guild, legacy.records);
            } else {
              legacyChecked.add(guild.id);
            }
          }
          const ctx = await buildContext(client, config, guild, setup);
          if (!isCurrent(guild, revision)) return;
          if (setup) settings.set(guild.id, setup);
          if (typeof ctx === 'string' && contexts.get(guild.id) !== ctx) {
            console.warn(`[${guild.id}] ${ctx}`);
          }
          contexts.set(guild.id, ctx);
        } catch (error) {
          if (!isCurrent(guild, revision)) return;
          contexts.set(
            guild.id,
            'I could not load this server\'s setup. Check the bot logs and permissions, or run `/setup` again.',
          );
          console.error(`[${guild.id}] Setup loading failed:`, error);
        }
      });
    },
    configure(guild, setup) {
      return enqueue(guild.id, async () => {
        if (client.guilds.cache.get(guild.id) !== guild) return SETUP_REQUIRED;
        const revision = Symbol();
        revisions.set(guild.id, revision);
        validating.set(guild.id, setup);
        try {
          const ctx = await buildContext(client, config, guild, setup);
          if (!isCurrent(guild, revision)) {
            return 'The selected channels changed during setup. Run `/setup` again.';
          }
          if (typeof ctx === 'string') return ctx;
          store.saveGuildSetup(guild.id, setup);
          legacyChecked.add(guild.id);
          settings.set(guild.id, setup);
          contexts.set(guild.id, ctx);
          return ctx;
        } finally {
          if (validating.get(guild.id) === setup) validating.delete(guild.id);
        }
      });
    },
    invalidate(guildId, channelId) {
      if (channelId !== undefined) {
        const guild = client.guilds.cache.get(guildId);
        const selections = [settings.get(guildId) ?? store.getGuildSetup(guildId), validating.get(guildId)];
        const relevant = selections.some((setup) => setup &&
          [setup.forumId, setup.digestChannelId].some((id) =>
            id === channelId || guild?.channels.cache.get(id)?.parentId === channelId));
        if (!relevant) return false;
      }
      // Invalidating the visible cache alone lets an in-flight fetch put stale channels back.
      revisions.set(guildId, Symbol());
      contexts.delete(guildId);
      return true;
    },
    remove(guildId) {
      contexts.delete(guildId);
      settings.delete(guildId);
      validating.delete(guildId);
      revisions.delete(guildId);
      legacyChecked.delete(guildId);
    },
  };
}
