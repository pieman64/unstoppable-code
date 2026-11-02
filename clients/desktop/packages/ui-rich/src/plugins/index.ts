export {
  extractCommandPrefix,
  getSlashCommandInsertText,
  useSlashCommands,
  type UseSlashCommandsOptions,
  type UseSlashCommandsResult,
} from './useSlashCommands';
export type { SlashCommandTriggerCharacter } from '../types';
export {
  useFileTypeahead,
  type UseFileTypeaheadOptions,
  type UseFileTypeaheadResult,
} from './useFileTypeahead';

export {
  matchSlashCommand,
  searchSlashCommands,
  type SlashCommandMatch,
} from './commandSearch';
export { normalizeSearchText } from './commandSearchIdentity';
export {
  groupContiguousRuns,
  limitSlashResults,
  SLASH_GROUP_LIMIT,
  SLASH_RESULT_LIMIT,
  slashCommandGroupKey,
  type LimitedSlashResults,
  type SlashGroupRun,
  type SlashResultLimits,
} from './commandPresentation';
