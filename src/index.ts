import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  TimestampStyles,
  time,
} from 'discord.js';
import type { Guild } from 'discord.js';
import { loadConfig } from './config.ts';
import { createContexts } from './context.ts';
import { openGuildDatabase } from './database.ts';
import { rebuildDigest } from './digest.ts';
import { embedColor, ensureOpen, threadName, toEmbed } from './event.ts';
import { commands, removeGuildCommands, route } from './interactions.ts';
import type { Ctx } from './types/config.ts';
import { tryCatch } from './utils/tryCatch.ts';

// Keep REMINDER_MINUTES comfortably above this, or a sweep can step over the window
// between "not yet due" and "already started" and skip the ping entirely.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Ping attendees shortly before start, tidy up finished events, then refresh the digest.
 *
 * Reminders are idempotent through the `reminded` marker in the embed footer, and the
 * lower time bound means a bot that was offline through the window stays quiet rather
 * than announcing an event that already started.
 *
 * Keeping the status dot current is also what lifted the colour check out of the archive step.
 * The dot and the embed colour are one fact rendered twice, so they have to move together — and
 * `embedColor` has always said grey the moment an event starts, so a post now goes grey and ⚫
 * at its start time rather than hours later when the grace period happens to run out.
 */
async function sweep(ctx: Ctx) {
  const entries = await rebuildDigest(ctx);
  const now = Date.now();
  const reminderMs = ctx.config.reminderMinutes * 60_000;
  const graceMs = ctx.config.archiveGraceHours * 3_600_000;

  for (const { thread, message, event } of entries) {
    const untilStart = event.startsAt.getTime() - now;

    if (!event.cancelled && !event.reminded && untilStart >= 0 && untilStart <= reminderMs) {
      await ensureOpen(thread);
      const invitees = [...event.rsvp.going, ...event.rsvp.maybe];
      const who = invitees.length ? invitees.map((id) => `<@${id}>`).join(' ') : '';
      const when = time(event.startsAt, TimestampStyles.RelativeTime);
      await thread.send(`**${event.title}** starts ${when}. ${who}`.trim());
      await message.edit({ embeds: [toEmbed({ ...event, reminded: true })] });
      continue; // Leave archiving for a later sweep.
    }

    // Both renderings of the state, checked together so the post can't contradict itself.
    // Only while it's open, and before the archive step: renaming an archived thread reopens
    // it, so a sweep that "fixed" a dot on an archived post would undo the archiving below and
    // fight itself every ten minutes. An archived post keeps the dot it went in with — which
    // is the one this block set on the way out, since a post is still open when it gets here.
    if (!thread.archived) {
      // Compare against what toEmbed and threadName would pick, not fixed constants: a
      // cancelled event stays red forever, and a mismatched test here re-renders every sweep.
      if (message.embeds[0]?.color !== embedColor(event)) {
        await message.edit({ embeds: [toEmbed(event)] }); // Re-renders grey now it's past.
      }
      const name = threadName(event);
      if (thread.name !== name) await thread.setName(name);
    }

    if (untilStart < -graceMs && !thread.archived) {
      await thread.setArchived(true, 'Event finished');
    }
  }
}

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
