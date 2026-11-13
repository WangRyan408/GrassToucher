import { Collection, MessageFlags, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import type { ButtonInteraction, ChatInputCommandInteraction, EmbedBuilder, ForumThreadChannel, Message, ThreadChannel } from 'discord.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { handleCancelConfirm } from '../src/commands/cancel.ts';
import { handleCreate } from '../src/commands/create.ts';
import { handleEdit } from '../src/commands/edit.ts';
import { handlePause } from '../src/commands/pause.ts';
import { loadConfig } from '../src/config.ts';
import { rebuildDigest } from '../src/digest.ts';
import { COLOR_PAST, fromEmbed, threadName, toEmbed } from '../src/event.ts';
import { route } from '../src/interactions.ts';
import { sweep } from '../src/sweep.ts';
import type { Ctx } from '../src/types/config.ts';
import type { Event } from '../src/types/event.ts';
import type { Recurrence, RecurrenceFrequency } from '../src/types/recurrence.ts';
import type { GuildContexts } from '../src/types/setup.ts';
import { forum, server, textChannel } from './helpers/discord.ts';

const NOW = new Date('2030-01-01T12:00:00Z');
const ORGANIZER = '111111111111111111';
const ATTENDEE = '222222222222222222';
const config = loadConfig({ DISCORD_TOKEN: 'test-token', DEFAULT_TZ: 'UTC' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function schedule(frequency: RecurrenceFrequency = 'weekly', anchor: Date | null = null, timeZone = 'UTC'): Recurrence {
  return { frequency, anchor, timeZone };
}

function event(over: Partial<Event> = {}): Event {
  return {
    title: 'Walk', description: null, where: null, startsAt: null,
    organizerId: ORGANIZER, reminded: false, cancelled: false,
    recurring: null, pausedUntil: null,
    rsvp: { going: [ORGANIZER, ATTENDEE], maybe: [], no: [] },
    ...over,
  };
}

/** Keep the serialized embed between calls, as Discord does across processes and restarts. */
function world() {
  const selected = forum('forum');
  const board = textChannel('digest');
  const { guild, client } = server('guild', selected, board);
  Object.assign(guild, { name: 'Park friends' });
  const sendDm = vi.fn(async (_id: string, _body: string) => ({}));
  Object.assign(client, { users: { send: sendDm } });
  const ctx: Ctx = { client, config, guild, forum: selected, digestChannel: board };
  const active = new Collection<string, ForumThreadChannel>();
  const archived = new Collection<string, ForumThreadChannel>();
  vi.mocked(selected.threads.fetchActive).mockResolvedValue({ threads: active, members: new Collection() });
  vi.mocked(selected.threads.fetchArchived).mockResolvedValue({
    threads: archived, members: new Collection(), hasMore: false,
  });

  function addPost(record: Event, isArchived = false) {
    const id = String(active.size + archived.size + 1);
    const message = {
      author: { id: client.user.id },
      embeds: [toEmbed(record).toJSON()],
      edit: vi.fn(async (options: { embeds: EmbedBuilder[] }) => {
        message.embeds = options.embeds.map((embed) => embed.toJSON());
        return message as unknown as Message;
      }),
    };
    const post = {
      id, parentId: selected.id, name: threadName(record), archived: isArchived,
      archiveTimestamp: isArchived ? NOW.getTime() - 3_600_000 : null,
      url: `https://discord.com/channels/guild/forum/${id}`,
      isThread: () => true,
      toString: () => `<#${id}>`,
      fetchStarterMessage: vi.fn(async () => message as unknown as Message),
      send: vi.fn(async () => ({})),
      setName: vi.fn(async (name: string) => { post.name = name; }),
      setArchived: vi.fn(async (value: boolean) => { post.archived = value; }),
    };
    const thread = post as unknown as ForumThreadChannel;
    (isArchived ? archived : active).set(id, thread);
    return { post, thread, message, stored: () => fromEmbed(message.embeds[0]) };
  }

  return { ctx, addPost, sendDm };
}

function command(values: Record<string, string | boolean | null>, thread?: ThreadChannel, subcommand = 'create') {
  return {
    guildId: 'guild', commandName: 'event',
    isAutocomplete: () => false, isChatInputCommand: () => true,
    isButton: () => false, inGuild: () => true,
    user: { id: ORGANIZER, toString: () => `<@${ORGANIZER}>` },
    channel: thread,
    options: {
      getSubcommand: () => subcommand,
      getString: (key: string) => typeof values[key] === 'string' ? values[key] : null,
      getBoolean: (key: string) => typeof values[key] === 'boolean' ? values[key] : null,
    },
    reply: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(), deferUpdate: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}

test.each(['TBD', 'tbd', '  TbD  '])('creates an undated event with when:%s', async (when) => {
  const { ctx, addPost } = world();
  // Use the command's actual embed as the stored post, so rebuilding the digest reads it back.
  vi.mocked(ctx.forum.threads.create).mockImplementation(async (options) => {
    const message = options.message;
    if (!('embeds' in message) || !message.embeds?.length) throw new Error('Expected an event embed');
    const embed = message.embeds[0] as EmbedBuilder;
    return addPost(fromEmbed(embed.toJSON())).thread;
  });
  const interaction = command({ title: 'Walk', when });
  await handleCreate(interaction, ctx);
  expect(ctx.forum.threads.create).toHaveBeenCalledOnce();
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(interaction.editReply).toHaveBeenCalledWith({
    content: expect.stringContaining('Date TBD.'),
  });
  const [entry] = await rebuildDigest(ctx);
  expect(entry?.event.startsAt).toBeNull();
  expect(entry?.event.rsvp.going).toEqual([ORGANIZER]);
  const digest = await ctx.digestChannel.messages.fetch({ limit: 1 });
  expect(digest.first()?.embeds[0]?.description).toContain('Date TBD');
});

test.each([null, '', '   ', 'asdfqwer'])('rejects blank or unreadable dates: %s', async (when) => {
  const { ctx } = world();
  const interaction = command({ title: 'Walk', when });
  await handleCreate(interaction, ctx);
  expect(ctx.forum.threads.create).not.toHaveBeenCalled();
  expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining("Couldn't read"),
  }));
});

test('can clear a date, schedule it later, and deliver a fresh reminder exactly once', async () => {
  const { ctx, addPost } = world();
  const { thread, post, stored } = addPost(event({
    startsAt: new Date('2029-12-31T12:00:00Z'), reminded: true,
  }));
  const clear = command({ when: 'TBD' }, thread);
  await handleEdit(clear, ctx);
  expect(stored().startsAt).toBeNull();
  expect(stored().reminded).toBe(false);
  expect(clear.editReply).toHaveBeenCalledWith({ content: 'Updated — date TBD.' });
  expect(post.name).toBe('🟢 Walk');

  await sweep(ctx);
  expect(post.send).not.toHaveBeenCalled();
  expect(post.setArchived).not.toHaveBeenCalled();

  const schedule = command({ when: '2030-01-01 12:30' }, thread);
  await handleEdit(schedule, ctx);
  expect(stored().startsAt).toEqual(new Date('2030-01-01T12:30:00Z'));
  expect(schedule.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('<t:') });
  await sweep(ctx);
  expect(post.send).toHaveBeenCalledOnce();
  expect(post.send).toHaveBeenCalledWith(expect.stringContaining('starts <t:'));
  expect(stored().reminded).toBe(true);
  await sweep(ctx);
  expect(post.send).toHaveBeenCalledOnce();
});

test.each([null, new Date('2030-01-01T12:30:00Z')])('editing another field keeps the date %s', async (startsAt) => {
  const { ctx, addPost } = world();
  const { thread, stored } = addPost(event({ startsAt, reminded: true }));
  await handleEdit(command({ title: 'Picnic' }, thread), ctx);
  expect(stored().title).toBe('Picnic');
  expect(stored().startsAt).toEqual(startsAt);
  expect(stored().reminded).toBe(true);
});

test('the digest keeps active and archived TBD events after scheduled events', async () => {
  const { ctx, addPost } = world();
  addPost(event({ title: 'Undated' }));
  addPost(event({ title: 'Later', startsAt: new Date('2030-01-03T12:00:00Z') }));
  addPost(event({ title: 'Soon', startsAt: new Date('2030-01-02T12:00:00Z') }));
  addPost(event({ title: 'Expired', startsAt: new Date('2020-01-01T12:00:00Z') }));
  addPost(event({ title: 'Archived undated' }), true);
  const entries = await rebuildDigest(ctx);
  expect(entries.map(({ event }) => event.title)).toEqual([
    'Expired', 'Soon', 'Later', 'Undated', 'Archived undated',
  ]);
  const digest = await ctx.digestChannel.messages.fetch({ limit: 1 });
  const body = digest.first()?.embeds[0]?.description ?? '';
  expect(body).not.toContain('Expired');
  expect(body).toContain('Archived undated');
  expect(body.match(/Date TBD/g)).toHaveLength(2);
  expect(body.indexOf('Soon')).toBeLessThan(body.indexOf('Later'));
  expect(body.indexOf('Later')).toBeLessThan(body.indexOf('Undated'));
});

test.each([false, true])('RSVP updates preserve TBD, recurrence and pause state (paused:%s)', async (paused) => {
  const { ctx, addPost } = world();
  const pausedUntil = paused ? new Date(NOW.getTime() + 86_400_000) : null;
  const { thread, message, stored } = addPost(event({ recurring: schedule(), pausedUntil }));
  const button = {
    ...command({}, thread), guildId: ctx.guild.id, customId: 'rsvp:maybe', message,
    isAutocomplete: () => false, isChatInputCommand: () => false,
    isButton: () => true, inGuild: () => true,
    update: vi.fn(async (options: { embeds: EmbedBuilder[] }) => message.edit(options)),
  } as unknown as ButtonInteraction;
  const contexts: GuildContexts = {
    get: () => ctx, configure: vi.fn(), refresh: vi.fn(),
    invalidate: vi.fn(() => false), remove: vi.fn(),
  };
  await route(button, config, contexts);
  expect(button.update).toHaveBeenCalledOnce();
  expect(stored().startsAt).toBeNull();
  expect(stored().recurring).toEqual(schedule());
  expect(stored().pausedUntil).toEqual(pausedUntil);
  expect(stored().rsvp.maybe).toEqual([ORGANIZER]);
  expect(stored().rsvp.going).toEqual([ATTENDEE]);
  const digest = await ctx.digestChannel.messages.fetch({ limit: 1 });
  if (paused) expect(digest.first()?.embeds[0]?.description).not.toContain('Walk');
  else expect(digest.first()?.embeds[0]?.description).toContain('Date TBD');
});

test('the sweep skips TBD timing while still reminding and archiving dated events', async () => {
  const { ctx, addPost } = world();
  const undated = addPost(event());
  undated.post.name = '⚫ Walk';
  undated.message.embeds[0].color = COLOR_PAST;
  const archived = addPost(event(), true);
  const due = addPost(event({ startsAt: new Date('2030-01-01T12:30:00Z') }));
  const past = addPost(event({ startsAt: new Date('2020-01-01T12:00:00Z') }));
  await sweep(ctx);
  expect(undated.post.send).not.toHaveBeenCalled();
  expect(undated.post.setArchived).not.toHaveBeenCalled();
  expect(undated.post.name).toBe('🟢 Walk');
  expect(archived.post.setArchived).not.toHaveBeenCalled();
  expect(archived.post.setName).not.toHaveBeenCalled();
  expect(due.post.send).toHaveBeenCalledOnce();
  expect(due.stored().reminded).toBe(true);
  expect(past.post.setArchived).toHaveBeenCalledWith(true, 'Event finished');
});

test('an undated event can be cancelled and restored with accurate notifications', async () => {
  const { ctx, addPost, sendDm } = world();
  const { thread, stored } = addPost(event());
  const cancel = command({}, thread) as unknown as ButtonInteraction;
  await handleCancelConfirm(cancel, ctx);
  expect(stored().cancelled).toBe(true);
  expect(stored().startsAt).toBeNull();
  expect(sendDm).toHaveBeenLastCalledWith(ATTENDEE, expect.stringContaining('date was TBD'));
  expect(sendDm.mock.calls[0]?.[1]).not.toContain('<t:');

  await handleEdit(command({ uncancel: true }, thread), ctx);
  expect(stored().cancelled).toBe(false);
  expect(stored().startsAt).toBeNull();
  expect(sendDm).toHaveBeenLastCalledWith(ATTENDEE, expect.stringContaining('date TBD'));
});

test.each(['daily', 'weekly', 'bi-weekly', 'monthly', null] as const)('create persists recurring:%s with its timezone', async (recurring) => {
  const { ctx, addPost } = world();
  vi.mocked(ctx.forum.threads.create).mockImplementation(async (options) => {
    if (!('embeds' in options.message)) throw new Error('Expected an event embed');
    const embed = options.message.embeds?.[0] as EmbedBuilder;
    return addPost(fromEmbed(embed.toJSON())).thread;
  });
  await handleCreate(command({ title: 'Regular walk', when: 'TBD', recurring }), ctx);
  const [entry] = await rebuildDigest(ctx);
  expect(entry?.event.recurring).toEqual(recurring ? schedule(recurring) : null);
  expect(entry?.event.pausedUntil).toBeNull();
  expect(entry?.event.startsAt).toBeNull();
});

test('recurring posts remain in the digest after their date, including cancelled and archived posts', async () => {
  const { ctx, addPost } = world();
  const startsAt = new Date('2020-01-01T12:00:00Z');
  const recurring = addPost(event({ title: 'Weekly walk', startsAt, recurring: schedule('weekly', startsAt) }));
  addPost(event({ title: 'Cancelled recurring', startsAt, recurring: schedule('weekly', startsAt), cancelled: true }));
  addPost(event({ title: 'Archived recurring', startsAt, recurring: schedule('weekly', startsAt) }), true);
  addPost(event({ title: 'Old one-off', startsAt }));
  await sweep(ctx);
  const digest = await ctx.digestChannel.messages.fetch({ limit: 1 });
  const body = digest.first()?.embeds[0]?.description;
  expect(body).toContain('Weekly walk');
  expect(body).toContain('Cancelled recurring');
  expect(body).toContain('Archived recurring');
  expect(body).toContain('🔁 Weekly');
  expect(body).not.toContain('Old one-off');
  expect(recurring.post.name).toBe('🟢 Weekly walk');
  expect(recurring.post.setArchived).not.toHaveBeenCalled();
  expect(recurring.post.send).not.toHaveBeenCalled();
});

test('pause changes only its own post, survives a restart, and expires automatically', async () => {
  const { ctx, addPost } = world();
  const target = addPost(event({ title: 'Recurring walk', recurring: schedule() }));
  const other = addPost(event({ title: 'Other event', recurring: schedule() }));
  const contexts: GuildContexts = {
    get: () => ctx, configure: vi.fn(), refresh: vi.fn(),
    invalidate: vi.fn(() => false), remove: vi.fn(),
  };
  const pause = command({ duration: '3d' }, target.thread, 'pause');
  await route(pause, config, contexts);
  const deadline = new Date(NOW.getTime() + 3 * 86_400_000);
  expect(target.stored().pausedUntil).toEqual(deadline);
  expect(target.post.name).toBe('🟡 Recurring walk');
  expect(other.message.edit).not.toHaveBeenCalled();
  expect(other.stored().pausedUntil).toBeNull();
  expect(pause.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(pause.editReply).toHaveBeenCalledWith({ content: expect.stringContaining('Paused until <t:') });
  const digest = await ctx.digestChannel.messages.fetch({ limit: 1 });
  expect(digest.first()?.embeds[0]?.description).not.toContain('Recurring walk');
  expect(digest.first()?.embeds[0]?.description).toContain('Other event');

  await handleEdit(command({ description: 'Every weekend' }, target.thread), ctx);
  expect(target.stored().pausedUntil).toEqual(deadline);
  expect(target.stored().recurring).toEqual(schedule());

  // A fresh context must recover the deadline from the serialized message, not a process timer.
  const restarted = world();
  const persisted = JSON.parse(JSON.stringify(target.message.embeds[0]));
  const recovered = restarted.addPost(fromEmbed(persisted));
  vi.setSystemTime(new Date(deadline.getTime() - 1));
  await sweep(restarted.ctx);
  let restoredDigest = await restarted.ctx.digestChannel.messages.fetch({ limit: 1 });
  expect(restoredDigest.first()?.embeds[0]?.description).not.toContain('Recurring walk');
  vi.setSystemTime(deadline);
  await sweep(restarted.ctx);
  restoredDigest = await restarted.ctx.digestChannel.messages.fetch({ limit: 1 });
  expect(restoredDigest.first()?.embeds[0]?.description).toContain('Recurring walk');
  expect(recovered.stored().pausedUntil).toBeNull();
  expect(recovered.post.name).toBe('🟢 Recurring walk');
});

test.each([
  ['30m', 30 * 60_000], ['2 hours', 2 * 3_600_000], ['3d', 3 * 86_400_000],
  ['1 week', 604_800_000], ['1.5h', 1.5 * 3_600_000], ['  2 DAYS  ', 2 * 86_400_000],
] as const)('pause duration %s creates the requested deadline', async (duration, milliseconds) => {
  const { ctx, addPost } = world();
  const target = addPost(event({ recurring: schedule() }));
  await handlePause(command({ duration }, target.thread), ctx);
  expect(target.stored().pausedUntil).toEqual(new Date(NOW.getTime() + milliseconds));
});

test.each(['', '0d', '-1d', '2h typo', '1 month', '2d 3h', 'Infinityd', '99999999999999999999w'])(
  'invalid pause duration %s leaves the post untouched', async (duration) => {
    const { ctx, addPost } = world();
    const target = addPost(event({ recurring: schedule() }));
    const pause = command({ duration }, target.thread);
    await handlePause(pause, ctx);
    expect(pause.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('positive duration'), flags: MessageFlags.Ephemeral,
    }));
    expect(target.message.edit).not.toHaveBeenCalled();
    expect(ctx.digestChannel.send).not.toHaveBeenCalled();
  },
);

test.each(['plain channel', 'different forum', 'unrelated post'])('pause refuses a %s', async (where) => {
  const { ctx, addPost } = world();
  const target = addPost(event({ recurring: schedule() }));
  if (where === 'different forum') target.post.parentId = 'another-forum';
  if (where === 'unrelated post') target.message.author.id = 'someone-else';
  const pause = command({ duration: '1d' }, where === 'plain channel' ? undefined : target.thread);
  await handlePause(pause, ctx);
  expect(pause.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  expect(target.message.edit).not.toHaveBeenCalled();
  expect(ctx.digestChannel.send).not.toHaveBeenCalled();
});

test('only the organizer or someone with Manage Threads can pause a post', async () => {
  const { ctx, addPost } = world();
  const target = addPost(event({ recurring: schedule() }), true);
  const pause = command({ duration: '1d' }, target.thread);
  Object.assign(pause, {
    user: { id: 'outsider' }, memberPermissions: new PermissionsBitField(),
  });
  await handlePause(pause, ctx);
  expect(pause.reply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('Only the organizer'),
  }));
  expect(target.message.edit).not.toHaveBeenCalled();
  Object.assign(pause, { memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageThreads) });
  await handlePause(pause, ctx);
  expect(target.message.edit).toHaveBeenCalledOnce();
  expect(target.post.setArchived).toHaveBeenCalledWith(false, 'GrassToucher update');
});

test.each([false, true])('paused events send no reminder or archive and a new pause replaces the deadline (recurring:%s)', async (recurring) => {
  const { ctx, addPost } = world();
  const target = addPost(event({
    startsAt: new Date('2030-01-01T12:30:00Z'), recurring: recurring ? schedule() : null,
  }));
  await handlePause(command({ duration: '2h' }, target.thread), ctx);
  await sweep(ctx);
  expect(target.post.send).not.toHaveBeenCalled();
  expect(target.stored().reminded).toBe(false);
  await handlePause(command({ duration: '3d' }, target.thread), ctx);
  expect(target.stored().pausedUntil).toEqual(new Date(NOW.getTime() + 3 * 86_400_000));
  vi.setSystemTime(new Date(NOW.getTime() + 2 * 86_400_000));
  await sweep(ctx);
  expect(target.post.setArchived).not.toHaveBeenCalled();
});

test.each([false, true])('a pause expiring inside the reminder window also updates the status dot (archived:%s)', async (archived) => {
  const { ctx, addPost } = world();
  const deadline = new Date(NOW.getTime() + 15 * 60_000);
  const target = addPost(event({
    recurring: schedule(), startsAt: new Date(NOW.getTime() + 30 * 60_000), pausedUntil: deadline,
  }), archived);
  expect(target.post.name).toBe('🟡 Walk');
  vi.setSystemTime(deadline);
  await sweep(ctx);
  expect(target.post.send).toHaveBeenCalledOnce();
  expect(target.stored().reminded).toBe(true);
  expect(target.stored().pausedUntil).toBeNull();
  expect(target.post.name).toBe('🟢 Walk');
  expect(target.post.archived).toBe(false);
});

test('older archived recurring events are discovered after the first archive page', async () => {
  const { ctx, addPost } = world();
  const newer = addPost(event({ title: 'Recent archive' }), true);
  const older = addPost(event({
    title: 'Old recurring', startsAt: new Date('2020-01-01T12:00:00Z'), recurring: schedule(),
  }), true);
  vi.mocked(ctx.forum.threads.fetchArchived)
    .mockResolvedValueOnce({
      threads: new Collection([[newer.thread.id, newer.thread]]), members: new Collection(), hasMore: true,
    })
    .mockResolvedValueOnce({
      threads: new Collection([[older.thread.id, older.thread]]), members: new Collection(), hasMore: false,
    });
  const entries = await rebuildDigest(ctx);
  expect(entries.map(({ event }) => event.title)).toContain('Old recurring');
  expect(ctx.forum.threads.fetchArchived).toHaveBeenNthCalledWith(2, {
    limit: 100, before: new Date(newer.post.archiveTimestamp!),
  });
  const digest = await ctx.digestChannel.messages.fetch({ limit: 1 });
  expect(digest.first()?.embeds[0]?.description).toContain('Old recurring');
});

test('an archive cursor that cannot advance fails instead of looping or posting a partial digest', async () => {
  const { ctx, addPost } = world();
  const archived = addPost(event({ recurring: schedule() }), true);
  vi.mocked(ctx.forum.threads.fetchArchived).mockResolvedValue({
    threads: new Collection([[archived.thread.id, archived.thread]]), members: new Collection(), hasMore: true,
  });
  await expect(rebuildDigest(ctx)).rejects.toThrow('Could not advance');
  expect(ctx.forum.threads.fetchArchived).toHaveBeenCalledTimes(2);
  expect(ctx.digestChannel.send).not.toHaveBeenCalled();
});

test.each([
  ['daily', '2030-01-02T12:00:00Z'], ['weekly', '2030-01-07T12:00:00Z'],
  ['bi-weekly', '2030-01-14T12:00:00Z'], ['monthly', '2030-01-31T12:00:00Z'],
] as const)('the sweep advances %s in the same post and digest, retaining RSVPs', async (frequency, expected) => {
  const { ctx, addPost } = world();
  const anchor = new Date('2029-12-31T12:00:00Z');
  const target = addPost(event({
    title: 'Repeating walk', startsAt: anchor, recurring: schedule(frequency, anchor), reminded: true,
  }));
  const rsvp = target.stored().rsvp;
  addPost(event({ title: 'Earlier event', startsAt: new Date('2030-01-01T18:00:00Z') }));
  await sweep(ctx);
  const next = new Date(expected);
  expect(target.stored().startsAt).toEqual(next);
  expect(target.stored().recurring?.anchor).toEqual(anchor);
  expect(target.stored().rsvp).toEqual(rsvp);
  expect(target.stored().reminded).toBe(false);
  expect(target.message.edit).toHaveBeenCalledOnce();
  expect(ctx.forum.threads.create).not.toHaveBeenCalled();
  expect(target.post.send).not.toHaveBeenCalled();
  const digest = await ctx.digestChannel.messages.fetch({ limit: 1 });
  const body = digest.first()?.embeds[0]?.description ?? '';
  expect(body).toContain(String(next.getTime() / 1000));
  expect(body.indexOf('Earlier event')).toBeLessThan(body.indexOf('Repeating walk'));
  await sweep(ctx);
  expect(target.message.edit).toHaveBeenCalledOnce();
});

test('a recurring post opens on rollover and the next occurrence receives one fresh reminder', async () => {
  const { ctx, addPost } = world();
  const target = addPost(event({
    startsAt: NOW, recurring: schedule('daily', NOW), reminded: true,
  }), true);
  await sweep(ctx);
  expect(target.stored().startsAt).toEqual(new Date('2030-01-02T12:00:00Z'));
  expect(target.post.setArchived).toHaveBeenCalledWith(false, 'GrassToucher update');
  expect(target.stored().reminded).toBe(false);
  vi.setSystemTime(new Date('2030-01-02T11:30:00Z'));
  await sweep(ctx);
  await sweep(ctx);
  expect(target.post.send).toHaveBeenCalledOnce();
  expect(target.stored().reminded).toBe(true);
  vi.setSystemTime(new Date('2030-01-02T12:00:00Z'));
  await sweep(ctx);
  expect(target.stored().startsAt).toEqual(new Date('2030-01-03T12:00:00Z'));
  expect(target.stored().reminded).toBe(false);
});

test('restart catch-up preserves the original monthly day and timezone', async () => {
  const original = world();
  const anchor = new Date('2028-02-01T03:00:00Z'); // January 31 at 7 PM in Los Angeles.
  const target = original.addPost(event({
    startsAt: new Date('2028-03-01T03:00:00Z'), // February 29 at 7 PM.
    recurring: schedule('monthly', anchor, 'America/Los_Angeles'), reminded: true,
  }));
  const persisted = JSON.parse(JSON.stringify(target.message.embeds[0]));
  const restarted = world();
  const recovered = restarted.addPost(fromEmbed(persisted));
  await sweep(restarted.ctx);
  expect(recovered.stored().startsAt).toEqual(new Date('2030-02-01T03:00:00Z'));
  expect(recovered.stored().recurring).toEqual(schedule('monthly', anchor, 'America/Los_Angeles'));
  expect(recovered.post.send).not.toHaveBeenCalled();
});

test('pausing holds the date and expiry catches up to the next future occurrence', async () => {
  const { ctx, addPost } = world();
  const anchor = new Date('2029-12-31T12:00:00Z');
  const deadline = new Date('2030-01-03T12:00:00Z');
  const target = addPost(event({
    startsAt: anchor, recurring: schedule('daily', anchor), pausedUntil: deadline,
  }));
  await sweep(ctx);
  expect(target.stored().startsAt).toEqual(anchor);
  vi.setSystemTime(deadline);
  await sweep(ctx);
  expect(target.stored().startsAt).toEqual(new Date('2030-01-04T12:00:00Z'));
  expect(target.stored().pausedUntil).toBeNull();
  const digest = await ctx.digestChannel.messages.fetch({ limit: 1 });
  expect(digest.first()?.embeds[0]?.description).toContain('Walk');
});

test('cancelled recurring posts do not advance', async () => {
  const { ctx, addPost } = world();
  const anchor = new Date('2029-12-31T12:00:00Z');
  const target = addPost(event({ startsAt: anchor, recurring: schedule('daily', anchor), cancelled: true }));
  await sweep(ctx);
  expect(target.stored().startsAt).toEqual(anchor);
  expect(target.message.edit).not.toHaveBeenCalled();
  expect(target.post.send).not.toHaveBeenCalled();
});

test('reinstating a cancelled series quotes its next occurrence in the notification', async () => {
  const { ctx, addPost, sendDm } = world();
  const anchor = new Date('2029-12-31T12:00:00Z');
  const target = addPost(event({
    startsAt: anchor, recurring: schedule('daily', anchor), cancelled: true, reminded: true,
  }));
  await handleEdit(command({ uncancel: true }, target.thread), ctx);
  const next = new Date('2030-01-02T12:00:00Z');
  expect(target.stored().startsAt).toEqual(next);
  expect(target.stored().cancelled).toBe(false);
  expect(target.stored().reminded).toBe(false);
  expect(sendDm).toHaveBeenCalledWith(ATTENDEE, expect.stringContaining(String(next.getTime() / 1000)));
});

test('TBD recurrence waits for a first date, and edits establish the calendar anchor', async () => {
  const { ctx, addPost } = world();
  const target = addPost(event({ recurring: schedule('monthly', null, 'America/Los_Angeles') }));
  await sweep(ctx);
  expect(target.stored().startsAt).toBeNull();
  await handleEdit(command({ when: '2030-01-31 19:00', timezone: 'America/Los_Angeles' }, target.thread), ctx);
  const anchor = new Date('2030-02-01T03:00:00Z');
  expect(target.stored().startsAt).toEqual(anchor);
  expect(target.stored().recurring).toEqual(schedule('monthly', anchor, 'America/Los_Angeles'));
  vi.setSystemTime(anchor);
  await sweep(ctx);
  expect(target.stored().startsAt).toEqual(new Date('2030-03-01T03:00:00Z'));
});

test('cadence edits upgrade old boolean posts and can remove recurrence', async () => {
  const { ctx, addPost } = world();
  const anchor = new Date('2030-01-01T19:00:00Z');
  const target = addPost(event({
    startsAt: anchor, recurring: { frequency: null, timeZone: null, anchor: null },
  }));
  await handleEdit(command({ recurring: 'weekly', timezone: 'America/Los_Angeles' }, target.thread), ctx);
  expect(target.stored().recurring).toEqual(schedule('weekly', anchor, 'America/Los_Angeles'));
  await handleEdit(command({ title: 'Weekly walk' }, target.thread), ctx);
  expect(target.stored().recurring?.anchor).toEqual(anchor);
  await handleEdit(command({ recurring: 'none' }, target.thread), ctx);
  expect(target.stored().recurring).toBeNull();
});

test('manual time edits use the same default timezone as autocomplete', async () => {
  const { ctx, addPost } = world();
  const target = addPost(event({ recurring: schedule('weekly', null, 'America/Los_Angeles') }));
  await handleEdit(command({ when: '2030-01-02 19:00' }, target.thread), ctx);
  expect(target.stored().startsAt).toEqual(new Date('2030-01-02T19:00:00Z'));
  expect(target.stored().recurring?.timeZone).toBe('UTC');
});
