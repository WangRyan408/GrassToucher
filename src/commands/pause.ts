import { MessageFlags, TimestampStyles, time } from 'discord.js';
import type { ChatInputCommandInteraction, SlashCommandSubcommandBuilder } from 'discord.js';
import { rebuildDigest } from '../digest.ts';
import { ensureOpen, threadName, toEmbed } from '../event.ts';
import type { Ctx } from '../types/config.ts';
import { content, ephemeral, resolveEvent } from './shared.ts';

export const pauseSubcommand = (sub: SlashCommandSubcommandBuilder) =>
  sub
    .setName('pause')
    .setDescription("Temporarily hide this event from the digest (run inside its thread)")
    .addStringOption((o) =>
      o
        .setName('duration')
        .setDescription('How long to hide it — e.g. 30m, 2h, 3d or 1 week')
        .setRequired(true)
        .setMaxLength(100),
    );

function pauseDeadline(input: string): Date | null {
  // Match the whole input so a typo cannot silently shorten the requested pause.
  const match = /^(\d+(?:\.\d+)?)\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)$/i.exec(input.trim());
  if (!match) return null;
  const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const duration = Number(match[1]) * units[match[2][0].toLowerCase()];
  const deadline = new Date(Date.now() + duration);
  return duration > 0 && Number.isSafeInteger(duration) && Number.isFinite(deadline.getTime())
    ? deadline
    : null;
}

export async function handlePause(interaction: ChatInputCommandInteraction, ctx: Ctx) {
  const found = await resolveEvent(interaction, ctx, 'pause');
  if (typeof found === 'string') return interaction.reply(ephemeral(found));
  const pausedUntil = pauseDeadline(interaction.options.getString('duration', true));
  if (!pausedUntil) {
    return interaction.reply(ephemeral('Use a positive duration such as `30m`, `2h`, `3d` or `1 week`.'));
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const { thread, message, event } = found;
  event.pausedUntil = pausedUntil;
  await ensureOpen(thread);
  await message.edit({ embeds: [toEmbed(event)] });
  // Renames have a tighter rate limit; hiding the entry must not wait on its status dot.
  await rebuildDigest(ctx);
  const name = threadName(event);
  if (thread.name !== name) await thread.setName(name);

  return interaction.editReply(content(
    `Paused until ${time(pausedUntil, TimestampStyles.FullDateShortTime)} ` +
      `(${time(pausedUntil, TimestampStyles.RelativeTime)}). ` +
      'Hidden from the digest during this pause.',
  ));
}
