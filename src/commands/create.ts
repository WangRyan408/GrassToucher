/**
 * `/event create` — opens the forum post that *is* the event record.
 *
 * Each command file exports its own slice of the `/event` definition next to the handler that
 * serves it, so adding an option and reading it are one file apart, not two.
 */
import { MessageFlags, ThreadAutoArchiveDuration } from 'discord.js';
import type { ChatInputCommandInteraction, SlashCommandSubcommandBuilder } from 'discord.js';
import { rebuildDigest } from '../digest.ts';
import { rsvpRow, toEmbed } from '../event.ts';
import { TIME_FORMAT } from '../time.ts';
import type { Ctx, Event } from '../types.ts';
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
        .setDescription(`Start time, ${TIME_FORMAT} (24-hour), e.g. 2026-08-15 19:30`)
        .setRequired(true),
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
    return interaction.reply(ephemeral("That time has already passed — pick a future one."));
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
    name: event.title.slice(0, 100),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    message: { embeds: [toEmbed(event)], components: [rsvpRow()] },
  });

  await rebuildDigest(ctx);
  return interaction.editReply(content(`Created ${thread.toString()} — you're down as going.`));
}
