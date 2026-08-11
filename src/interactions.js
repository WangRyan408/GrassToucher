import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ThreadAutoArchiveDuration,
  TimestampStyles,
  escapeMarkdown,
  time,
} from 'discord.js';
import { rebuildDigest } from './digest.js';
import {
  CHOICES,
  applyRsvp,
  displayTitle,
  ensureOpen,
  fromEmbed,
  isOurs,
  notifyRecipients,
  readEvent,
  rsvpRow,
  toEmbed,
} from './event.js';
import { searchPlaces } from './places.js';
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
          o
            .setName('where')
            .setDescription('Location — type to search OpenStreetMap, or write anything')
            .setMaxLength(1024)
            .setAutocomplete(true),
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
          o
            .setName('where')
            .setDescription('New location — type to search OpenStreetMap, or write anything')
            .setMaxLength(1024)
            .setAutocomplete(true),
        )
        .addStringOption((o) => o.setName('description').setDescription('New description'))
        .addStringOption((o) =>
          o.setName('timezone').setDescription('IANA timezone for "when"'),
        )
        .addBooleanOption((o) =>
          o.setName('uncancel').setDescription("It's back on — undo a cancellation"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('cancel')
        .setDescription("Cancel this event (run inside the event's thread)"),
    )
    .toJSON(),
];

const CANCEL_ID = 'cancel';

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

/** The only place in a forum post where strikethrough actually renders. */
const cancelledBanner = (event) => `~~${escapeMarkdown(event.title)}~~ **CANCELLED**`;

/**
 * DM everyone who might have turned up, either way the plan changed. Best effort on
 * purpose: a member with server DMs switched off answers 50007, and one closed inbox must
 * not stop the rest.
 *
 * ponytail: one REST call per recipient. MAX_PER_LIST caps this near 80; batch only if it
 * ever costs real rate-limit headroom.
 */
async function notifyAttendees(ctx, event, actor, thread, recipients, { restored = false } = {}) {
  const when = `${time(event.startsAt, TimestampStyles.LongDateTime)} (${time(event.startsAt, TimestampStyles.RelativeTime)})`;
  const title = escapeMarkdown(event.title);
  const guild = escapeMarkdown(ctx.guild.name);

  const body = restored
    ? [
        `**Back on: ${title}**`,
        `In **${guild}** · ${when}`, // Whatever the time is *now* — an edit may have moved it.
        `Reinstated by ${actor.toString()} · ${thread.url}`,
      ].join('\n')
    : [
        `**Cancelled: ${title}**`,
        `In **${guild}** · was scheduled for ${when}`,
        `Cancelled by ${actor.toString()} · ${thread.url}`,
      ].join('\n');

  const results = await Promise.allSettled(recipients.map((id) => ctx.client.users.send(id, body)));
  const sent = results.filter((r) => r.status === 'fulfilled').length;
  return { sent, failed: results.length - sent };
}

/** How the reply reports a DM fan-out. Cancelling and reinstating word it identically. */
function deliveryNotes(lead, { sent, failed }) {
  const notes = [lead];
  if (sent) notes.push(`Notified ${sent}.`);
  if (failed) notes.push(`${failed} couldn't be DMed — their DMs are closed.`);
  return notes.join(' ');
}

/**
 * The guard both in-thread commands share: is this one of our events, and may this person
 * act on it? Kept in one place so edit and cancel can't drift on who's allowed to do what.
 */
async function resolveEvent(thread, interaction, ctx, verb) {
  if (!thread?.isThread() || thread.parentId !== ctx.forum.id) {
    return { error: "Run this inside the event's thread." };
  }

  const entry = await readEvent(thread, ctx.client.user.id);
  if (!entry) return { error: "This thread isn't a GrassToucher event." };

  const isOrganizer = entry.event.organizerId === interaction.user.id;
  const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads);
  if (!isOrganizer && !isMod) {
    return { error: `Only the organizer (or a mod) can ${verb} this event.` };
  }
  return entry;
}

async function handleEdit(interaction, ctx) {
  const found = await resolveEvent(interaction.channel, interaction, ctx, 'edit');
  if (found.error) return interaction.reply(ephemeral(found.error));
  const { thread, message, event } = found;

  const title = interaction.options.getString('title');
  const when = interaction.options.getString('when');
  const where = interaction.options.getString('where');
  const description = interaction.options.getString('description');
  // `uncancel: False` is nothing to change, same as leaving it out.
  const uncancel = interaction.options.getBoolean('uncancel') ?? false;
  if (!title && !when && !where && !description && !uncancel) {
    return interaction.reply(ephemeral('Nothing to change — pass at least one option.'));
  }
  if (uncancel && !event.cancelled) {
    return interaction.reply(ephemeral("That event isn't cancelled."));
  }

  if (when) {
    const parsed = parseWhen(interaction, ctx);
    if (parsed.error) return interaction.reply(ephemeral(parsed.error));
    event.startsAt = parsed.startsAt;
  }
  if (title) event.title = title;
  if (where) event.where = where;
  if (description) event.description = description;
  // Clearing the marker is the whole of un-cancelling: every render below already asks
  // `event.cancelled` what to draw, so the banner, buttons, colour and name follow.
  if (uncancel) event.cancelled = false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await ensureOpen(thread);
  // A cancelled event keeps its banner and stays button-less through an edit.
  await message.edit({
    content: event.cancelled ? cancelledBanner(event) : '',
    embeds: [toEmbed(event)],
    components: event.cancelled ? [] : [rsvpRow()],
  });
  // Rename on any drift, not just a new title: un-cancelling has to take the marker off
  // the post name too, and nothing else moves this name.
  const name = displayTitle(event, 100);
  if (thread.name !== name) await thread.setName(name);
  await rebuildDigest(ctx);

  if (!uncancel) return interaction.editReply(content('Updated.'));

  // Those people were told it was off. Leaving that DM standing is worse than one more.
  const delivery = await notifyAttendees(
    ctx,
    event,
    interaction.user,
    thread,
    notifyRecipients(event, interaction.user.id),
    { restored: true },
  );
  return interaction.editReply(
    content(deliveryNotes(`**${escapeMarkdown(event.title)}** is back on.`, delivery)),
  );
}

async function handleCancel(interaction, ctx) {
  const found = await resolveEvent(interaction.channel, interaction, ctx, 'cancel');
  if (found.error) return interaction.reply(ephemeral(found.error));
  const { event } = found;

  if (event.cancelled) return interaction.reply(ephemeral('That event is already cancelled.'));

  const count = notifyRecipients(event, interaction.user.id).length;
  const notice = count
    ? `${count} ${count === 1 ? 'person' : 'people'} will get a DM.`
    : 'Nobody else to notify.';

  return interaction.reply({
    content: `Cancel **${escapeMarkdown(event.title)}**? The post stays, marked CANCELLED. ${notice}`,
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(CANCEL_ID)
          .setLabel('Cancel event')
          .setEmoji('🚫')
          .setStyle(ButtonStyle.Danger),
      ),
    ],
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCancelConfirm(interaction, ctx) {
  await interaction.deferUpdate();

  // The confirm can sit unclicked for minutes, so re-read and re-authorize rather than
  // trusting anything /event cancel established.
  const found = await resolveEvent(interaction.channel, interaction, ctx, 'cancel');
  if (found.error) return interaction.editReply({ content: found.error, components: [] });

  const { thread, message, event } = found;
  if (event.cancelled) {
    return interaction.editReply({ content: 'That event is already cancelled.', components: [] });
  }

  const recipients = notifyRecipients(event, interaction.user.id);
  const cancelled = { ...event, cancelled: true };

  await ensureOpen(thread); // Archived threads reject edits and renames.
  await message.edit({
    content: cancelledBanner(cancelled),
    embeds: [toEmbed(cancelled)],
    components: [], // RSVPing to a cancelled event is meaningless.
  });
  // ponytail: Discord allows 2 channel renames per 10 min. discord.js waits it out, so a
  // rapid edit-edit-cancel just takes longer — we're already deferred.
  await thread.setName(displayTitle(cancelled, 100));

  const delivery = await notifyAttendees(ctx, cancelled, interaction.user, thread, recipients);
  await rebuildDigest(ctx);

  return interaction.editReply({
    content: deliveryNotes(`Cancelled **${escapeMarkdown(event.title)}**.`, delivery),
    components: [],
  });
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
  // Cancelling strips the buttons, but a stale client can still send the click — and
  // answering it would put the whole row back on a cancelled event.
  if (event.cancelled) return interaction.reply(ephemeral('That event was cancelled.'));

  const result = applyRsvp(event, interaction.user.id, choice);

  // Nothing moved, so skip the message edit and the digest rebuild — but still answer, or
  // Discord shows the click as failed.
  if (result === 'unchanged') {
    return interaction.reply(
      ephemeral(`Your answer is already **${CHOICES[choice].label}**. Pick another button to change it.`),
    );
  }

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

/**
 * Suggest addresses while someone types `where:`.
 *
 * Owns its error handling, unlike every other handler here: an autocomplete interaction is
 * not repliable, so index.js's catch-all can't answer one, and an unanswered interaction
 * leaves "loading options failed" sitting in the client. Every failure is an empty list.
 */
async function handleAutocomplete(interaction, ctx) {
  try {
    const focused = interaction.options.getFocused(true); // Throws with nothing focused.
    if (focused.name !== 'where') return interaction.respond([]);
    await interaction.respond(await searchPlaces(focused.value, ctx.config.placeBias));
  } catch (error) {
    console.error('Autocomplete failed:', error);
    // May itself throw if the respond above already landed; nothing left to do either way.
    await interaction.respond([]).catch(() => {});
  }
}

export async function route(interaction, ctx) {
  // First: this fires on every keystroke, so it's the busiest branch by a wide margin.
  if (interaction.isAutocomplete()) return handleAutocomplete(interaction, ctx);

  if (interaction.isChatInputCommand() && interaction.commandName === 'event') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') return handleCreate(interaction, ctx);
    if (sub === 'edit') return handleEdit(interaction, ctx);
    if (sub === 'cancel') return handleCancel(interaction, ctx);
    return;
  }
  if (interaction.isButton()) {
    if (interaction.customId === CANCEL_ID) return handleCancelConfirm(interaction, ctx);
    if (interaction.customId.startsWith('rsvp:')) return handleRsvp(interaction, ctx);
  }
}
