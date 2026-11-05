import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Guild, Message, TextChannel } from 'discord.js';
import { MARKER } from './event.ts';
import type { GuildSetup } from './types/setup.ts';
import { tryCatch } from './utils/tryCatch.ts';

export const SETUP_REQUIRED =
  'This server is not set up. Ask someone with Manage Server to run `/setup forum: digest:`.';

const SETUP_FOOTER = `${MARKER} · setup`;

/** Only our own complete records count; old digests and user-written lookalikes do not. */
export function readSetup(message: Message, clientUserId: string): GuildSetup | null {
  const embed = message.embeds[0];
  if (message.author.id !== clientUserId || embed?.footer?.text !== SETUP_FOOTER) return null;
  const id = (name: string) =>
    /^<#(\d{1,20})>$/.exec(embed.fields.find((field) => field.name === name)?.value ?? '')?.[1];
  const forumId = id('Forum');
  const digestChannelId = id('Digest');
  if (!forumId || !digestChannelId || digestChannelId !== message.channelId) return null;
  return { forumId, digestChannelId };
}

async function setupRecords(guild: Guild, clientUserId: string): Promise<Message[]> {
  const channels = await guild.channels.fetch();
  const readable = channels.filter(
    (channel): channel is TextChannel =>
      channel?.type === ChannelType.GuildText &&
      (channel.permissionsFor(clientUserId)?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
      ]) ?? false),
  );
  const records = await Promise.all([...readable.values()].map(async (channel) => {
    const found: Message[] = [];
    let before: Date | undefined;
    // Pins are paginated too. A busy board must not forget setup when its pin drops off page one.
    while (true) {
      const page = await channel.messages.fetchPins({ limit: 50, before });
      for (const { message } of page.items) {
        if (readSetup(message, clientUserId)) found.push(message);
      }
      if (!page.hasMore || !page.items.length) break;
      before = page.items[page.items.length - 1].pinnedAt;
    }
    return found;
  }));
  return records.flat();
}

/** Read the old Discord-backed record once when upgrading to SQLite. */
export async function loadLegacySetup(
  guild: Guild,
  clientUserId: string,
): Promise<{ setup: GuildSetup; records: Message[] } | null> {
  const records = await setupRecords(guild, clientUserId);
  const latest = records.reduce<Message | null>(
    (best, message) => !best || BigInt(message.id) > BigInt(best.id) ? message : best,
    null,
  );
  const setup = latest ? readSetup(latest, clientUserId) : null;
  return setup ? { setup, records } : null;
}

/** A migrated row is authoritative; remove the old pins best-effort to avoid stale fallbacks. */
export async function retireLegacySetup(guild: Guild, records: Message[]): Promise<void> {
  for (const record of records) {
    const { error } = await tryCatch(record.unpin());
    if (error) console.error(`[${guild.id}] Could not unpin migrated setup:`, error);
  }
}
