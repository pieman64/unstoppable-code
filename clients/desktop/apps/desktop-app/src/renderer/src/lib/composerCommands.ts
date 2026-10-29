import type { SlashCommandData } from '@canopy/desktop-shared/types';
import type { SlashCommandOption } from '@canopy/ui-rich/types';

export const COMPOSER_ACTIONS = {
  plugins: 'Choose plugins and skills for this chat',
  attach: 'Add an attachment to the draft',
  workspace: 'Choose the parent workspace',
  model: 'Choose the model for this chat',
  thinking: 'Cycle the thinking level',
  plan: 'Toggle plan mode',
  fast: 'Cycle the Codex speed',
  schedule: 'Schedule this message',
  pipeline: 'Prepare a pipeline task',
  commands: 'Browse all commands',
  help: 'Browse all commands',
} as const;
export type ComposerAction = keyof typeof COMPOSER_ACTIONS;
export type ComposerCommand = SlashCommandData &
  SlashCommandOption & { composerAction?: ComposerAction };

function isComposerAction(value: string): value is ComposerAction {
  return Object.prototype.hasOwnProperty.call(COMPOSER_ACTIONS, value);
}

export function getComposerAction(
  command: SlashCommandData,
): ComposerAction | null {
  if (
    !('composerAction' in command) ||
    typeof command.composerAction !== 'string'
  )
    return null;
  return isComposerAction(command.composerAction)
    ? command.composerAction
    : null;
}

/** Presentation catalog; provider invocation and enablement remain host-owned. */
export function buildComposerCommands(
  commands: SlashCommandData[],
  options: {
    home: boolean;
    fast?: boolean;
    /** Explicit actions supported by this composer host. Omitted for legacy callers. */
    supportedActions?: readonly ComposerAction[];
  },
): ComposerCommand[] {
  const actions: ComposerCommand[] = Object.keys(COMPOSER_ACTIONS)
    .filter(isComposerAction)
    .filter((name) =>
      options.supportedActions ? options.supportedActions.includes(name) : true,
    )
    .map((name) => ({
      name,
      description: COMPOSER_ACTIONS[name],
      composerAction: name,
      menuGroup: ['plugins', 'attach', 'model'].includes(name)
        ? 'Actions'
        : 'More actions',
      ...(name === 'workspace' && !options.home
        ? { disabledReason: 'Choose a workspace before starting a chat.' }
        : {}),
      ...(name === 'pipeline' && !options.home
        ? { disabledReason: 'Start a pipeline task from New Task.' }
        : {}),
      ...(name === 'fast' && !options.fast
        ? { disabledReason: 'Speed options are available for Codex models.' }
        : {}),
    }));
  const members: ComposerCommand[] = commands.map((command) => {
    const ref = command.inventoryEntry?.enableRef;
    const namespace =
      ref?.kind === 'plugin'
        ? ref.pluginName
        : command.name.includes(':')
          ? command.name.split(':')[0]
          : undefined;
    return { ...command, namespace, menuGroup: 'Skills and commands' };
  });
  return [
    ...actions.filter((action) => action.menuGroup === 'Actions'),
    ...members.filter((command) => command.section !== 'available'),
    ...actions.filter((action) => action.menuGroup === 'More actions'),
    ...members.filter((command) => command.section === 'available'),
  ];
}
