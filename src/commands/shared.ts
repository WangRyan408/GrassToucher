/**
 * What more than one subcommand needs.
 *
 * It lives here rather than in interactions.ts because that file imports every command in
 * order to assemble `/event` — a command reaching back into it for `ephemeral` would close an
 * import cycle, and these are `const` arrow functions, which a cycle can catch in their
 * temporal dead zone rather than merely hoisting past.
 */
import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import { readEvent } from '../event.ts';
import { TIME_FORMAT, resolveTimeZone, searchTimeZones, zonedToDate } from '../time.ts';
import type { Ctx, EventEntry } from '../types.ts';

// `as const` pins the flag to the one enum member: without it the type widens to the whole
// MessageFlags enum, and reply() only accepts the handful of flags it can actually set.
export const ephemeral = (text: string) => ({ content: text, flags: MessageFlags.Ephemeral as const });
// editReply can't change ephemerality — deferReply already set it.
export const content = (text: string) => ({ content: text });

/**
 * Resolve the `when` + `timezone` options into a Date, or return the complaint to show.
 *
 * A bare string for the failure, not `{ error }`: `if (typeof x === 'string')` narrows, while
 * `if (x.error)` can't rule out the failure arm — an empty error string is falsy too.
 */
export function parseWhen(
  interaction: ChatInputCommandInteraction,
  ctx: Ctx,
): { startsAt: Date; tz: string } | string {
  const raw = interaction.options.getString('when');
  // `|| null`, not `?? null`: someone can leave a space in the box, and a blank zone means
  // "use the default" rather than "reject this".
  const requested = interaction.options.getString('timezone')?.trim() || null;
  const tz = requested ? resolveTimeZone(requested) : ctx.config.defaultTz;

  if (!tz) {
    // Several zones matched, or none did. Either way the suggestions are the way out, so the
    // complaint leads with the nearest few.
    const near = searchTimeZones(requested, ctx.config.defaultTz)
      .slice(0, 3)
      .map((choice) => `\`${choice.value}\``)
      .join(', ');
    return near
      ? `\`${requested}\` matches more than one timezone. Did you mean ${near}? Pick one from the list as you type.`
      : `\`${requested}\` isn't a timezone I recognise. Try a city like \`Berlin\` and pick from the list as you type.`;
  }
  const startsAt = zonedToDate(raw, tz);
  if (!startsAt) {
    return `Couldn't read \`${raw}\` as a time. Use \`${TIME_FORMAT}\` on a 24-hour clock, e.g. \`2026-08-15 19:30\`. (A time skipped by a daylight-saving jump won't work either.)`;
  }
  return { startsAt, tz };
}

/**
 * The guard both in-thread commands share: is this one of our events, and may this person
 * act on it? Kept in one place so edit and cancel can't drift on who's allowed to do what.
 *
 * Returns the entry, or the complaint to show — same reason as `parseWhen`. The thread comes
 * off the interaction rather than being passed in: every caller passed `interaction.channel`.
 */
export async function resolveEvent(
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
