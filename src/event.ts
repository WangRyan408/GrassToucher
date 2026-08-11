import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  TimestampStyles,
  time,
} from 'discord.js';
import type { APIEmbed, Embed, ForumChannel, Message, ThreadChannel } from 'discord.js';
import type { Event, EventEntry, RsvpChoice } from './types.ts';
import { tryCatch } from './utils/tryCatch.ts';

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

interface ChoiceMeta {
  emoji: string;
  label: string;
  style: ButtonStyle;
}

/** Typed as a full Record, so a new RsvpChoice can't be added without a button for it. */
export const CHOICES: Record<RsvpChoice, ChoiceMeta> = {
  going: { emoji: '✅', label: 'Going', style: ButtonStyle.Success },
  maybe: { emoji: '🤔', label: 'Maybe', style: ButtonStyle.Secondary },
  no: { emoji: '❌', label: "Can't", style: ButtonStyle.Secondary },
};

/** `Object.entries` widens the key to `string`; the three loops below need it kept. */
const choiceEntries = Object.entries(CHOICES) as [RsvpChoice, ChoiceMeta][];

export const RSVP_PREFIX = 'rsvp';

export function rsvpRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...choiceEntries.map(([key, c]) =>
      new ButtonBuilder()
        .setCustomId(`${RSVP_PREFIX}:${key}`)
        .setLabel(c.label)
        .setEmoji(c.emoji)
        .setStyle(c.style),
    ),
  );
}

const mentions = (ids: string[]) => (ids.length ? ids.map((id) => `<@${id}>`).join(' ') : '—');
const readIds = (value: string) => [...value.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);

/**
 * The one place the embed colour is decided, so the sweep can ask "does this need a
 * re-render?" without duplicating the rule and looping forever when it guesses wrong.
 */
export function embedColor(event: Event): number {
  if (event.cancelled) return COLOR_CANCELLED; // Outranks past-grey.
  return new Date(event.startsAt).getTime() < Date.now() ? COLOR_PAST : COLOR_UPCOMING;
}

/** Title as shown in the embed and thread name. Truncates the title, never the marker. */
export function displayTitle(event: Event, cap: number): string {
  if (!event.cancelled) return event.title.slice(0, cap);
  return event.title.slice(0, cap - CANCELLED_SUFFIX.length) + CANCELLED_SUFFIX;
}

/**
 * Who hears about a change of plan: everyone who might turn up, minus whoever made it.
 * The same audience both ways — anyone told an event was off has to be told it's back on.
 */
export function notifyRecipients(event: Event, actorId: string): string[] {
  const ids = new Set([...event.rsvp.going, ...event.rsvp.maybe]);
  if (event.organizerId) ids.add(event.organizerId); // Absent when the footer was unreadable.
  ids.delete(actorId);
  return [...ids];
}

/** Build the starter-message embed that stores the event. */
export function toEmbed(event: Event): EmbedBuilder {
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
    ...choiceEntries.map(([key, c]) => ({
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
 * JSON from `EmbedBuilder#toJSON()` — the property names line up, which is why `fields` is
 * annotated structurally rather than with either library type.
 */
export function fromEmbed(embed: Embed | APIEmbed): Event {
  const fields: readonly { name: string; value: string }[] = embed.fields ?? [];
  const footer = embed.footer?.text ?? '';
  const byEmoji = (emoji: string) => fields.find((f) => f.name.startsWith(emoji))?.value ?? '';

  // Undo displayTitle. Skip this and every re-render appends another marker.
  const cancelled = footer.includes('cancelled');
  let title = embed.title ?? '(untitled)';
  if (cancelled && title.endsWith(CANCELLED_SUFFIX)) {
    title = title.slice(0, -CANCELLED_SUFFIX.length);
  }

  return {
    title,
    description: embed.description ?? null,
    // `?? 0` is what `new Date(null)` already did: epoch, not Invalid Date.
    startsAt: new Date(embed.timestamp ?? 0),
    where: fields.find((f) => f.name === 'Where')?.value ?? null,
    organizerId: /org:(\d+)/.exec(footer)?.[1] ?? null,
    reminded: footer.includes('reminded'),
    cancelled,
    // Spelled out rather than looped: `rsvp` must be a complete Rsvp, so adding a fourth
    // choice fails here at compile time instead of producing a half-filled record.
    rsvp: {
      going: readIds(byEmoji(CHOICES.going.emoji)),
      maybe: readIds(byEmoji(CHOICES.maybe.emoji)),
      no: readIds(byEmoji(CHOICES.no.emoji)),
    },
  };
}

/** A predicate, so callers that pass a possibly-null message get it narrowed for free. */
export function isOurs(message: Message | null | undefined, clientUserId: string): message is Message {
  return (
    message?.author?.id === clientUserId && !!message.embeds?.[0]?.footer?.text?.startsWith(MARKER)
  );
}

/**
 * Move `userId` to `choice`. Clicking the list they're already on does nothing: a button
 * that quietly drops your RSVP on a second click loses answers to stray double-clicks, and
 * "Can't" is already the way to say you're not coming.
 *
 * Mutates `event.rsvp`.
 */
export function applyRsvp(
  event: Event,
  userId: string,
  choice: RsvpChoice,
): 'added' | 'moved' | 'unchanged' | 'full' {
  const keys = Object.keys(event.rsvp) as RsvpChoice[];
  const current = keys.find((key) => event.rsvp[key].includes(userId));
  if (current === choice) return 'unchanged';
  // Only reachable when the answer is really changing, so their own slot can't count
  // against them on a list that's already full.
  if (event.rsvp[choice].length >= MAX_PER_LIST) return 'full';

  for (const key of keys) {
    event.rsvp[key] = event.rsvp[key].filter((id) => id !== userId);
  }
  event.rsvp[choice].push(userId);
  return current ? 'moved' : 'added';
}

/**
 * Discord rejects sends, edits and interaction updates in an archived thread. Since we
 * deliberately keep archived posts in the digest, people do click RSVP on them.
 */
export async function ensureOpen(thread: ThreadChannel): Promise<void> {
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
export async function readEvent(
  thread: ThreadChannel,
  clientUserId: string,
): Promise<EventEntry | null> {
  const { data: message, error } = await tryCatch(thread.fetchStarterMessage({ force: true }));
  if (error) return null; // Starter message deleted.
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
export async function listEvents(
  forum: ForumChannel,
  clientUserId: string,
): Promise<EventEntry[]> {
  const [active, archived] = await Promise.all([
    forum.threads.fetchActive(),
    forum.threads.fetchArchived({ limit: 100 }),
  ]);

  const threads = [...active.threads.values(), ...archived.threads.values()];
  const entries = await Promise.all(threads.map((thread) => readEvent(thread, clientUserId)));

  return entries
    .filter((entry) => entry !== null)
    .sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime());
}
