import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
} from 'discord.js';
import { rebuildDigest } from './digest.js';
import { CHOICES, applyRsvp, ensureOpen, fromEmbed, isOurs, rsvpRow, toEmbed } from './event.js';
import { TIME_FORMAT, isValidTimeZone, zonedToDate } from './time.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Create and manage events')
    .addSubcommand((sub) =>
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
          o.setName('where').setDescription('Location or link').setMaxLength(1024),
        )
        .addStringOption((o) => o.setName('description').setDescription('What is this event?'))
        .addStringOption((o) =>
          o.setName('timezone').setDescription('IANA timezone, e.g. Europe/Berlin'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('edit')
        .setDescription("Edit this event (run inside the event's thread)")
        .addStringOption((o) => o.setName('title').setDescription('New name').setMaxLength(100))
        .addStringOption((o) => o.setName('when').setDescription(`New start time, ${TIME_FORMAT}`))
        .addStringOption((o) =>
          o.setName('where').setDescription('New location').setMaxLength(1024),
        )
        .addStringOption((o) => o.setName('description').setDescription('New description'))
        .addStringOption((o) =>
          o.setName('timezone').setDescription('IANA timezone for "when"'),
        ),
    )
    .toJSON(),
];

const ephemeral = (text) => ({ content: text, flags: MessageFlags.Ephemeral });
// editReply can't change ephemerality — deferReply already set it.
const content = (text) => ({ content: text });

/** Resolve the `when` + `timezone` options into a Date, or return an error string. */
function parseWhen(interaction, ctx) {
  const raw = interaction.options.getString('when');
  const tz = interaction.options.getString('timezone') ?? ctx.config.defaultTz;

  if (!isValidTimeZone(tz)) {
    return { error: `\`${tz}\` isn't a timezone I recognise. Try something like \`Europe/Berlin\`.` };
  }
  const startsAt = zonedToDate(raw, tz);
  if (!startsAt) {
    return {
      error: `Couldn't read \`${raw}\` as a time. Use \`${TIME_FORMAT}\` on a 24-hour clock, e.g. \`2026-08-15 19:30\`. (A time skipped by a daylight-saving jump won't work either.)`,
    };
  }
  return { startsAt, tz };
}

async function handleCreate(interaction, ctx) {
  const parsed = parseWhen(interaction, ctx);
  if (parsed.error) return interaction.reply(ephemeral(parsed.error));
  if (parsed.startsAt.getTime() < Date.now()) {
    return interaction.reply(ephemeral("That time has already passed — pick a future one."));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const event = {
    title: interaction.options.getString('title'),
    description: interaction.options.getString('description'),
    where: interaction.options.getString('where'),
    startsAt: parsed.startsAt,
    organizerId: interaction.user.id,
    reminded: false,
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

async function handleEdit(interaction, ctx) {
  const thread = interaction.channel;
  if (!thread?.isThread() || thread.parentId !== ctx.forum.id) {
    return interaction.reply(ephemeral("Run this inside the event's thread."));
  }

  const message = await thread.fetchStarterMessage().catch(() => null);
  if (!isOurs(message, ctx.client.user.id)) {
    return interaction.reply(ephemeral("This thread isn't a GrassToucher event."));
  }

  const event = fromEmbed(message.embeds[0]);
  const isOrganizer = event.organizerId === interaction.user.id;
  const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads);
  if (!isOrganizer && !isMod) {
    return interaction.reply(ephemeral('Only the organizer (or a mod) can edit this event.'));
  }

  const title = interaction.options.getString('title');
  const when = interaction.options.getString('when');
  const where = interaction.options.getString('where');
  const description = interaction.options.getString('description');
  if (!title && !when && !where && !description) {
    return interaction.reply(ephemeral('Nothing to change — pass at least one option.'));
  }

  if (when) {
    const parsed = parseWhen(interaction, ctx);
    if (parsed.error) return interaction.reply(ephemeral(parsed.error));
    event.startsAt = parsed.startsAt;
  }
  if (title) event.title = title;
  if (where) event.where = where;
  if (description) event.description = description;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await ensureOpen(thread);
  await message.edit({ embeds: [toEmbed(event)], components: [rsvpRow()] });
  if (title && thread.name !== title) await thread.setName(title.slice(0, 100));
  await rebuildDigest(ctx);

  return interaction.editReply(content('Updated.'));
}

/**
 * ponytail: two people clicking at the same instant can have one write win, losing the
 * other RSVP. Discord offers no compare-and-swap on message edits and a re-click fixes
 * it, so this stays unguarded.
 */
async function handleRsvp(interaction, ctx) {
  const choice = interaction.customId.split(':')[1];
  if (!(choice in CHOICES)) return;
  if (!isOurs(interaction.message, ctx.client.user.id)) return;

  const event = fromEmbed(interaction.message.embeds[0]);
  const result = applyRsvp(event, interaction.user.id, choice);

  if (result === 'full') {
    return interaction.reply(
      ephemeral(`The ${CHOICES[choice].label} list is full. Ask the organizer to make space.`),
    );
  }

  if (interaction.channel?.isThread()) await ensureOpen(interaction.channel);
  // The visibly-updated list is the confirmation, so one API call does the whole job.
  await interaction.update({ embeds: [toEmbed(event)], components: [rsvpRow()] });
  await rebuildDigest(ctx);
}

export async function route(interaction, ctx) {
  if (interaction.isChatInputCommand() && interaction.commandName === 'event') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') return handleCreate(interaction, ctx);
    if (sub === 'edit') return handleEdit(interaction, ctx);
    return;
  }
  if (interaction.isButton() && interaction.customId.startsWith('rsvp:')) {
    return handleRsvp(interaction, ctx);
  }
}
