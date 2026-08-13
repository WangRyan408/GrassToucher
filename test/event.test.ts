import { expect, test } from 'vitest';
import {
  CANCELLED_SUFFIX,
  COLOR_CANCELLED,
  COLOR_UPCOMING,
  MAX_PER_LIST,
  applyRsvp,
  displayTitle,
  embedColor,
  fromEmbed,
  notifyRecipients,
  toEmbed,
} from '../src/event.ts';
import type { Event } from '../src/types/event.ts';

/** Annotated `Event`, so the fixture is checked against the real record, not just itself. */
const sample = (over: Partial<Event> = {}): Event => ({
  title: 'Touch Grass',
  description: 'Outside. The big room.',
  where: 'Dolores Park',
  startsAt: new Date('2026-08-15T17:30:00.000Z'),
  organizerId: '111111111111111111',
  reminded: false,
  cancelled: false,
  rsvp: { going: ['111111111111111111', '222222222222222222'], maybe: ['333333333333333333'], no: [] },
  ...over,
});

/** The embed is the datastore, so a lossy round-trip means silent data loss. */
const roundTrip = (event: Event) => fromEmbed(toEmbed(event).toJSON());

test('survives a round-trip through the embed', () => {
  const event = sample();
  expect(roundTrip(event)).toStrictEqual(event);
});

test('carries the reminded marker without disturbing the organizer id', () => {
  const event = sample({ reminded: true });
  const back = roundTrip(event);
  expect(back.reminded).toBe(true);
  expect(back.organizerId).toBe(event.organizerId);
});

test('round-trips events with optional fields missing', () => {
  const event = sample({ description: null, where: null, rsvp: { going: [], maybe: [], no: [] } });
  expect(roundTrip(event)).toStrictEqual(event);
});

test('an empty list stays empty rather than picking up the placeholder', () => {
  const back = roundTrip(sample({ rsvp: { going: [], maybe: [], no: [] } }));
  expect(back.rsvp).toStrictEqual({ going: [], maybe: [], no: [] });
});

test('a full list of attendees still round-trips inside the field limit', () => {
  const going = Array.from({ length: MAX_PER_LIST }, (_, i) => String(100000000000000000n + BigInt(i)));
  const embed = toEmbed(sample({ rsvp: { going, maybe: [], no: [] } })).toJSON();
  // A missing field leaves `undefined` here, which toBeLessThanOrEqual rejects — so this
  // still fails loudly rather than passing vacuously.
  const field = embed.fields?.find((f) => f.name.startsWith('✅'));

  expect(field?.value.length, `field was ${field?.value.length} chars`).toBeLessThanOrEqual(1024);
  expect(fromEmbed(embed).rsvp.going).toStrictEqual(going);
});

test('a cancelled event round-trips with a clean title', () => {
  const event = sample({ cancelled: true });
  const rendered = toEmbed(event).toJSON();

  expect(rendered.title?.endsWith(CANCELLED_SUFFIX), rendered.title).toBe(true);
  expect(rendered.color).toBe(COLOR_CANCELLED);
  expect(roundTrip(event)).toStrictEqual(event); // Title comes back without the marker.
});

test('re-rendering a cancelled event does not stack the marker', () => {
  const once = toEmbed(sample({ cancelled: true })).toJSON();
  const twice = toEmbed(fromEmbed(once)).toJSON();

  expect(twice.title).toBe(once.title);
  expect(twice.title?.match(/CANCELLED/g)).toHaveLength(1);
});

test('un-cancelling leaves no trace of the cancellation', () => {
  // What /event edit uncancel does: read the post back, clear the flag, re-render.
  const cancelled = fromEmbed(toEmbed(sample({ cancelled: true })).toJSON());
  const back = toEmbed({ ...cancelled, cancelled: false }).toJSON();

  expect(back.title).toBe('Touch Grass');
  expect(back.footer?.text.includes('cancelled'), back.footer?.text).toBe(false);
  expect(back.color).toBe(COLOR_UPCOMING);
  expect(displayTitle({ ...cancelled, cancelled: false }, 100)).toBe('Touch Grass');
});

test('cancelled outranks past when picking the colour', () => {
  const past = new Date('2020-01-01T00:00:00.000Z');
  expect(embedColor(sample({ startsAt: past, cancelled: true }))).toBe(COLOR_CANCELLED);
});

test('displayTitle truncates the title, never the marker', () => {
  const long = 'g'.repeat(100);
  const shown = displayTitle(sample({ title: long, cancelled: true }), 100);

  expect(shown.length).toBe(100);
  expect(shown.endsWith(CANCELLED_SUFFIX), shown).toBe(true);
});

test('notifies everyone who might turn up, except whoever changed the plan', () => {
  const event = sample({
    organizerId: 'organizer',
    rsvp: { going: ['organizer', 'goer'], maybe: ['maybe'], no: ['declined'] },
  });

  expect(notifyRecipients(event, 'organizer')).toStrictEqual(['goer', 'maybe']);
  // A mod cancelling someone else's event still tells the organizer, exactly once.
  expect(notifyRecipients(event, 'mod')).toStrictEqual(['organizer', 'goer', 'maybe']);
});

test('recipients survive an event with no organizer in the footer', () => {
  const event = sample({ organizerId: null, rsvp: { going: ['goer'], maybe: [], no: [] } });
  expect(notifyRecipients(event, 'mod')).toStrictEqual(['goer']);
});

test('rsvp adds and moves', () => {
  const event = sample({ rsvp: { going: [], maybe: [], no: [] } });

  expect(applyRsvp(event, 'u1', 'going')).toBe('added');
  expect(event.rsvp.going).toStrictEqual(['u1']);

  expect(applyRsvp(event, 'u1', 'maybe')).toBe('moved');
  expect(event.rsvp).toStrictEqual({ going: [], maybe: ['u1'], no: [] });
});

test('re-picking the same answer is a no-op, not a withdrawal', () => {
  for (const choice of ['going', 'maybe', 'no'] as const) {
    const event = sample({ rsvp: { going: [], maybe: [], no: [] } });
    applyRsvp(event, 'u1', choice);

    // The click that used to silently drop them off the list.
    expect(applyRsvp(event, 'u1', choice), choice).toBe('unchanged');
    expect(event.rsvp[choice], `${choice} kept its member`).toStrictEqual(['u1']);
  }
});

test('a user never appears on two lists at once', () => {
  const event = sample({ rsvp: { going: ['u1'], maybe: ['u1'], no: [] } });
  applyRsvp(event, 'u1', 'no');
  expect(event.rsvp).toStrictEqual({ going: [], maybe: [], no: ['u1'] });
});

test('refuses to overflow a list instead of dropping names', () => {
  const going = Array.from({ length: MAX_PER_LIST }, (_, i) => `u${i}`);
  const event = sample({ rsvp: { going, maybe: [], no: [] } });

  expect(applyRsvp(event, 'late', 'going')).toBe('full');
  expect(event.rsvp.going.length, 'nobody was evicted').toBe(MAX_PER_LIST);
  expect(event.rsvp.going).not.toContain('late');

  // A full Going list must not block the other lists.
  expect(applyRsvp(event, 'late', 'maybe')).toBe('added');
});

test('someone already on a full list is not told it is full', () => {
  const going = Array.from({ length: MAX_PER_LIST }, (_, i) => `u${i}`);
  const event = sample({ rsvp: { going, maybe: [], no: [] } });

  // Their own slot must not count against them, so 'unchanged' has to win the race.
  expect(applyRsvp(event, 'u0', 'going')).toBe('unchanged');
  expect(event.rsvp.going.length).toBe(MAX_PER_LIST);

  // And leaving a full list for another one still works.
  expect(applyRsvp(event, 'u0', 'no')).toBe('moved');
  expect(event.rsvp.going.length).toBe(MAX_PER_LIST - 1);
});
