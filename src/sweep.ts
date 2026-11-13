import { TimestampStyles, time } from 'discord.js';
import { updateDigest } from './digest.ts';
import { embedColor, ensureOpen, isPaused, listEvents, threadName, toEmbed } from './event.ts';
import { nextOccurrence } from './recurrence.ts';
import type { Ctx } from './types/config.ts';

/**
 * Ping attendees shortly before start, tidy up finished events, then refresh the digest.
 *
 * Reminders are idempotent through the `reminded` marker in the embed footer, and the
 * lower time bound means a bot that was offline through the window stays quiet rather
 * than announcing an event that already started.
 *
 * The dot and the embed colour are one fact rendered twice, so they have to move together.
 * One-off posts go grey when they start; recurring posts stay green between dates unless paused.
 */
export async function sweep(ctx: Ctx) {
  const entries = await listEvents(ctx.forum, ctx.client.user.id);
  const now = Date.now();
  const reminderMs = ctx.config.reminderMinutes * 60_000;
  const graceMs = ctx.config.archiveGraceHours * 3_600_000;

  for (const { thread, message, event } of entries) {
    const pauseExpired = event.pausedUntil !== null && event.pausedUntil.getTime() <= now;
    if (pauseExpired) event.pausedUntil = null;
    let changed = pauseExpired;
    if (event.recurring && !event.cancelled && !isPaused(event) &&
      event.startsAt && event.startsAt.getTime() <= now) {
      const next = nextOccurrence(event.recurring, new Date(now));
      if (next) {
        // Catch up in one edit; missed occurrences must not produce a burst of old reminders.
        await ensureOpen(thread);
        event.startsAt = next;
        event.reminded = false;
        changed = true;
      }
    }
    const untilStart = event.startsAt ? event.startsAt.getTime() - now : null;

    if (
      event.startsAt && untilStart !== null && !event.cancelled && !isPaused(event) && !event.reminded &&
      untilStart >= 0 && untilStart <= reminderMs
    ) {
      await ensureOpen(thread);
      const invitees = [...event.rsvp.going, ...event.rsvp.maybe];
      const who = invitees.length ? invitees.map((id) => `<@${id}>`).join(' ') : '';
      const when = time(event.startsAt, TimestampStyles.RelativeTime);
      await thread.send(`**${event.title}** starts ${when}. ${who}`.trim());
      event.reminded = true;
      changed = true;
    }

    // Both renderings of the state, checked together so the post can't contradict itself.
    // Only while it's open, and before the archive step: renaming an archived thread reopens
    // it, so a sweep that "fixed" a dot on an archived post would undo the archiving below and
    // fight itself every ten minutes. An archived post keeps the dot it went in with — which
    // is the one this block set on the way out, since a post is still open when it gets here.
    if (!thread.archived) {
      // Compare against what toEmbed and threadName would pick, not fixed constants: a
      // cancelled event stays red forever, and a mismatched test here re-renders every sweep.
      if (changed || message.embeds[0]?.color !== embedColor(event)) {
        await message.edit({ embeds: [toEmbed(event)] }); // Re-renders grey now it's past.
      }
      const name = threadName(event);
      if (thread.name !== name) await thread.setName(name);
    }

    // Recurring and TBD events do not finish at one start time. Discord's inactivity archive still applies.
    if (!event.recurring && !isPaused(event) && untilStart !== null && untilStart < -graceMs && !thread.archived) {
      await thread.setArchived(true, 'Event finished');
    }
  }
  await updateDigest(ctx, entries);
}
