/**
 * `/event cancel` — the confirm button, the CANCELLED post, and the DMs that go with it.
 *
 * The button handler lives here rather than with the router because it is the second half of
 * this one command: it re-runs the same authorization and writes the same banner.
 *
 * `edit.ts` imports the three notification helpers below, which is the honest shape of
 * un-cancelling — it undoes what this file did, and has to word the DM the same way.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  TimestampStyles,
  escapeMarkdown,
  time,
} from 'discord.js';
import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandSubcommandBuilder,
  ThreadChannel,
  User,
} from 'discord.js';
import { rebuildDigest } from '../digest.ts';
import { displayTitle, ensureOpen, notifyRecipients, toEmbed } from '../event.ts';
import type { Ctx } from '../types/config.ts';
import type { Event } from '../types/event.ts';
import { tryCatch } from '../utils/tryCatch.ts';
import { ephemeral, resolveEvent } from './shared.ts';

/** The confirm button's custom id. `route` matches on it, so it is exported, not local. */
export const CANCEL_ID = 'cancel';

export const cancelSubcommand = (sub: SlashCommandSubcommandBuilder) =>
  sub.setName('cancel').setDescription("Cancel this event (run inside the event's thread)");

/** The only place in a forum post where strikethrough actually renders. */
export const cancelledBanner = (event: Event) => `~~${escapeMarkdown(event.title)}~~ **CANCELLED**`;

/**
 * DM everyone who might have turned up, either way the plan changed. Best effort on
 * purpose: a member with server DMs switched off answers 50007, and one closed inbox must
 * not stop the rest — which is what `tryCatch` buys here: none of these ever reject, so the
 * `Promise.all` can't short-circuit on the first closed inbox.
 *
 * ponytail: one REST call per recipient. MAX_PER_LIST caps this near 80; batch only if it
 * ever costs real rate-limit headroom.
 */
export async function notifyAttendees(
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
export function deliveryNotes(lead: string, { sent, failed }: { sent: number; failed: number }) {
  const notes = [lead];
  if (sent) notes.push(`Notified ${sent}.`);
  if (failed) notes.push(`${failed} couldn't be DMed — their DMs are closed.`);
  return notes.join(' ');
}

export async function handleCancel(interaction: ChatInputCommandInteraction, ctx: Ctx) {
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

export async function handleCancelConfirm(interaction: ButtonInteraction, ctx: Ctx) {
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
