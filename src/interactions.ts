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
import type {
  AutocompleteInteraction,
  ButtonInteraction,
  ChatInputCommandInteraction,
  Interaction,
  ThreadChannel,
  User,
} from 'discord.js';
import { rebuildDigest } from './digest.ts';
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
} from './event.ts';
import { searchPlaces } from './places.ts';
import { TIME_FORMAT, isValidTimeZone, zonedToDate } from './time.ts';
import type { Ctx, Event, EventEntry, RsvpChoice } from './types.ts';
import { tryCatch } from './utils/tryCatch.ts';

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

// `as const` pins the flag to the one enum member: without it the type widens to the whole
// MessageFlags enum, and reply() only accepts the handful of flags it can actually set.
const ephemeral = (text: string) => ({ content: text, flags: MessageFlags.Ephemeral as const });
// editReply can't change ephemerality — deferReply already set it.
const content = (text: string) => ({ content: text });

/**
 * Resolve the `when` + `timezone` options into a Date, or return the complaint to show.
 *
 * A bare string for the failure, not `{ error }`: `if (typeof x === 'string')` narrows, while
 * `if (x.error)` can't rule out the failure arm — an empty error string is falsy too.
 */
function parseWhen(
  interaction: ChatInputCommandInteraction,
  ctx: Ctx,
): { startsAt: Date; tz: string } | string {
  const raw = interaction.options.getString('when');
  const tz = interaction.options.getString('timezone') ?? ctx.config.defaultTz;

  if (!isValidTimeZone(tz)) {
    return `\`${tz}\` isn't a timezone I recognise. Try something like \`Europe/Berlin\`.`;
  }
  const startsAt = zonedToDate(raw, tz);
  if (!startsAt) {
    return `Couldn't read \`${raw}\` as a time. Use \`${TIME_FORMAT}\` on a 24-hour clock, e.g. \`2026-08-15 19:30\`. (A time skipped by a daylight-saving jump won't work either.)`;
  }
  return { startsAt, tz };
}

async function handleCreate(interaction: ChatInputCommandInteraction, ctx: Ctx) {
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

/** The only place in a forum post where strikethrough actually renders. */
const cancelledBanner = (event: Event) => `~~${escapeMarkdown(event.title)}~~ **CANCELLED**`;

/**
 * DM everyone who might have turned up, either way the plan changed. Best effort on
 * purpose: a member with server DMs switched off answers 50007, and one closed inbox must
 * not stop the rest — which is what `tryCatch` buys here: none of these ever reject, so the
 * `Promise.all` can't short-circuit on the first closed inbox.
 *
 * ponytail: one REST call per recipient. MAX_PER_LIST caps this near 80; batch only if it
 * ever costs real rate-limit headroom.
 */
async function notifyAttendees(
  ctx: Ctx,
  event: Event,
  actor: User,
  thread: ThreadChannel,
  recipients: string[],
  { restored = false }: { restored?: boolean } = {},
) {
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

  const results = await Promise.all(
    recipients.map((id) => tryCatch(ctx.client.users.send(id, body))),
  );
  const sent = results.filter((result) => !result.error).length;
  return { sent, failed: results.length - sent };
}

/** How the reply reports a DM fan-out. Cancelling and reinstating word it identically. */
function deliveryNotes(lead: string, { sent, failed }: { sent: number; failed: number }) {
  const notes = [lead];
  if (sent) notes.push(`Notified ${sent}.`);
  if (failed) notes.push(`${failed} couldn't be DMed — their DMs are closed.`);
  return notes.join(' ');
}

/**
 * The guard both in-thread commands share: is this one of our events, and may this person
 * act on it? Kept in one place so edit and cancel can't drift on who's allowed to do what.
 *
 * Returns the entry, or the complaint to show — same reason as `parseWhen`. The thread comes
 * off the interaction rather than being passed in: every caller passed `interaction.channel`.
 */
async function resolveEvent(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  ctx: Ctx,
  verb: string,
): Promise<EventEntry | string> {
  const thread = interaction.channel;
  if (!thread?.isThread() || thread.parentId !== ctx.forum.id) {
    return "Run this inside the event's thread.";
  }

  const entry = await readEvent(thread, ctx.client.user.id);
  if (!entry) return "This thread isn't a GrassToucher event.";

  const isOrganizer = entry.event.organizerId === interaction.user.id;
  const isMod = interaction.memberPermissions?.has(PermissionFlagsBits.ManageThreads);
  if (!isOrganizer && !isMod) {
    return `Only the organizer (or a mod) can ${verb} this event.`;
  }
  return entry;
}

async function handleEdit(interaction: ChatInputCommandInteraction, ctx: Ctx) {
  const found = await resolveEvent(interaction, ctx, 'edit');
  if (typeof found === 'string') return interaction.reply(ephemeral(found));
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
    if (typeof parsed === 'string') return interaction.reply(ephemeral(parsed));
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

async function handleCancel(interaction: ChatInputCommandInteraction, ctx: Ctx) {
  const found = await resolveEvent(interaction, ctx, 'cancel');
  if (typeof found === 'string') return interaction.reply(ephemeral(found));
  const { event } = found;

  if (event.cancelled) return interaction.reply(ephemeral('That event is already cancelled.'));

  const count = notifyRecipients(event, interaction.user.id).length;
  const notice = count
    ? `${count} ${count === 1 ? 'person' : 'people'} will get a DM.`
    : 'Nobody else to notify.';

  return interaction.reply({
    content: `Cancel **${escapeMarkdown(event.title)}**? The post stays, marked CANCELLED. ${notice}`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
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

async function handleCancelConfirm(interaction: ButtonInteraction, ctx: Ctx) {
  await interaction.deferUpdate();

  // The confirm can sit unclicked for minutes, so re-read and re-authorize rather than
  // trusting anything /event cancel established.
  const found = await resolveEvent(interaction, ctx, 'cancel');
  if (typeof found === 'string') return interaction.editReply({ content: found, components: [] });

  const { thread, message, event } = found;
  if (event.cancelled) {
    return interaction.editReply({ content: 'That event is already cancelled.', components: [] });
  }

  const recipients = notifyRecipients(event, interaction.user.id);
  const cancelled: Event = { ...event, cancelled: true };

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

/** `hasOwn`, not `in`: the prototype chain would answer yes to a custom id of `rsvp:toString`. */
const isChoice = (value: string): value is RsvpChoice => Object.hasOwn(CHOICES, value);

/**
 * ponytail: two people clicking at the same instant can have one write win, losing the
 * other RSVP. Discord offers no compare-and-swap on message edits and a re-click fixes
 * it, so this stays unguarded.
 */
async function handleRsvp(interaction: ButtonInteraction, ctx: Ctx) {
  const choice = interaction.customId.split(':')[1];
  if (!isChoice(choice)) return;
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
 * not repliable, so index.ts's catch-all can't answer one, and an unanswered interaction
 * leaves "loading options failed" sitting in the client. Every failure is an empty list.
 *
 * Still a try/catch rather than a `tryCatch`: `getFocused(true)` throws *synchronously*, and
 * tryCatch only wraps a promise.
 */
async function handleAutocomplete(interaction: AutocompleteInteraction, ctx: Ctx) {
  try {
    const focused = interaction.options.getFocused(true); // Throws with nothing focused.
    if (focused.name !== 'where') return interaction.respond([]);
    await interaction.respond(await searchPlaces(focused.value, ctx.config.placeBias));
  } catch (error) {
    console.error('Autocomplete failed:', error);
    // May itself throw if the respond above already landed; nothing left to do either way.
    await tryCatch(interaction.respond([]));
  }
}

export async function route(interaction: Interaction, ctx: Ctx) {
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
