import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { openGuildDatabase } from '../src/database.ts';
import { loadLegacySetup, readSetup, retireLegacySetup } from '../src/setup.ts';
import { forum, server, textChannel } from './helpers/discord.ts';

afterEach(() => vi.restoreAllMocks());

async function pinLegacySetup(board: ReturnType<typeof textChannel>, forumId: string, digestId: string) {
  const message = await board.send({ embeds: [new EmbedBuilder()
    .setFooter({ text: 'GrassToucher · setup' })
    .addFields(
      { name: 'Forum', value: `<#${forumId}>` },
      { name: 'Digest', value: `<#${digestId}>` },
    )] });
  await message.pin();
  return message;
}

test('reads only a bot-authored, complete legacy setup record in its digest channel', async () => {
  const board = textChannel('222');
  const { guild } = server('one', forum('111'), board);
  const valid = await pinLegacySetup(board, '111', '222');
  expect(readSetup(valid, 'bot')).toEqual({ forumId: '111', digestChannelId: '222' });

  const forged = await pinLegacySetup(board, '111', '222');
  Object.assign(forged, { author: { id: 'someone-else' } });
  expect(readSetup(forged, 'bot')).toBeNull();
  expect(await loadLegacySetup(guild, 'bot')).toEqual({
    setup: { forumId: '111', digestChannelId: '222' },
    records: [valid],
  });
});

test('chooses the newest legacy setup and retires all setup pins after migration', async () => {
  const firstBoard = textChannel('222');
  const secondBoard = textChannel('444');
  const { guild } = server('one', firstBoard, secondBoard);
  const old = await pinLegacySetup(firstBoard, '111', '222');
  const current = await pinLegacySetup(secondBoard, '333', '444');

  const legacy = await loadLegacySetup(guild, 'bot');
  expect(legacy?.setup).toEqual({ forumId: '333', digestChannelId: '444' });
  expect(legacy?.records).toEqual([old, current]);
  await retireLegacySetup(guild, legacy?.records ?? []);
  expect(old.unpin).toHaveBeenCalledOnce();
  expect(current.unpin).toHaveBeenCalledOnce();
});

test('loads a legacy setup record beyond the first page of pins', async () => {
  const board = textChannel('222');
  const { guild } = server('one', board);
  const valid = await pinLegacySetup(board, '111', '222');
  const unrelated = await board.send({ embeds: [new EmbedBuilder().setTitle('Other pin')] });
  const before = new Date('2026-01-01');
  vi.mocked(board.messages.fetchPins)
    .mockResolvedValueOnce({ hasMore: true, items: [{ message: unrelated, pinnedAt: before, pinnedTimestamp: +before }] })
    .mockResolvedValueOnce({ hasMore: false, items: [{ message: valid, pinnedAt: before, pinnedTimestamp: +before }] });

  expect((await loadLegacySetup(guild, 'bot'))?.setup)
    .toEqual({ forumId: '111', digestChannelId: '222' });
  expect(board.messages.fetchPins).toHaveBeenLastCalledWith({ limit: 50, before });
});

test('skips unreadable channels and surfaces pin fetch errors instead of guessing', async () => {
  const inaccessible = textChannel('444');
  const board = textChannel('222');
  const { guild } = server('one', board, inaccessible);
  vi.spyOn(inaccessible, 'permissionsFor').mockReturnValue(new PermissionsBitField());
  expect(await loadLegacySetup(guild, 'bot')).toBeNull();
  expect(inaccessible.messages.fetchPins).not.toHaveBeenCalled();
  vi.mocked(board.messages.fetchPins).mockRejectedValueOnce(new Error('Discord unavailable'));
  await expect(loadLegacySetup(guild, 'bot')).rejects.toThrow('Discord unavailable');
});

test('SQLite stores one row per guild and keeps setup after closing and reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'grasstoucher-'));
  const path = join(directory, 'state.sqlite');
  try {
    const database = openGuildDatabase(path);
    database.saveGuildSetup('guild-one', { forumId: '111', digestChannelId: '222' });
    database.saveGuildSetup('guild-two', { forumId: '333', digestChannelId: '444' });
    database.saveGuildSetup('guild-one', { forumId: '555', digestChannelId: '666' });
    database.close();

    const reopened = openGuildDatabase(path);
    expect(reopened.getGuildSetup('guild-one'))
      .toEqual({ forumId: '555', digestChannelId: '666' });
    expect(reopened.getGuildSetup('guild-two'))
      .toEqual({ forumId: '333', digestChannelId: '444' });
    expect(reopened.getGuildSetup('missing')).toBeNull();
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
