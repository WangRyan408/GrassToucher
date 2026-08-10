import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_PER_LIST, applyRsvp, fromEmbed, toEmbed } from './event.js';

const sample = (over = {}) => ({
  title: 'Touch Grass',
  description: 'Outside. The big room.',
  where: 'Dolores Park',
  startsAt: new Date('2026-08-15T17:30:00.000Z'),
  organizerId: '111111111111111111',
  reminded: false,
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

test('rsvp adds, moves, and withdraws', () => {
  const event = sample({ rsvp: { going: [], maybe: [], no: [] } });

  assert.equal(applyRsvp(event, 'u1', 'going'), 'added');
  assert.deepEqual(event.rsvp.going, ['u1']);

  assert.equal(applyRsvp(event, 'u1', 'maybe'), 'moved');
  assert.deepEqual(event.rsvp, { going: [], maybe: ['u1'], no: [] });

  assert.equal(applyRsvp(event, 'u1', 'maybe'), 'withdrawn');
  assert.deepEqual(event.rsvp, { going: [], maybe: [], no: [] });
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

test('someone already on the full list can still withdraw from it', () => {
  const going = Array.from({ length: MAX_PER_LIST }, (_, i) => `u${i}`);
  const event = sample({ rsvp: { going, maybe: [], no: [] } });

  assert.equal(applyRsvp(event, 'u0', 'going'), 'withdrawn');
  assert.equal(event.rsvp.going.length, MAX_PER_LIST - 1);
});
