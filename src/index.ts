import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  TimestampStyles,
  time,
} from 'discord.js';
import { rebuildDigest } from './digest.ts';
import { embedColor, ensureOpen, threadName, toEmbed } from './event.ts';
import { commands, route } from './interactions.ts';
import { resolveTimeZone } from './time.ts';
import type { Config, Ctx } from './types/config.ts';
import { tryCatch } from './utils/tryCatch.ts';

// Keep REMINDER_MINUTES comfortably above this, or a sweep can step over the window
// between "not yet due" and "already started" and skip the ping entirely.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

function loadConfig(env: NodeJS.ProcessEnv): Config {
  const required = ['DISCORD_TOKEN', 'GUILD_ID', 'EVENT_FORUM_ID', 'DIGEST_CHANNEL_ID'];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

  // Through the same resolver the slash option uses, so `DEFAULT_TZ=EST` can't boot into the
  // fixed-offset zone that ignores daylight saving.
  const defaultTz = resolveTimeZone(env.DEFAULT_TZ ?? 'UTC');
  if (!defaultTz) throw new Error(`DEFAULT_TZ is not a timezone I recognise: ${env.DEFAULT_TZ}`);

  const num = (key: string, fallback: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${key} must be a positive number`);
    return value;
  };

  // Coordinates get their own parser: num() rejects negatives, and half the planet has a
  // negative longitude. Reusing it would refuse to boot west of Greenwich.
  const coord = (key: string, limit: number) => {
    if (!env[key]) return null;
    const value = Number(env[key]);
    if (!Number.isFinite(value) || Math.abs(value) > limit) {
      throw new Error(`${key} must be a number between -${limit} and ${limit}`);
    }
    return value;
  };

  const lat = coord('PLACE_BIAS_LAT', 90);
  const lon = coord('PLACE_BIAS_LON', 180);
  // One without the other silently does nothing, which surfaces as "why is it suggesting
  // Argentina" rather than as a config error.
  if ((lat === null) !== (lon === null)) {
    throw new Error('Set both PLACE_BIAS_LAT and PLACE_BIAS_LON, or neither');
  }

  return {
    // `lon` is checked too, so neither is null here — the pair check above only proves it to us.
    placeBias: lat === null || lon === null ? null : { lat, lon },
    // The four required keys are what the `missing` check just guaranteed.
    token: env.DISCORD_TOKEN!,
    guildId: env.GUILD_ID!,
    forumId: env.EVENT_FORUM_ID!,
    digestChannelId: env.DIGEST_CHANNEL_ID!,
    defaultTz,
    reminderMinutes: num('REMINDER_MINUTES', 60),
    archiveGraceHours: num('ARCHIVE_GRACE_HOURS', 12),
  };
}

async function buildContext(client: Client<true>, config: Config): Promise<Ctx> {
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
  const ctx = await buildContext(readyClient, config);

  // Guild-scoped registration is idempotent and propagates instantly, so there's no
  // separate deploy step to remember.
  await ctx.guild.commands.set(commands);

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await route(interaction, ctx);
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
  let pending: ReturnType<typeof setTimeout> | undefined;
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
