import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import type { Guild } from 'discord.js';
import { loadConfig } from './config.ts';
import { createContexts } from './context.ts';
import { openGuildDatabase } from './database.ts';
import { rebuildDigest } from './digest.ts';
import { commands, removeGuildCommands, route } from './interactions.ts';
import { sweep } from './sweep.ts';
import { tryCatch } from './utils/tryCatch.ts';

// Keep REMINDER_MINUTES comfortably above this, or a sweep can step over the window
// between "not yet due" and "already started" and skip the ping entirely.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

const config = loadConfig(process.env);
const guildDatabase = openGuildDatabase(config.databasePath);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// `readyClient` is the same object as `client`, but typed Client<true> — logged in, so its
// `.user` is non-null. That's what lets Ctx promise a real user id all the way down.
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  if (!config.placeBias) {
    console.warn(
      'PLACE_BIAS_LAT/PLACE_BIAS_LON are unset, so address suggestions are ranked globally — ' +
        'searching "dolores park" can return Argentina. Set them to your area.',
    );
  }
  const contexts = createContexts(readyClient, config, guildDatabase);
  const pendingChannels = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

  const initializeGuild = async (guild: Guild) => {
    await contexts.refresh(guild);
    // Old guild commands can shadow the global definition after an upgrade. Delete only our
    // slash commands, leaving any other application commands alone.
    const { error } = await tryCatch(removeGuildCommands(guild));
    if (error) console.error(`[${guild.id}] Legacy command cleanup failed:`, error);
  };

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await route(interaction, config, contexts);
    } catch (error) {
      console.error('Interaction failed:', error);
      const sorry = {
        content: 'Something went wrong. Check the bot logs.',
        flags: MessageFlags.Ephemeral as const,
      };
      if (interaction.isRepliable()) {
        // Swallowed: the interaction may already have expired, and we're in the catch block
        // of the thing that went wrong — there's nowhere left to report to but the log above.
        // `<unknown>`: followUp and reply resolve to different things, and the result is
        // discarded, so there's nothing to gain from making them agree.
        await tryCatch<unknown>(
          interaction.deferred || interaction.replied
            ? interaction.followUp(sorry)
            : interaction.reply(sorry),
        );
      }
    }
  });

  // Deleting a post is how you really cancel an event, so it shouldn't wait out the sweep.
  // Debounced because clearing out several posts fires one event each, and every rebuild
  // re-reads the whole forum.
  client.on(Events.ThreadDelete, (thread) => {
    const ctx = contexts.get(thread.guild.id);
    if (!ctx || typeof ctx === 'string' || thread.parentId !== ctx.forum.id) return;
    clearTimeout(pendingDeletes.get(thread.guild.id));
    pendingDeletes.set(thread.guild.id, setTimeout(() => {
      pendingDeletes.delete(thread.guild.id);
      const current = contexts.get(thread.guild.id);
      if (!current || typeof current === 'string') return;
      rebuildDigest(current).catch((error) =>
        console.error(`[${thread.guild.id}] Rebuild after delete failed:`, error),
      );
    }, 1500));
  });

  // Unrelated channel activity must not disable a configured server or postpone its recovery.
  // Include the selected channels' categories, since their permissions can affect setup too.
  const channelsChanged = (guild: Guild, channelId: string) => {
    if (!contexts.invalidate(guild.id, channelId)) return;
    clearTimeout(pendingChannels.get(guild.id));
    pendingChannels.set(guild.id, setTimeout(() => {
      pendingChannels.delete(guild.id);
      void contexts.refresh(guild);
    }, 1500));
  };
  client.on(Events.ChannelCreate, (channel) => channelsChanged(channel.guild, channel.id));
  client.on(Events.ChannelUpdate, (_old, channel) => {
    if ('guild' in channel) channelsChanged(channel.guild, channel.id);
  });
  client.on(Events.ChannelDelete, (channel) => {
    if ('guild' in channel) channelsChanged(channel.guild, channel.id);
  });
  client.on(Events.GuildCreate, (guild) => void initializeGuild(guild));
  client.on(Events.GuildDelete, (guild) => {
    contexts.remove(guild.id);
    clearTimeout(pendingChannels.get(guild.id));
    clearTimeout(pendingDeletes.get(guild.id));
    pendingChannels.delete(guild.id);
    pendingDeletes.delete(guild.id);
  });

  await readyClient.application.commands.set(commands);
  await Promise.all([...readyClient.guilds.cache.values()].map(initializeGuild));

  let sweeping = false;
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await Promise.all([...readyClient.guilds.cache.values()].map(async (guild) => {
        await contexts.refresh(guild);
        const ctx = contexts.get(guild.id);
        if (!ctx || typeof ctx === 'string') return;
        const { error } = await tryCatch(sweep(ctx));
        if (error) console.error(`[${guild.id}] Sweep failed:`, error);
      }));
    } finally {
      sweeping = false;
    }
  };
  await tick();
  setInterval(tick, SWEEP_INTERVAL_MS);
  console.log('Ready.');
});

await client.login(config.token);
