/**
 * `/event create` — opens the forum post that *is* the event record.
 *
 * Each command file exports its own slice of the `/event` definition next to the handler that
 * serves it, so adding an option and reading it are one file apart, not two.
 */
import { MessageFlags, ThreadAutoArchiveDuration, TimestampStyles, time } from 'discord.js';
import type { ChatInputCommandInteraction, SlashCommandSubcommandBuilder } from 'discord.js';
import { rebuildDigest } from '../digest.ts';
import { rsvpRow, threadName, toEmbed } from '../event.ts';
import { formatWhen } from '../time.ts';
import type { Ctx } from '../types/config.ts';
import type { Event } from '../types/event.ts';
import { content, ephemeral, parseWhen } from './shared.ts';

export const createSubcommand = (sub: SlashCommandSubcommandBuilder) =>
  sub
    .setName('create')
    .setDescription('Create an event thread')
    .addStringOption((o) =>
      o.setName('title').setDescription('Event name').setRequired(true).setMaxLength(100),
    )
    .addStringOption((o) =>
      o
        .setName('when')
        .setDescription('Start time — try "tomorrow 7pm", "Friday 7:30 PM" or "Aug 15 7pm"')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('where')
        .setDescription('Location — type to search OpenStreetMap, or write anything')
        .setMaxLength(1024)
        .setAutocomplete(true),
    )
    .addStringOption((o) => o.setName('description').setDescription('What is this event?'))
    .addStringOption((o) =>
      o
        .setName('timezone')
        .setDescription('Timezone — type a city or abbreviation, e.g. Berlin, PST')
        .setAutocomplete(true),
    );

export async function handleCreate(interaction: ChatInputCommandInteraction, ctx: Ctx) {
  const parsed = parseWhen(interaction, ctx);
  if (typeof parsed === 'string') return interaction.reply(ephemeral(parsed));
  if (parsed.startsAt.getTime() < Date.now()) {
    // Name what it read, rather than only that it's wrong. Loose input can land somewhere
    // unintended, and a date with no clock time means midnight — which by the evening is behind
    // you, so "tonight" arrives here rather than at the time the word suggests.
    //
    // Both renderings, on purpose. `formatWhen` names the zone the bot actually parsed in; the
    // markup is drawn by the reader's own client, in theirs. Discord tells a bot nothing about a
    // user's timezone — there is no field, scope or intent for it — so per-viewer markup is the
    // only way to show someone their own clock, and when the two disagree that disagreement is
    // itself the diagnosis.
    return interaction.reply(
      ephemeral(
        `That's already passed — I read it as **${formatWhen(parsed.startsAt, parsed.tz)}**, which is ` +
          `${time(parsed.startsAt, TimestampStyles.FullDateShortTime)} where you are ` +
          `(${time(parsed.startsAt, TimestampStyles.RelativeTime)}). Pick a future time.`,
      ),
    );
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // `title` and `when` are required options, so Discord guarantees they're present — the
  // second argument to getString says so, and hands back a string instead of string | null.
  const event: Event = {
    title: interaction.options.getString('title', true),
    description: interaction.options.getString('description'),
    where: interaction.options.getString('where'),
    startsAt: parsed.startsAt,
    organizerId: interaction.user.id,
    reminded: false,
    cancelled: false,
    rsvp: { going: [interaction.user.id], maybe: [], no: [] },
  };

  const thread = await ctx.forum.threads.create({
    name: threadName(event),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    message: { embeds: [toEmbed(event)], components: [rsvpRow()] },
  });

  await rebuildDigest(ctx);
  // Echo the instant back in markup rather than as text: `when:` was parsed in `parsed.tz`, but
  // this renders in the organizer's *own* client zone, which is the one thing the bot can't know
  // and the only one they'd spot a mistake in. A 7pm they typed coming back as 10pm says it was
  // read in a zone three hours west of where they are.
  return interaction.editReply(
    content(
      `Created ${thread.toString()} — you're down as going. Starts ` +
        `${time(event.startsAt, TimestampStyles.FullDateShortTime)} ` +
        `(${time(event.startsAt, TimestampStyles.RelativeTime)}).`,
    ),
  );
}
