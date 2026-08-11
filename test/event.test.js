import assert from 'node:assert/strict';
import { test } from 'node:test';
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
} from '../src/event.js';

const sample = (over = {}) => ({
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
const roundTrip = (event) => fromEmbed(toEmbed(event).toJSON());

test('survives a round-trip through the embed', () => {
  const event = sample();
  assert.deepEqual(roundTrip(event), event);
});

test('carries the reminded marker without disturbing the organizer id', () => {
  const event = sample({ reminded: true });
  const back = roundTrip(event);
  assert.equal(back.reminded, true);
  assert.equal(back.organizerId, event.organizerId);
});

test('round-trips events with optional fields missing', () => {
  const event = sample({ description: null, where: null, rsvp: { going: [], maybe: [], no: [] } });
  assert.deepEqual(roundTrip(event), event);
});

test('an empty list stays empty rather than picking up the placeholder', () => {
  const back = roundTrip(sample({ rsvp: { going: [], maybe: [], no: [] } }));
  assert.deepEqual(back.rsvp, { going: [], maybe: [], no: [] });
});

test('a full list of attendees still round-trips inside the field limit', () => {
  const going = Array.from({ length: MAX_PER_LIST }, (_, i) => String(100000000000000000n + BigInt(i)));
  const embed = toEmbed(sample({ rsvp: { going, maybe: [], no: [] } })).toJSON();
  const field = embed.fields.find((f) => f.name.startsWith('✅'));

  assert.ok(field.value.length <= 1024, `field was ${field.value.length} chars`);
  assert.deepEqual(fromEmbed(embed).rsvp.going, going);
});

test('a cancelled event round-trips with a clean title', () => {
  const event = sample({ cancelled: true });
  const rendered = toEmbed(event).toJSON();

  assert.ok(rendered.title.endsWith(CANCELLED_SUFFIX), rendered.title);
  assert.equal(rendered.color, COLOR_CANCELLED);
  assert.deepEqual(roundTrip(event), event); // Title comes back without the marker.
});

test('re-rendering a cancelled event does not stack the marker', () => {
  const once = toEmbed(sample({ cancelled: true })).toJSON();
  const twice = toEmbed(fromEmbed(once)).toJSON();

  assert.equal(twice.title, once.title);
  assert.equal(twice.title.match(/CANCELLED/g).length, 1);
});

test('un-cancelling leaves no trace of the cancellation', () => {
  // What /event edit uncancel does: read the post back, clear the flag, re-render.
  const cancelled = fromEmbed(toEmbed(sample({ cancelled: true })).toJSON());
  const back = toEmbed({ ...cancelled, cancelled: false }).toJSON();

  assert.equal(back.title, 'Touch Grass');
  assert.ok(!back.footer.text.includes('cancelled'), back.footer.text);
  assert.equal(back.color, COLOR_UPCOMING);
  assert.equal(displayTitle({ ...cancelled, cancelled: false }, 100), 'Touch Grass');
});

test('cancelled outranks past when picking the colour', () => {
  const past = new Date('2020-01-01T00:00:00.000Z');
  assert.equal(embedColor(sample({ startsAt: past, cancelled: true })), COLOR_CANCELLED);
});

test('displayTitle truncates the title, never the marker', () => {
  const long = 'g'.repeat(100);
  const shown = displayTitle(sample({ title: long, cancelled: true }), 100);

  assert.equal(shown.length, 100);
  assert.ok(shown.endsWith(CANCELLED_SUFFIX), shown);
});

test('notifies everyone who might turn up, except whoever changed the plan', () => {
  const event = sample({
    organizerId: 'organizer',
    rsvp: { going: ['organizer', 'goer'], maybe: ['maybe'], no: ['declined'] },
  });

  assert.deepEqual(notifyRecipients(event, 'organizer'), ['goer', 'maybe']);
  // A mod cancelling someone else's event still tells the organizer, exactly once.
  assert.deepEqual(notifyRecipients(event, 'mod'), ['organizer', 'goer', 'maybe']);
});

test('recipients survive an event with no organizer in the footer', () => {
  const event = sample({ organizerId: null, rsvp: { going: ['goer'], maybe: [], no: [] } });
  assert.deepEqual(notifyRecipients(event, 'mod'), ['goer']);
});

test('rsvp adds and moves', () => {
  const event = sample({ rsvp: { going: [], maybe: [], no: [] } });

  assert.equal(applyRsvp(event, 'u1', 'going'), 'added');
  assert.deepEqual(event.rsvp.going, ['u1']);

  assert.equal(applyRsvp(event, 'u1', 'maybe'), 'moved');
  assert.deepEqual(event.rsvp, { going: [], maybe: ['u1'], no: [] });
});

test('re-picking the same answer is a no-op, not a withdrawal', () => {
  for (const choice of ['going', 'maybe', 'no']) {
    const event = sample({ rsvp: { going: [], maybe: [], no: [] } });
    applyRsvp(event, 'u1', choice);

    // The click that used to silently drop them off the list.
    assert.equal(applyRsvp(event, 'u1', choice), 'unchanged', choice);
    assert.deepEqual(event.rsvp[choice], ['u1'], `${choice} kept its member`);
  }
});

test('a user never appears on two lists at once', () => {
  const event = sample({ rsvp: { going: ['u1'], maybe: ['u1'], no: [] } });
  applyRsvp(event, 'u1', 'no');
  assert.deepEqual(event.rsvp, { going: [], maybe: [], no: ['u1'] });
});

test('refuses to overflow a list instead of dropping names', () => {
  const going = Array.from({ length: MAX_PER_LIST }, (_, i) => `u${i}`);
  const event = sample({ rsvp: { going, maybe: [], no: [] } });

  assert.equal(applyRsvp(event, 'late', 'going'), 'full');
  assert.equal(event.rsvp.going.length, MAX_PER_LIST, 'nobody was evicted');
  assert.ok(!event.rsvp.going.includes('late'));

  // A full Going list must not block the other lists.
  assert.equal(applyRsvp(event, 'late', 'maybe'), 'added');
});

test('someone already on a full list is not told it is full', () => {
  const going = Array.from({ length: MAX_PER_LIST }, (_, i) => `u${i}`);
  const event = sample({ rsvp: { going, maybe: [], no: [] } });

  // Their own slot must not count against them, so 'unchanged' has to win the race.
  assert.equal(applyRsvp(event, 'u0', 'going'), 'unchanged');
  assert.equal(event.rsvp.going.length, MAX_PER_LIST);

  // And leaving a full list for another one still works.
  assert.equal(applyRsvp(event, 'u0', 'no'), 'moved');
  assert.equal(event.rsvp.going.length, MAX_PER_LIST - 1);
});
