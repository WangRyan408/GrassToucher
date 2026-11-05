import {
  ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType,
  ChannelType, Collection, InteractionContextType, MessageFlags, PermissionFlagsBits, PermissionsBitField,
} from 'discord.js';
import type { AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction, Guild, Interaction } from 'discord.js';
import { afterEach, expect, test, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { commands, removeGuildCommands, route } from '../src/interactions.ts';
import { SETUP_REQUIRED } from '../src/setup.ts';
import type { Ctx } from '../src/types/config.ts';
import type { GuildContexts } from '../src/types/setup.ts';
import { forum, server, textChannel } from './helpers/discord.ts';

const config = loadConfig({ DISCORD_TOKEN: 'test-token' });
afterEach(() => vi.restoreAllMocks());

function interaction(guildId: string | null, commandName = 'event', subcommand = 'create') {
  const values: Record<string, string> = { title: 'Walk', when: '2999-01-01 19:00' };
  return {
    guildId, commandName, guild: { id: guildId }, user: { id: 'organizer' },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string) => values[name] ?? null,
      getChannel: (name: string) => ({ id: name === 'forum' ? '111' : '222' }),
    },
    isAutocomplete: () => false,
    isChatInputCommand: () => true,
    isButton: () => false,
    inGuild: () => guildId !== null,
    reply: vi.fn(), deferReply: vi.fn(), editReply: vi.fn(),
  } as unknown as ChatInputCommandInteraction;
}

function context(guildId: string): Ctx {
  const selected = forum(`${guildId}-forum`);
  const board = textChannel(`${guildId}-digest`);
  const { client, guild } = server(guildId, selected, board);
  return { client, config, guild, forum: selected, digestChannel: board };
}

function controls(get: (id: string) => Ctx | string = () => SETUP_REQUIRED): GuildContexts {
  return {
    get: vi.fn(get), configure: vi.fn<GuildContexts['configure']>(),
    refresh: vi.fn(), invalidate: vi.fn(() => true), remove: vi.fn(),
  };
}

test('global setup requires both typed channel choices and Manage Server', () => {
  for (const command of commands) {
    expect(command.contexts).toEqual([InteractionContextType.Guild]);
    expect(command.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
  }
  const setup = commands.find((command) => command.name === 'setup')!;
  expect(setup.default_member_permissions).toBe(String(PermissionFlagsBits.ManageGuild));
  expect(setup.options).toEqual([
    expect.objectContaining({ name: 'forum', type: ApplicationCommandOptionType.Channel,
      channel_types: [ChannelType.GuildForum], required: true }),
    expect.objectContaining({ name: 'digest', type: ApplicationCommandOptionType.Channel,
      channel_types: [ChannelType.GuildText], required: true }),
  ]);
  expect(commands.find((command) => command.name === 'event')!.default_member_permissions).toBeUndefined();
});

test('each configured server creates events and updates its own digest', async () => {
  const one = context('one');
  const two = context('two');
  const contexts = controls((id) => id === 'one' ? one : two);
  const first = interaction('one');
  const second = interaction('two');
  await route(first, config, contexts);
  expect(one.forum.threads.create).toHaveBeenCalledOnce();
  expect(one.digestChannel.send).toHaveBeenCalledOnce();
  expect(two.forum.threads.create).not.toHaveBeenCalled();
  expect(two.digestChannel.send).not.toHaveBeenCalled();
  await route(second, config, contexts);
  expect(two.forum.threads.create).toHaveBeenCalledOnce();
  expect(two.digestChannel.send).toHaveBeenCalledOnce();
  expect(second.editReply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('<#two-forum-post>'),
  }));
});

test.each(['create', 'edit', 'cancel'])('%s is blocked until both channels are configured', async (subcommand) => {
  const command = interaction('unconfigured', 'event', subcommand);
  await route(command, config, controls());
  expect(command.reply).toHaveBeenCalledWith({ content: SETUP_REQUIRED, flags: MessageFlags.Ephemeral });
  expect(command.deferReply).not.toHaveBeenCalled();
});

test.each(['rsvp:going', 'cancel'])('button %s is also blocked before setup', async (customId) => {
  const button = {
    ...interaction('unconfigured'), customId,
    isChatInputCommand: () => false, isButton: () => true,
  } as unknown as ButtonInteraction;
  await route(button, config, controls());
  expect(button.reply).toHaveBeenCalledWith({ content: SETUP_REQUIRED, flags: MessageFlags.Ephemeral });
});

test('setup can run before any context exists and immediately creates the digest', async () => {
  const command = interaction('one', 'setup');
  const contexts = controls();
  const ctx = context('one');
  vi.mocked(contexts.configure).mockResolvedValue(ctx);
  await route(command, config, contexts);
  expect(contexts.get).not.toHaveBeenCalled();
  expect(contexts.configure).toHaveBeenCalledWith(command.guild, { forumId: '111', digestChannelId: '222' });
  expect(command.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(ctx.digestChannel.send).toHaveBeenCalledOnce();
  expect(command.editReply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('Setup saved'),
  }));
});

test('runtime authorization prevents users without Manage Server from changing setup', async () => {
  const command = interaction('one', 'setup');
  Object.assign(command, { memberPermissions: new PermissionsBitField() });
  const contexts = controls();
  await route(command, config, contexts);
  expect(contexts.configure).not.toHaveBeenCalled();
  expect(command.reply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('Manage Server'), flags: MessageFlags.Ephemeral,
  }));
});

test('failed setup reports the problem without claiming success', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const command = interaction('one', 'setup');
  const contexts = controls();
  vi.mocked(contexts.configure).mockRejectedValue(new Error('pin failed'));
  await route(command, config, contexts);
  expect(command.editReply).toHaveBeenCalledWith(expect.objectContaining({
    content: expect.stringContaining('Setup could not be saved'),
  }));
});

test('refuses a context from another guild', async () => {
  const wrong = context('one');
  const command = interaction('two');
  await route(command, config, controls(() => wrong));
  expect(wrong.forum.threads.create).not.toHaveBeenCalled();
  expect(command.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('this server') }));
});

test.each(['event', 'setup'])('%s refuses DMs without resolving a context', async (name) => {
  const command = interaction(null, name);
  const contexts = controls();
  await route(command, config, contexts);
  expect(contexts.get).not.toHaveBeenCalled();
  expect(contexts.configure).not.toHaveBeenCalled();
  expect(command.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('in a server') }));
});

test('autocomplete stays empty before setup and resumes after setup', async () => {
  const command = {
    guildId: 'one', commandName: 'event', isAutocomplete: () => true, inGuild: () => true,
    options: { getFocused: () => ({ name: 'timezone', value: 'Berlin' }) }, respond: vi.fn(),
  } as unknown as AutocompleteInteraction;
  await route(command, config, controls());
  expect(command.respond).toHaveBeenLastCalledWith([]);
  await route(command, config, controls(() => context('one')));
  expect(command.respond).toHaveBeenLastCalledWith(expect.arrayContaining([
    expect.objectContaining({ value: 'Europe/Berlin' }),
  ]));
});

test('ignores interactions owned by other commands', async () => {
  const contexts = controls();
  await route(interaction('one', 'other') as Interaction, config, contexts);
  expect(contexts.get).not.toHaveBeenCalled();
});

test('removes only legacy guild slash commands that shadow the global definitions', async () => {
  const legacy = { name: 'event', type: ApplicationCommandType.ChatInput, delete: vi.fn() };
  const other = { name: 'other', type: ApplicationCommandType.ChatInput, delete: vi.fn() };
  const contextMenu = { name: 'event', type: ApplicationCommandType.Message, delete: vi.fn() };
  const guild = {
    commands: { fetch: vi.fn(async () => new Collection([['1', legacy], ['2', other], ['3', contextMenu]])) },
  } as unknown as Guild;
  await removeGuildCommands(guild);
  expect(legacy.delete).toHaveBeenCalledOnce();
  expect(other.delete).not.toHaveBeenCalled();
  expect(contextMenu.delete).not.toHaveBeenCalled();
});
