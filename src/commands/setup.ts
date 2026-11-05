import {
  ApplicationIntegrationType,
  ChannelType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { ChatInputCommandInteraction } from 'discord.js';
import { rebuildDigest } from '../digest.ts';
import type { GuildContexts } from '../types/setup.ts';
import { tryCatch } from '../utils/tryCatch.ts';
import { content, ephemeral } from './shared.ts';

export const setupCommand = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Set the event forum and digest channel for this server')
  .setContexts(InteractionContextType.Guild)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addChannelOption((option) => option
    .setName('forum')
    .setDescription('Forum channel where event posts belong')
    .addChannelTypes(ChannelType.GuildForum)
    .setRequired(true))
  .addChannelOption((option) => option
    .setName('digest')
    .setDescription('Text channel for the pinned event digest')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(true))
  .toJSON();

export async function handleSetup(interaction: ChatInputCommandInteraction, contexts: GuildContexts) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    return interaction.reply(ephemeral('You need Manage Server to configure the bot.'));
  }
  const guild = interaction.guild;
  if (!guild) return interaction.reply(ephemeral('I could not load this server. Try again later.'));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { data: ctx, error } = await tryCatch(contexts.configure(guild, {
    forumId: interaction.options.getChannel('forum', true).id,
    digestChannelId: interaction.options.getChannel('digest', true).id,
  }));
  if (error) {
    console.error(`[${guild.id}] Setup failed:`, error);
    return interaction.editReply(content(
      'Setup could not be saved. Check my permissions and the bot logs, then try `/setup` again.',
    ));
  }
  if (typeof ctx === 'string') return interaction.editReply(content(ctx));

  const refresh = await tryCatch(rebuildDigest(ctx));
  if (refresh.error) console.error(`[${guild.id}] Initial digest failed:`, refresh.error);
  return interaction.editReply(content(
    `Setup saved. Events will use <#${ctx.forum.id}> and the digest will use <#${ctx.digestChannel.id}>.` +
      (refresh.error ? ' The first digest refresh failed; check the bot logs and permissions.' : ''),
  ));
}
