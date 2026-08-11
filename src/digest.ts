import { EmbedBuilder, TimestampStyles, time } from 'discord.js';
import type { GuildTextBasedChannel, Message } from 'discord.js';
import { CHOICES, COLOR_UPCOMING, MARKER, listEvents } from './event.ts';
import type { Ctx, EventEntry } from './types.ts';
import { tryCatch } from './utils/tryCatch.ts';

/** ponytail: one embed holds 4096 description chars. Past ~25 events, paginate or split. */
const MAX_LINES = 25;

const DIGEST_FOOTER = `${MARKER} · digest`;

function isDigest(message: Message | null | undefined, clientUserId: string): boolean {
  return message?.author?.id === clientUserId && message.embeds?.[0]?.footer?.text === DIGEST_FOOTER;
}

export function renderDigest(entries: EventEntry[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('📅 Upcoming Events')
    .setColor(COLOR_UPCOMING)
    .setFooter({ text: DIGEST_FOOTER })
    .setTimestamp(new Date());

  if (!entries.length) {
    return embed.setDescription('Nothing scheduled yet. Use `/event create` to add an event.');
  }

  const lines = entries.slice(0, MAX_LINES).map(({ thread, event }) => {
    const when = `${time(event.startsAt, TimestampStyles.LongDateTime)} (${time(event.startsAt, TimestampStyles.RelativeTime)})`;
    // Brackets in a title would break out of the markdown link.
    const label = event.title.replaceAll('[', '(').replaceAll(']', ')');
    const link = `[${label}](${thread.url})`;

    // An embed description is one of the few places strikethrough actually renders, so
    // this is where a cancellation reads as one. RSVP count and location are moot now.
    if (event.cancelled) return `~~**${link}**~~ **CANCELLED**\n${when}`;

    const bits = [when, `${CHOICES.going.emoji} ${event.rsvp.going.length}`];
    if (event.where) bits.push(`📍 ${event.where}`);
    return `**${link}**\n${bits.join(' · ')}`;
  });

  const hidden = entries.length - lines.length;
  if (hidden > 0) lines.push(`…and ${hidden} more in the forum.`);

  return embed.setDescription(lines.join('\n\n').slice(0, 4096));
}

async function pinQuietly(message: Message): Promise<void> {
  if (message.pinned) return;

  const { error } = await tryCatch(message.pin());
  if (error) {
    console.error(
      `Could not pin the digest (${error.message}). Grant the bot Pin Messages in ` +
        'that channel — Manage Messages is not enough, Discord split pinning into its own ' +
        'permission. The digest still updates in place meanwhile.',
    );
  }
}

/**
 * Edit the bot's digest in place, or post one if it doesn't exist yet.
 *
 * The pin is the lookup key, so no message id is stored anywhere and a restart picks the
 * same message back up. The recent-message fallback matters because that key can go away:
 * a moderator unpins it, or the bot lacks Pin Messages. Without the fallback, a digest
 * we can't find is a digest we post again on every single sweep.
 *
 * `clientUserId` is passed in rather than read off `channel.client`, which is only typed as
 * possibly-logged-in. Same reason `listEvents` takes it.
 */
export async function upsertDigest(
  channel: GuildTextBasedChannel,
  entries: EventEntry[],
  clientUserId: string,
): Promise<Message> {
  const embed = renderDigest(entries);

  const { items } = await channel.messages.fetchPins();
  let existing = items.map((pin) => pin.message).find((m) => isDigest(m, clientUserId));

  if (!existing) {
    const recent = await channel.messages.fetch({ limit: 50 });
    existing = recent.find((m) => isDigest(m, clientUserId));
  }

  if (existing) {
    await existing.edit({ embeds: [embed] });
    await pinQuietly(existing);
    return existing;
  }

  const sent = await channel.send({ embeds: [embed] });
  await pinQuietly(sent);
  return sent;
}

/**
 * The single path every mutation and the sweep goes through, so the digest can never
 * drift from the forum. Returns every event found, including finished ones, so callers
 * don't need a second round of fetches.
 */
export async function rebuildDigest(ctx: Ctx): Promise<EventEntry[]> {
  const entries = await listEvents(ctx.forum, ctx.client.user.id);
  const cutoff = Date.now() - ctx.config.archiveGraceHours * 3_600_000;
  const active = entries.filter(({ event }) => event.startsAt.getTime() > cutoff);

  await upsertDigest(ctx.digestChannel, active, ctx.client.user.id);
  return entries;
}
