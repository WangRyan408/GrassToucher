/**
 * The event record, and the RSVP shapes it contains.
 *
 * `src/event.ts` is the codec for these. Keeping the shape apart from it is what lets the digest,
 * the sweep and every command name an `Event` without importing the module that renders one.
 */
import type { Message, ThreadChannel } from 'discord.js';
import type { Recurrence } from './recurrence.ts';

export type RsvpChoice = 'going' | 'maybe' | 'no';

export type Rsvp = Record<RsvpChoice, string[]>;

/**
 * One event, as stored in its forum post's embed. This is the record — `fromEmbed` produces
 * it, `toEmbed` renders it, and the digest, the sweep and every handler read it.
 *
 * `organizerId` is nullable because it's parsed out of the footer, and a footer we can't
 * read is still an event we have to render.
 * `startsAt` is null for an explicit TBD date, which has no instant to remind or archive against.
 * A pause stores a deadline so it can expire after a restart without a process-local timer.
 */
export interface Event {
  title: string;
  description: string | null;
  startsAt: Date | null;
  where: string | null;
  organizerId: string | null;
  reminded: boolean;
  cancelled: boolean;
  recurring: Recurrence | null;
  pausedUntil: Date | null;
  rsvp: Rsvp;
}

/** An event plus the two Discord objects you need to change it. */
export interface EventEntry {
  thread: ThreadChannel;
  message: Message;
  event: Event;
}
