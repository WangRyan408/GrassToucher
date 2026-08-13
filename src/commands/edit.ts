/**
 * `/event edit` — changes any field on an existing event, and un-cancels one.
 *
 * The cancellation helpers come from `./cancel.ts`: `uncancel:` undoes what that file did, and
 * has to render the banner and word the DM identically or the two flows drift.
 */
import { MessageFlags, TimestampStyles, escapeMarkdown, time } from 'discord.js';
import type { ChatInputCommandInteraction, SlashCommandSubcommandBuilder } from 'discord.js';
import { rebuildDigest } from '../digest.ts';
import { displayTitle, ensureOpen, notifyRecipients, rsvpRow, toEmbed } from '../event.ts';
import type { Ctx } from '../types/config.ts';
import { cancelledBanner, deliveryNotes, notifyAttendees } from './cancel.ts';
import { content, ephemeral, parseWhen, resolveEvent } from './shared.ts';

export const editSubcommand = (sub: SlashCommandSubcommandBuilder) =>
  sub
    .setName('edit')
    .setDescription("Edit this event (run inside the event's thread)")
    .addStringOption((o) => o.setName('title').setDescription('New name').setMaxLength(100))
    .addStringOption((o) =>
      o
        .setName('when')
        .setDescription('New start time — try "friday 7pm" or "Aug 15 7:30 PM"')
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
    );

export async function handleEdit(interaction: ChatInputCommandInteraction, ctx: Ctx) {
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

  if (!uncancel) {
    // Only when the time moved: the same per-viewer echo create does, for the same reason — this
    // is the one command that can silently reschedule an event into the wrong zone. Left off the
    // other fields, where a timestamp nobody changed reads as if something had.
    return interaction.editReply(
      content(
        when
          ? `Updated — now starts ${time(event.startsAt, TimestampStyles.FullDateShortTime)} ` +
            `(${time(event.startsAt, TimestampStyles.RelativeTime)}).`
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
