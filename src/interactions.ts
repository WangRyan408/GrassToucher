/**
 * The interaction router: assembles `/event` out of `src/commands/`, and owns the two
 * interactions that belong to no single command — the RSVP buttons and autocomplete.
 *
 * Wiring is explicit rather than a name → handler registry. There are only a few subcommands, and
 * an if-chain reads better than a lookup table plus the ceremony of registering into it.
 */
import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';
import type { AutocompleteInteraction, ButtonInteraction, Guild, Interaction } from 'discord.js';
import { CANCEL_ID, cancelSubcommand, handleCancel, handleCancelConfirm } from './commands/cancel.ts';
import { createSubcommand, handleCreate } from './commands/create.ts';
import { editSubcommand, handleEdit } from './commands/edit.ts';
import { handlePause, pauseSubcommand } from './commands/pause.ts';
import { handleSetup, setupCommand } from './commands/setup.ts';
import { ephemeral } from './commands/shared.ts';
import { rebuildDigest } from './digest.ts';
import { CHOICES, applyRsvp, ensureOpen, fromEmbed, isOurs, rsvpRow, toEmbed } from './event.ts';
import { searchPlaces } from './places.ts';
import { resolveTimeZone, searchTimeZones, searchWhen } from './time.ts';
import type { Config, Ctx } from './types/config.ts';
import type { RsvpChoice } from './types/event.ts';
import type { GuildContexts } from './types/setup.ts';
import { tryCatch } from './utils/tryCatch.ts';

export const commands = [
  new SlashCommandBuilder()
    .setName('event')
    .setDescription('Create and manage events')
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
    .addSubcommand(createSubcommand)
    .addSubcommand(editSubcommand)
    .addSubcommand(cancelSubcommand)
    .addSubcommand(pauseSubcommand)
    .toJSON(),
  setupCommand,
];

/** A previous single-guild install registered these locally, which can hide global updates. */
export async function removeGuildCommands(guild: Guild): Promise<void> {
  const registered = await guild.commands.fetch();
  for (const command of registered.values()) {
    if (
      command.type === ApplicationCommandType.ChatInput &&
      commands.some((c) => c.name === command.name)
    ) {
      await command.delete();
    }
  }
}

/** `hasOwn`, not `in`: the prototype chain would answer yes to a custom id of `rsvp:toString`. */
const isChoice = (value: string): value is RsvpChoice => Object.hasOwn(CHOICES, value);

/**
 * ponytail: two people clicking at the same instant can have one write win, losing the
 * other RSVP. Discord offers no compare-and-swap on message edits and a re-click fixes
 * it, so this stays unguarded.
 */
async function handleRsvp(interaction: ButtonInteraction, ctx: Ctx) {
  if (!interaction.channel?.isThread() || interaction.channel.parentId !== ctx.forum.id) {
    return interaction.reply(ephemeral("Run this inside the event's thread."));
  }
  const choice = interaction.customId.split(':')[1];
  if (!isChoice(choice)) return;
  if (!isOurs(interaction.message, ctx.client.user.id)) return;

  const event = fromEmbed(interaction.message.embeds[0]);
  // Cancelling strips the buttons, but a stale client can still send the click — and
  // answering it would put the whole row back on a cancelled event.
  if (event.cancelled) return interaction.reply(ephemeral('That event was cancelled.'));

  const result = applyRsvp(event, interaction.user.id, choice);

  // Nothing moved, so skip the message edit and the digest rebuild — but still answer, or
  // Discord shows the click as failed.
  if (result === 'unchanged') {
    return interaction.reply(
      ephemeral(`Your answer is already **${CHOICES[choice].label}**. Pick another button to change it.`),
    );
  }

  if (result === 'full') {
    return interaction.reply(
      ephemeral(`The ${CHOICES[choice].label} list is full. Ask the organizer to make space.`),
    );
  }

  if (interaction.channel?.isThread()) await ensureOpen(interaction.channel);
  // The visibly-updated list is the confirmation, so one API call does the whole job.
  await interaction.update({ embeds: [toEmbed(event)], components: [rsvpRow()] });
  await rebuildDigest(ctx);
}

/**
 * Suggest times while someone types `when:`, addresses for `where:`, and zones for `timezone:`.
 *
 * Routed on the option name, not the subcommand: create and edit spell all three identically,
 * and one dispatch here beats the same branches in both command files.
 *
 * Owns its error handling, unlike every other handler here: an autocomplete interaction is
 * not repliable, so index.ts's catch-all can't answer one, and an unanswered interaction
 * leaves "loading options failed" sitting in the client. Every failure is an empty list.
 *
 * Still a try/catch rather than a `tryCatch`: `getFocused(true)` throws *synchronously*, and
 * tryCatch only wraps a promise.
 */
async function handleAutocomplete(interaction: AutocompleteInteraction, config: Config) {
  try {
    const focused = interaction.options.getFocused(true); // Throws with nothing focused.
    if (focused.name === 'timezone') {
      // No await on the search itself: the zone list is in-process.
      return interaction.respond(searchTimeZones(focused.value, config.defaultTz));
    }
    if (focused.name === 'when') {
      // Half-typed sibling options come through on an autocomplete interaction, so a zone already
      // chosen renders the preview in it. Filled the other way round, `when:` first and
      // `timezone:` after, the choice's stored wall clock still means what it says — only the
      // preview was drawn in the default zone, which is why the label names the zone it used.
      const requested = interaction.options.getString('timezone')?.trim();
      const tz = (requested && resolveTimeZone(requested)) || config.defaultTz;
      return interaction.respond(searchWhen(focused.value, tz));
    }
    if (focused.name !== 'where') return interaction.respond([]);
    await interaction.respond(await searchPlaces(focused.value, config.placeBias));
  } catch (error) {
    console.error('Autocomplete failed:', error);
    // May itself throw if the respond above already landed; nothing left to do either way.
    await tryCatch(interaction.respond([]));
  }
}

export async function route(
  interaction: Interaction,
  config: Config,
  contexts: GuildContexts,
) {
  // First: this fires on every keystroke, so it's the busiest branch by a wide margin.
  // Autocomplete cannot show an ephemeral error; keep it empty until setup is complete. The
  // cached check also avoids racing a Discord fetch against the autocomplete deadline.
  if (interaction.isAutocomplete()) {
    if (interaction.commandName !== 'event') return;
    if (!interaction.inGuild()) return interaction.respond([]);
    const ctx = contexts.get(interaction.guildId);
    if (typeof ctx === 'string' || ctx.guild.id !== interaction.guildId) return interaction.respond([]);
    return handleAutocomplete(interaction, config);
  }

  const isCommand = interaction.isChatInputCommand() &&
    (interaction.commandName === 'event' || interaction.commandName === 'setup');
  const isButton = interaction.isButton() && (
    interaction.customId === CANCEL_ID || interaction.customId.startsWith('rsvp:')
  );
  if (!isCommand && !isButton) return;
  if (!interaction.inGuild()) {
    return interaction.reply(ephemeral('Use this command in a server with an event forum.'));
  }
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
    return handleSetup(interaction, contexts);
  }
  const ctx = contexts.get(interaction.guildId);
  if (typeof ctx === 'string') return interaction.reply(ephemeral(ctx));
  if (ctx.guild.id !== interaction.guildId) {
    return interaction.reply(ephemeral('I could not load this server\'s event forum.'));
  }

  if (interaction.isChatInputCommand() && interaction.commandName === 'event') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'create') return handleCreate(interaction, ctx);
    if (sub === 'edit') return handleEdit(interaction, ctx);
    if (sub === 'cancel') return handleCancel(interaction, ctx);
    if (sub === 'pause') return handlePause(interaction, ctx);
    return;
  }
  if (interaction.isButton()) {
    if (interaction.customId === CANCEL_ID) return handleCancelConfirm(interaction, ctx);
    if (interaction.customId.startsWith('rsvp:')) return handleRsvp(interaction, ctx);
  }
}
