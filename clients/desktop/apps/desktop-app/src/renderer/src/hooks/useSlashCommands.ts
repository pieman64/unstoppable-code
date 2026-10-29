import type { SlashCommandData } from '@canopy/desktop-shared/types';
import type { ChatEditor } from '@canopy/ui-rich/types';
import {
  extractCommandPrefix,
  getSlashCommandInsertText as sharedGetSlashCommandInsertText,
  useSlashCommands as sharedUseSlashCommands,
  type SlashCommandTriggerCharacter,
  type UseSlashCommandsResult,
} from '@canopy/ui-rich/plugins';

export type { SlashCommandTriggerCharacter } from '@canopy/ui-rich/plugins';

/**
 * Re-export of the shared insert-text helper. Desktop callers continue to
 * pass {@link SlashCommandData} from the discovery service; the shared
 * implementation accepts any structurally-compatible row.
 */
export function getSlashCommandInsertText(
  cmd: SlashCommandData,
  trigger: SlashCommandTriggerCharacter = '/',
): string {
  return sharedGetSlashCommandInsertText(cmd, trigger);
}

export { extractCommandPrefix };

/**
 * Thin desktop wrapper around the shared hook in `@canopy/ui-rich/plugins`.
 * Keeps the existing call-site shape (`useSlashCommands(editor, commands,
 * isDiscovering, triggerCharacters)`) so renderer code does not need to
 * migrate to the options-object form.
 */
export function useSlashCommands<
  TCommand extends SlashCommandData = SlashCommandData,
>(
  editor: ChatEditor,
  commands: TCommand[],
  isDiscovering: boolean,
  triggerCharacters?: readonly SlashCommandTriggerCharacter[],
): UseSlashCommandsResult<TCommand> {
  return sharedUseSlashCommands<TCommand>(editor, {
    commands,
    isDiscovering,
    ...(triggerCharacters ? { triggerCharacters } : {}),
  });
}
