import { EmbedBuilder, TimestampStyles, time } from 'discord.js';
import { CHOICES, COLOR_UPCOMING, MARKER, listEvents } from './event.js';

/** ponytail: one embed holds 4096 description chars. Past ~25 events, paginate or split. */
const MAX_LINES = 25;

const DIGEST_FOOTER = `${MARKER} · digest`;

function isDigest(message, clientUserId) {
  return message?.author?.id === clientUserId && message.embeds?.[0]?.footer?.text === DIGEST_FOOTER;
}

export function renderDigest(entries) {
  const embed = new EmbedBuilder()
    .setTitle('📅 Upcoming Events')
    .setColor(COLOR_UPCOMING)
    .setFooter({ text: DIGEST_FOOTER })
    .setTimestamp(new Date());

  if (!entries.length) {
    return embed.setDescription('Nothing scheduled yet. Use `/event create` to add an event.');
  }

  const lines = entries.slice(0, MAX_LINES).map(({ thread, event }) => {
    const bits = [
      `${time(event.startsAt, TimestampStyles.LongDateTime)} (${time(event.startsAt, TimestampStyles.RelativeTime)})`,
      `${CHOICES.going.emoji} ${event.rsvp.going.length}`,
    ];
    if (event.where) bits.push(`📍 ${event.where}`);
    // Brackets in a title would break out of the markdown link.
    const label = event.title.replaceAll('[', '(').replaceAll(']', ')');
    return `**[${label}](${thread.url})**\n${bits.join(' · ')}`;
  });

  const hidden = entries.length - lines.length;
  if (hidden > 0) lines.push(`…and ${hidden} more in the forum.`);

  return embed.setDescription(lines.join('\n\n').slice(0, 4096));
}

/**
 * Edit the bot's pinned digest in place, or post and pin it if there isn't one.
 * The pin *is* the lookup key, so no message id is stored anywhere and a restart or
 * redeploy picks the same message back up.
 */
export async function upsertDigest(channel, entries) {
  const embed = renderDigest(entries);
  const { items } = await channel.messages.fetchPins();
  const existing = items.map((pin) => pin.message).find((m) => isDigest(m, channel.client.user.id));

  if (existing) return existing.edit({ embeds: [embed] });

  const sent = await channel.send({ embeds: [embed] });
  await sent.pin();
  return sent;
}

/**
 * The single path every mutation and the sweep goes through, so the digest can never
 * drift from the forum. Returns every event found, including finished ones, so callers
 * don't need a second round of fetches.
 */
export async function rebuildDigest(ctx) {
  const entries = await listEvents(ctx.forum, ctx.client.user.id);
  const cutoff = Date.now() - ctx.config.archiveGraceHours * 3_600_000;
  const active = entries.filter(({ event }) => event.startsAt.getTime() > cutoff);

  await upsertDigest(ctx.digestChannel, active);
  return entries;
}
