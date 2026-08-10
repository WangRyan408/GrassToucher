import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  TimestampStyles,
  time,
} from 'discord.js';
import { rebuildDigest } from './digest.js';
import { embedColor, ensureOpen, toEmbed } from './event.js';
import { commands, route } from './interactions.js';
import { isValidTimeZone } from './time.js';

// Keep REMINDER_MINUTES comfortably above this, or a sweep can step over the window
// between "not yet due" and "already started" and skip the ping entirely.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function loadConfig(env) {
  const required = ['DISCORD_TOKEN', 'GUILD_ID', 'EVENT_FORUM_ID', 'DIGEST_CHANNEL_ID'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

  const defaultTz = env.DEFAULT_TZ ?? 'UTC';
  if (!isValidTimeZone(defaultTz)) throw new Error(`DEFAULT_TZ is not a valid timezone: ${defaultTz}`);

  const num = (key, fallback) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a positive number`);
    return value;
  };

  return {
    token: env.DISCORD_TOKEN,
    guildId: env.GUILD_ID,
    forumId: env.EVENT_FORUM_ID,
    digestChannelId: env.DIGEST_CHANNEL_ID,
    defaultTz,
    reminderMinutes: num('REMINDER_MINUTES', 60),
    archiveGraceHours: num('ARCHIVE_GRACE_HOURS', 12),
  };
}

async function buildContext(client, config) {
  const guild = await client.guilds.fetch(config.guildId);
  const forum = await guild.channels.fetch(config.forumId);
  const digestChannel = await guild.channels.fetch(config.digestChannelId);

  if (forum?.type !== ChannelType.GuildForum) {
    throw new Error(`EVENT_FORUM_ID must point at a forum channel (got type ${forum?.type})`);
  }
  if (!digestChannel?.isTextBased() || digestChannel.isThread()) {
    throw new Error('DIGEST_CHANNEL_ID must point at a normal text channel');
  }

  return { client, config, guild, forum, digestChannel };
}

/**
 * Ping attendees shortly before start, tidy up finished events, then refresh the digest.
 *
 * Reminders are idempotent through the `reminded` marker in the embed footer, and the
 * lower time bound means a bot that was offline through the window stays quiet rather
 * than announcing an event that already started.
 */
async function sweep(ctx) {
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

    if (untilStart < -graceMs && !thread.archived) {
      // Compare against the colour toEmbed would pick, not a fixed constant: a cancelled
      // event stays red forever, and a mismatched test here re-edits it every sweep.
      if (message.embeds[0]?.color !== embedColor(event)) {
        await message.edit({ embeds: [toEmbed(event)] }); // Re-renders grey now it's past.
      }
      await thread.setArchived(true, 'Event finished');
    }
  }
}

const config = loadConfig(process.env);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const ctx = await buildContext(client, config);

  // Guild-scoped registration is idempotent and propagates instantly, so there's no
  // separate deploy step to remember.
  await ctx.guild.commands.set(commands);

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await route(interaction, ctx);
    } catch (error) {
      console.error('Interaction failed:', error);
      const sorry = { content: 'Something went wrong. Check the bot logs.', flags: MessageFlags.Ephemeral };
      if (interaction.isRepliable()) {
        await (interaction.deferred || interaction.replied
          ? interaction.followUp(sorry)
          : interaction.reply(sorry)
        ).catch(() => {});
      }
    }
  });

  // Deleting a post is how you really cancel an event, so it shouldn't wait out the sweep.
  // Debounced because clearing out several posts fires one event each, and every rebuild
  // re-reads the whole forum.
  let pending;
  client.on(Events.ThreadDelete, (thread) => {
    if (thread.parentId !== ctx.forum.id) return;
    clearTimeout(pending);
    pending = setTimeout(
      () => rebuildDigest(ctx).catch((error) => console.error('Rebuild after delete failed:', error)),
      1500,
    );
  });

  const tick = () => sweep(ctx).catch((error) => console.error('Sweep failed:', error));
  await tick();
  setInterval(tick, SWEEP_INTERVAL_MS);
  console.log('Ready.');
});

await client.login(config.token);
