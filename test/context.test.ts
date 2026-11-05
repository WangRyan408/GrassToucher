import { EmbedBuilder, PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { buildContext, createContexts } from '../src/context.ts';
import { openGuildDatabase } from '../src/database.ts';
import { SETUP_REQUIRED } from '../src/setup.ts';
import { forum, server, textChannel } from './helpers/discord.ts';

const config = loadConfig({ DISCORD_TOKEN: 'test-token' });
const setup = { forumId: '111', digestChannelId: '222' };
const databases: ReturnType<typeof openGuildDatabase>[] = [];

function createDatabase() {
  const database = openGuildDatabase(':memory:');
  databases.push(database);
  return database;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

test('channel names and the only available forum never bypass setup', async () => {
  const { guild, client } = server('one', forum('111', 'events'), textChannel('222', 'event-digest'));
  expect(await buildContext(client, config, guild, null)).toBe(SETUP_REQUIRED);
  expect(await buildContext(client, config, guild, { ...setup, digestChannelId: '' })).toBe(SETUP_REQUIRED);
  expect(await buildContext(client, config, guild, { ...setup, forumId: '' })).toBe(SETUP_REQUIRED);
});

test('uses the explicitly selected channels regardless of their names', async () => {
  const selected = forum('111', 'weekend-plans');
  const board = textChannel('222', 'announcements');
  const { guild, client } = server('one', selected, board, forum('333', 'events'));
  expect(await buildContext(client, config, guild, setup))
    .toMatchObject({ guild, forum: selected, digestChannel: board });
});

test('both channels must exist in this guild with the correct types', async () => {
  const { guild, client } = server('one', forum('111'), textChannel('222'));
  for (const invalid of [
    { ...setup, forumId: 'other-server' },
    { ...setup, digestChannelId: 'missing' },
    { forumId: '222', digestChannelId: '111' },
  ]) {
    expect(await buildContext(client, config, guild, invalid)).toMatch(/`\/setup/);
  }
});

test('checks forum permissions and requires Pin Messages in the digest channel', async () => {
  const selected = forum('111');
  const board = textChannel('222');
  const { guild, client } = server('one', selected, board);
  vi.spyOn(selected, 'permissionsFor').mockReturnValue(new PermissionsBitField());
  expect(await buildContext(client, config, guild, setup)).toMatch(/Manage Threads/);
  vi.mocked(selected.permissionsFor).mockReturnValue(new PermissionsBitField(PermissionsBitField.All));
  vi.spyOn(board, 'permissionsFor').mockReturnValue(new PermissionsBitField(PermissionsBitField.All)
    .remove([PermissionFlagsBits.Administrator, PermissionFlagsBits.PinMessages]));
  expect(await buildContext(client, config, guild, setup)).toMatch(/Pin Messages/);
});

test('setup persists across new context stores and stays isolated by guild', async () => {
  const first = server('one', forum('111'), textChannel('222'));
  const second = server('two', forum('333'), textChannel('444'));
  first.client.guilds.cache.set(second.guild.id, second.guild);
  const database = createDatabase();
  const contexts = createContexts(first.client, config, database);
  expect(contexts.get('one')).toBe(SETUP_REQUIRED);
  expect(await contexts.configure(first.guild, setup)).toMatchObject({ forum: { id: '111' } });
  expect(contexts.get('two')).toBe(SETUP_REQUIRED);
  await contexts.configure(second.guild, { forumId: '333', digestChannelId: '444' });

  const restarted = createContexts(first.client, config, database);
  await Promise.all([restarted.refresh(first.guild), restarted.refresh(second.guild)]);
  expect(restarted.get('one')).toMatchObject({ forum: { id: '111' }, digestChannel: { id: '222' } });
  expect(restarted.get('two')).toMatchObject({ forum: { id: '333' }, digestChannel: { id: '444' } });
});

test('imports a previous pinned setup once, then restores it from SQLite', async () => {
  const board = textChannel('222');
  const { guild, client } = server('one', forum('111'), board);
  const legacyPin = await board.send({ embeds: [new EmbedBuilder()
    .setFooter({ text: 'GrassToucher · setup' })
    .addFields(
      { name: 'Forum', value: '<#111>' },
      { name: 'Digest', value: '<#222>' },
    )] });
  await legacyPin.pin();

  const database = createDatabase();
  const first = createContexts(client, config, database);
  await first.refresh(guild);
  expect(first.get(guild.id)).toMatchObject({ forum: { id: '111' }, digestChannel: { id: '222' } });
  expect(database.getGuildSetup(guild.id)).toEqual(setup);
  expect(legacyPin.unpin).toHaveBeenCalledOnce();

  const pinScans = vi.mocked(board.messages.fetchPins).mock.calls.length;
  const restarted = createContexts(client, config, database);
  await restarted.refresh(guild);
  expect(restarted.get(guild.id)).toMatchObject({ forum: { id: '111' }, digestChannel: { id: '222' } });
  expect(board.messages.fetchPins).toHaveBeenCalledTimes(pinScans);
});

test('reconfiguration takes effect immediately and survives a restart', async () => {
  const oldBoard = textChannel('222');
  const newBoard = textChannel('444');
  const { guild, client } = server('one', forum('111'), oldBoard, forum('333'), newBoard);
  const database = createDatabase();
  const contexts = createContexts(client, config, database);
  await contexts.configure(guild, setup);
  await contexts.configure(guild, { forumId: '333', digestChannelId: '444' });
  expect(contexts.get('one')).toMatchObject({ forum: { id: '333' }, digestChannel: newBoard });
  const restarted = createContexts(client, config, database);
  await restarted.refresh(guild);
  expect(restarted.get('one')).toMatchObject({ forum: { id: '333' }, digestChannel: newBoard });
});

test('failed persistence cannot enable commands or replace a working setup', async () => {
  const { guild, client } = server('one', forum('111'), textChannel('222'), forum('333'));
  const database = createDatabase();
  const contexts = createContexts(client, config, database);
  vi.spyOn(database, 'saveGuildSetup').mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  await expect(contexts.configure(guild, setup)).rejects.toThrow('disk full');
  expect(contexts.get('one')).toBe(SETUP_REQUIRED);
  await contexts.configure(guild, setup);
  const previous = contexts.get('one');
  vi.mocked(database.saveGuildSetup).mockImplementationOnce(() => {
    throw new Error('disk full');
  });
  await expect(contexts.configure(guild, { forumId: '333', digestChannelId: '222' }))
    .rejects.toThrow('disk full');
  expect(contexts.get('one')).toBe(previous);
});

test('a deleted configured channel blocks commands until setup is repaired', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { guild, client, channels } = server('one', forum('111'), textChannel('222'), forum('333'));
  const contexts = createContexts(client, config, createDatabase());
  await contexts.configure(guild, setup);
  channels.delete('111');
  contexts.invalidate(guild.id);
  await contexts.refresh(guild);
  expect(contexts.get('one')).toMatch(/missing.*wrong type/);
  await contexts.configure(guild, { ...setup, forumId: '333' });
  expect(contexts.get('one')).toMatchObject({ forum: { id: '333' } });
});

test.each(['success', 'failure'] as const)(
  'invalidation rejects a stale refresh %s and preserves the follow-up fetch',
  async (outcome) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { guild, client, channels } = server('one', forum('111'), textChannel('222'));
    const contexts = createContexts(client, config, createDatabase());
    await contexts.configure(guild, setup);

    const staleChannels = channels.clone();
    const staleFetch = Promise.withResolvers<typeof channels>();
    const staleStarted = Promise.withResolvers<void>();
    const freshFetch = Promise.withResolvers<typeof channels>();
    const freshStarted = Promise.withResolvers<void>();
    vi.mocked(guild.channels.fetch).mockClear()
      .mockImplementationOnce(async () => {
        staleStarted.resolve();
        return staleFetch.promise;
      })
      .mockImplementationOnce(async () => {
        freshStarted.resolve();
        return freshFetch.promise;
      });

    const first = contexts.refresh(guild);
    await staleStarted.promise;
    channels.delete('111');
    expect(contexts.invalidate(guild.id, '111')).toBe(true);
    const followUp = contexts.refresh(guild);
    if (outcome === 'success') staleFetch.resolve(staleChannels);
    else staleFetch.reject(new Error('stale request failed'));
    await first;
    await freshStarted.promise;

    // Even while the fresh fetch is pending, the old result must not reopen command access.
    expect(contexts.get(guild.id)).toBe(SETUP_REQUIRED);
    expect(guild.channels.fetch).toHaveBeenCalledTimes(2);
    freshFetch.resolve(channels);
    await followUp;
    expect(contexts.get(guild.id)).toMatch(/missing.*wrong type/);
  },
);

test('unrelated channel changes leave configured access and pending recovery alone', async () => {
  const { guild, client } = server('one', forum('111'), textChannel('222'), textChannel('444'));
  const contexts = createContexts(client, config, createDatabase());
  await contexts.configure(guild, setup);
  const previous = contexts.get(guild.id);
  vi.mocked(guild.channels.fetch).mockClear();

  for (let i = 0; i < 10; i++) expect(contexts.invalidate(guild.id, '444')).toBe(false);
  expect(contexts.get(guild.id)).toBe(previous);
  expect(guild.channels.fetch).not.toHaveBeenCalled();

  expect(contexts.invalidate(guild.id, '111')).toBe(true);
  expect(contexts.invalidate(guild.id, '444')).toBe(false);
  expect(contexts.get(guild.id)).toBe(SETUP_REQUIRED);
});

test.each(['111', '222', 'forum-category', 'digest-category'])(
  'changes to selected channels or their categories invalidate setup: %s',
  async (channelId) => {
    const selected = Object.assign(forum('111'), { parentId: 'forum-category' });
    const board = Object.assign(textChannel('222'), { parentId: 'digest-category' });
    const { guild, client } = server('one', selected, board);
    const database = createDatabase();
    database.saveGuildSetup(guild.id, setup);
    const contexts = createContexts(client, config, database);

    // Stored selections must be recognised before startup has finished loading a context.
    expect(contexts.invalidate(guild.id, channelId)).toBe(true);
    await contexts.refresh(guild);
    expect(contexts.get(guild.id)).toMatchObject({ forum: selected, digestChannel: board });
    expect(contexts.invalidate(guild.id, channelId)).toBe(true);
    expect(contexts.get(guild.id)).toBe(SETUP_REQUIRED);
  },
);

test('a candidate channel changed during setup cannot replace the stored selection', async () => {
  const { guild, client, channels } = server('one', forum('111'), textChannel('222'), forum('333'));
  const database = createDatabase();
  const contexts = createContexts(client, config, database);
  await contexts.configure(guild, setup);
  const save = vi.spyOn(database, 'saveGuildSetup');
  const staleChannels = channels.clone();
  const pendingFetch = Promise.withResolvers<typeof channels>();
  const started = Promise.withResolvers<void>();
  vi.mocked(guild.channels.fetch).mockImplementationOnce(async () => {
    started.resolve();
    return pendingFetch.promise;
  });

  const configuring = contexts.configure(guild, { ...setup, forumId: '333' });
  await started.promise;
  channels.delete('333');
  expect(contexts.invalidate(guild.id, '333')).toBe(true);
  const recovery = contexts.refresh(guild);
  pendingFetch.resolve(staleChannels);

  expect(await configuring).toMatch(/changed during setup/);
  expect(save).not.toHaveBeenCalled();
  expect(database.getGuildSetup(guild.id)).toEqual(setup);
  await recovery;
  expect(contexts.get(guild.id)).toMatchObject({ forum: { id: '111' } });
});

test('a refresh racing setup cannot restore the previous configuration', async () => {
  const { guild, client } = server('one', forum('111'), textChannel('222'), forum('333'), textChannel('444'));
  const contexts = createContexts(client, config, createDatabase());
  await contexts.configure(guild, setup);
  await Promise.all([
    contexts.refresh(guild),
    contexts.configure(guild, { forumId: '333', digestChannelId: '444' }),
    contexts.refresh(guild),
  ]);
  expect(contexts.get('one')).toMatchObject({ forum: { id: '333' }, digestChannel: { id: '444' } });
  contexts.remove(guild.id);
  expect(contexts.get('one')).toBe(SETUP_REQUIRED);
});

test('an unavailable guild does not scan pins and a removed guild cannot restore its context', async () => {
  const { guild, client } = server('one', forum('111'), textChannel('222'));
  const contexts = createContexts(client, config, createDatabase());
  Object.assign(guild, { available: false });
  await contexts.refresh(guild);
  expect(contexts.get('one')).toMatch(/temporarily unavailable/);
  expect(guild.channels.fetch).not.toHaveBeenCalled();
  client.guilds.cache.delete(guild.id);
  contexts.remove(guild.id);
  await contexts.refresh(guild);
  expect(await contexts.configure(guild, setup)).toBe(SETUP_REQUIRED);
  expect(contexts.get('one')).toBe(SETUP_REQUIRED);
  expect(guild.channels.fetch).not.toHaveBeenCalled();
});
