/**
 * `/event edit` — changes any field on an existing event, and un-cancels one.
 *
 * The cancellation helpers come from `./cancel.ts`: `uncancel:` undoes what that file did, and
 * has to render the banner and word the DM identically or the two flows drift.
 */
import { MessageFlags, TimestampStyles, escapeMarkdown, time } from 'discord.js';
import type { ChatInputCommandInteraction, SlashCommandSubcommandBuilder } from 'discord.js';
import { rebuildDigest } from '../digest.ts';
import { ensureOpen, isPaused, notifyRecipients, rsvpRow, threadName, toEmbed } from '../event.ts';
import { isRecurrenceFrequency, nextOccurrence, RECURRENCE_CHOICES } from '../recurrence.ts';
import type { Ctx } from '../types/config.ts';
import { cancelledBanner, deliveryNotes, notifyAttendees } from './cancel.ts';
import { content, ephemeral, parseTimeZone, parseWhen, resolveEvent } from './shared.ts';

export const editSubcommand = (sub: SlashCommandSubcommandBuilder) =>
  sub
    .setName('edit')
    .setDescription("Edit this event (run inside the event's thread)")
    .addStringOption((o) => o.setName('title').setDescription('New name').setMaxLength(100))
    .addStringOption((o) =>
      o
        .setName('when')
        .setDescription('New start time — try "friday 7pm" or "TBD" to clear the date')
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('where')
        .setDescription('New location — type to search OpenStreetMap, or write anything')
        .setMaxLength(1024)
        .setAutocomplete(true),
    )
    .addStringOption((o) => o.setName('description').setDescription('New description'))
    .addStringOption((o) =>
      o
        .setName('timezone')
        .setDescription('Timezone for "when" — type a city or abbreviation')
        .setAutocomplete(true),
    )
    .addBooleanOption((o) =>
      o.setName('uncancel').setDescription("It's back on — undo a cancellation"),
    )
    .addStringOption((o) =>
      o.setName('recurring').setDescription('Change the recurrence, or choose none to stop repeating')
        .addChoices(...RECURRENCE_CHOICES, { name: 'none', value: 'none' }),
    );

export async function handleEdit(interaction: ChatInputCommandInteraction, ctx: Ctx) {
  const found = await resolveEvent(interaction, ctx, 'edit');
  if (typeof found === 'string') return interaction.reply(ephemeral(found));
  const { thread, message, event } = found;

  const title = interaction.options.getString('title');
  const when = interaction.options.getString('when');
  const where = interaction.options.getString('where');
  const description = interaction.options.getString('description');
  const frequency = interaction.options.getString('recurring');
  // `uncancel: False` is nothing to change, same as leaving it out.
  const uncancel = interaction.options.getBoolean('uncancel') ?? false;
  if (!title && !when && !where && !description && !uncancel && frequency === null) {
    return interaction.reply(ephemeral('Nothing to change — pass at least one option.'));
  }
  if (uncancel && !event.cancelled) {
    return interaction.reply(ephemeral("That event isn't cancelled."));
  }
  if (frequency !== null && frequency !== 'none' && !isRecurrenceFrequency(frequency)) {
    return interaction.reply(ephemeral('Choose `daily`, `weekly`, `bi-weekly`, `monthly` or `none` for recurring.'));
  }

  let timeZone = event.recurring?.timeZone ?? ctx.config.defaultTz;
  if (when) {
    // Match the timezone shown by autocomplete: an explicit option, otherwise DEFAULT_TZ.
    const parsed = parseWhen(interaction, ctx);
    if (typeof parsed === 'string') return interaction.reply(ephemeral(parsed));
    // A reminder for the old date must not suppress the one for a newly scheduled event.
    if (event.startsAt?.getTime() !== parsed.startsAt?.getTime()) event.reminded = false;
    event.startsAt = parsed.startsAt;
    timeZone = parsed.tz;
    if (event.recurring) {
      event.recurring = { ...event.recurring, timeZone, anchor: parsed.startsAt };
    }
  } else if (frequency && frequency !== 'none') {
    const parsed = parseTimeZone(interaction, ctx, timeZone);
    if (typeof parsed === 'string') return interaction.reply(ephemeral(parsed));
    timeZone = parsed.tz;
  }
  if (frequency !== null) {
    event.recurring = frequency === 'none' ? null : {
      frequency, timeZone, anchor: event.startsAt,
    };
  }
  if (title) event.title = title;
  if (where) event.where = where;
  if (description) event.description = description;
  // Clearing the marker is the whole of un-cancelling: every render below already asks
  // `event.cancelled` what to draw, so the banner, buttons, colour and name follow.
  if (uncancel) {
    event.cancelled = false;
    if (event.recurring && event.startsAt && event.startsAt.getTime() <= Date.now() && !isPaused(event)) {
      const next = nextOccurrence(event.recurring, new Date());
      if (next) {
        // The reinstatement DM must quote the next date rather than the cancelled one in the past.
        event.startsAt = next;
        event.reminded = false;
      }
    }
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await ensureOpen(thread);
  // A cancelled event keeps its banner and stays button-less through an edit.
  await message.edit({
    content: event.cancelled ? cancelledBanner(event) : '',
    embeds: [toEmbed(event)],
    components: event.cancelled ? [] : [rsvpRow()],
  });
  // Rename on any drift, not just a new title: un-cancelling has to take the marker off the
  // post name and turn the dot back to green, and a new `when:` can move the dot on its own.
  const name = threadName(event);
  if (thread.name !== name) await thread.setName(name);
  await rebuildDigest(ctx);

  if (!uncancel) {
    // Only when the time moved: the same per-viewer echo create does, for the same reason — this
    // is the one command that can silently reschedule an event into the wrong zone. Left off the
    // other fields, where a timestamp nobody changed reads as if something had.
    return interaction.editReply(
      content(
        when
          ? event.startsAt
            ? `Updated — now starts ${time(event.startsAt, TimestampStyles.FullDateShortTime)} ` +
              `(${time(event.startsAt, TimestampStyles.RelativeTime)}).`
            : 'Updated — date TBD.'
          : 'Updated.',
      ),
    );
  }

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
