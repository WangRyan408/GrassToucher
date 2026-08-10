import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TimestampStyles,
  time,
} from 'discord.js';

/** Footer prefix marking a message as one of ours. */
export const MARKER = 'GrassToucher';

export const COLOR_UPCOMING = 0x57f287;
export const COLOR_PAST = 0x4f545c;
export const COLOR_CANCELLED = 0xed4245;

/** Appended to the embed title and thread name. Presentation only — the footer is the truth. */
export const CANCELLED_SUFFIX = ' — CANCELLED';

/**
 * ponytail: attendee lists live in embed fields, which cap at 1024 chars — about 44
 * mentions. We refuse the 41st RSVP rather than silently dropping names. Upgrade path:
 * spill into "(cont.)" fields, or move attendees to SQLite if you need real reporting.
 */
export const MAX_PER_LIST = 40;

export const CHOICES = {
  going: { emoji: '✅', label: 'Going', style: ButtonStyle.Success },
  maybe: { emoji: '🤔', label: 'Maybe', style: ButtonStyle.Secondary },
  no: { emoji: '❌', label: "Can't", style: ButtonStyle.Secondary },
};

export const RSVP_PREFIX = 'rsvp';

export function rsvpRow() {
  return new ActionRowBuilder().addComponents(
    ...Object.entries(CHOICES).map(([key, c]) =>
      new ButtonBuilder()
        .setCustomId(`${RSVP_PREFIX}:${key}`)
        .setLabel(c.label)
        .setEmoji(c.emoji)
        .setStyle(c.style),
    ),
  );
}

const mentions = (ids) => (ids.length ? ids.map((id) => `<@${id}>`).join(' ') : '—');
const readIds = (value) => [...value.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);

/**
 * The one place the embed colour is decided, so the sweep can ask "does this need a
 * re-render?" without duplicating the rule and looping forever when it guesses wrong.
 */
export function embedColor(event) {
  if (event.cancelled) return COLOR_CANCELLED; // Outranks past-grey.
  return new Date(event.startsAt).getTime() < Date.now() ? COLOR_PAST : COLOR_UPCOMING;
}

/** Title as shown in the embed and thread name. Truncates the title, never the marker. */
export function displayTitle(event, cap) {
  if (!event.cancelled) return event.title.slice(0, cap);
  return event.title.slice(0, cap - CANCELLED_SUFFIX.length) + CANCELLED_SUFFIX;
}

/** Who hears about a cancellation: everyone who might turn up, minus whoever cancelled it. */
export function cancelRecipients(event, actorId) {
  const ids = new Set([...event.rsvp.going, ...event.rsvp.maybe, event.organizerId]);
  ids.delete(actorId);
  ids.delete(null);
  return [...ids];
}

/** Build the starter-message embed that stores the event. */
export function toEmbed(event) {
  const startsAt = new Date(event.startsAt);

  const embed = new EmbedBuilder()
    .setTitle(displayTitle(event, 256))
    .setColor(embedColor(event))
    .setTimestamp(startsAt)
    .addFields({
      name: 'When',
      value: `${time(startsAt, TimestampStyles.LongDateTime)} (${time(startsAt, TimestampStyles.RelativeTime)})`,
    });

  if (event.description) embed.setDescription(event.description.slice(0, 4000));
  if (event.where) embed.addFields({ name: 'Where', value: event.where.slice(0, 1024) });

  embed.addFields(
    ...Object.entries(CHOICES).map(([key, c]) => ({
      name: `${c.emoji} ${c.label} (${event.rsvp[key].length})`,
      value: mentions(event.rsvp[key]),
      inline: true,
    })),
  );

  const footer = [MARKER, `org:${event.organizerId}`];
  if (event.reminded) footer.push('reminded');
  if (event.cancelled) footer.push('cancelled');
  return embed.setFooter({ text: footer.join(' · ') });
}

/**
 * Read an event back out of its embed. Accepts either a discord.js `Embed` or the plain
 * JSON from `EmbedBuilder#toJSON()` — the property names line up.
 */
export function fromEmbed(embed) {
  const fields = embed.fields ?? [];
  const footer = embed.footer?.text ?? '';
  const byEmoji = (emoji) => fields.find((f) => f.name.startsWith(emoji))?.value ?? '';

  // Undo displayTitle. Skip this and every re-render appends another marker.
  const cancelled = footer.includes('cancelled');
  let title = embed.title ?? '(untitled)';
  if (cancelled && title.endsWith(CANCELLED_SUFFIX)) {
    title = title.slice(0, -CANCELLED_SUFFIX.length);
  }

  return {
    title,
    description: embed.description ?? null,
    startsAt: new Date(embed.timestamp),
    where: fields.find((f) => f.name === 'Where')?.value ?? null,
    organizerId: /org:(\d+)/.exec(footer)?.[1] ?? null,
    reminded: footer.includes('reminded'),
    cancelled,
    rsvp: Object.fromEntries(
      Object.entries(CHOICES).map(([key, c]) => [key, readIds(byEmoji(c.emoji))]),
    ),
  };
}

export function isOurs(message, clientUserId) {
  return (
    message?.author?.id === clientUserId && !!message.embeds?.[0]?.footer?.text?.startsWith(MARKER)
  );
}

/**
 * Move `userId` to `choice`, or off every list if they were already there.
 * Mutates `event.rsvp`. Returns 'added' | 'moved' | 'withdrawn' | 'full'.
 */
export function applyRsvp(event, userId, choice) {
  const current = Object.keys(event.rsvp).find((key) => event.rsvp[key].includes(userId));
  if (current !== choice && event.rsvp[choice].length >= MAX_PER_LIST) return 'full';

  for (const key of Object.keys(event.rsvp)) {
    event.rsvp[key] = event.rsvp[key].filter((id) => id !== userId);
  }
  if (current === choice) return 'withdrawn';

  event.rsvp[choice].push(userId);
  return current ? 'moved' : 'added';
}

/**
 * Discord rejects sends, edits and interaction updates in an archived thread. Since we
 * deliberately keep archived posts in the digest, people do click RSVP on them.
 */
export async function ensureOpen(thread) {
  if (thread.archived) await thread.setArchived(false, 'GrassToucher update');
}

/**
 * Read the event stored in a forum post, or null if it isn't one of ours.
 *
 * `force` skips the message cache on purpose: a digest rebuild fires immediately after an
 * RSVP edit, and a cached copy would still hold the pre-click counts.
 *
 * ponytail: that's one REST call per event per rebuild. Fine at forum scale; cache with
 * manual invalidation if rate-limit headroom ever gets tight.
 */
export async function readEvent(thread, clientUserId) {
  let message;
  try {
    message = await thread.fetchStarterMessage({ force: true });
  } catch {
    return null; // Starter message deleted.
  }
  if (!isOurs(message, clientUserId)) return null;
  return { thread, message, event: fromEmbed(message.embeds[0]) };
}

/**
 * Every event in the forum, soonest first.
 *
 * Archived posts are included on purpose: forum posts auto-archive after inactivity, so
 * an upcoming event nobody chats in would otherwise vanish from the digest.
 *
 * ponytail: only the 100 most recently archived posts are checked. Paginate with
 * `before` if a forum ever accumulates enough old posts to hide a future event.
 */
export async function listEvents(forum, clientUserId) {
  const [active, archived] = await Promise.all([
    forum.threads.fetchActive(),
    forum.threads.fetchArchived({ limit: 100 }),
  ]);

  const threads = [...active.threads.values(), ...archived.threads.values()];
  const entries = await Promise.all(threads.map((thread) => readEvent(thread, clientUserId)));

  return entries.filter(Boolean).sort((a, b) => a.event.startsAt - b.event.startsAt);
}
