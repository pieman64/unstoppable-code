import type { ScriptAction } from '@canopy/protocol/script-actions';
import { WORKSPACE_ROOT_REPO_NAME } from '@canopy/protocol/ui-labels';
import {
  normalizeSearchText,
  searchSlashCommands,
} from '@canopy/ui-rich/plugins';
import type { SlashCommandOption } from '@canopy/ui-rich/types';

/** Suggestions shown at once; the rest are reached by typing more. */
export const SCRIPT_SUGGESTION_LIMIT = 50;

/** Group heading for user-wide shell aliases. */
export const PERSONAL_ALIASES_GROUP = 'Personal aliases';

/** One runnable script action offered by the `!` typeahead. */
export interface ScriptSuggestion {
  readonly action: ScriptAction;
  /** Repository/package heading, or {@link PERSONAL_ALIASES_GROUP}. */
  readonly group: string;
  /** The command's first line, marked when more lines follow. */
  readonly preview: string;
  /**
   * Package and source details, set only when another suggestion has the same
   * name, so same-named scripts can be told apart.
   */
  readonly detail: string | null;
}

/** Approved and available: the only actions the typeahead may offer. */
export function isRunnableScriptAction(action: ScriptAction): boolean {
  return action.status === 'approved' && action.unavailableReason === undefined;
}

/** The heading an action is listed under. */
export function scriptSuggestionGroup(action: ScriptAction): string {
  if (action.kind === 'alias') return PERSONAL_ALIASES_GROUP;
  const base =
    action.target.kind === 'workspace-root'
      ? WORKSPACE_ROOT_REPO_NAME
      : (action.repoName ?? WORKSPACE_ROOT_REPO_NAME);
  return action.packagePath ? `${base}/${action.packagePath}` : base;
}

function commandPreview(command: string): string {
  const lines = command.trim().split(/\r?\n/);
  const first = lines[0] ?? '';
  return lines.length > 1 ? `${first} …` : first;
}

function sourceDetail(action: ScriptAction): string {
  const parts: string[] = [];
  if (action.packagePath) parts.push(action.packagePath);
  if (action.source.file) parts.push(action.source.file);
  // The entry usually repeats the name; keep it only when it adds something.
  if (action.source.entry && action.source.entry !== action.name)
    parts.push(action.source.entry);
  return parts.join(' · ');
}

interface RankedOption extends SlashCommandOption {
  readonly data: ScriptAction;
}

function rankingOption(action: ScriptAction): RankedOption {
  // Script names and executable commands are identities. Repository labels
  // and package paths are searched separately below, outside slash identity.
  return {
    name: action.name,
    displayName: action.command,
    data: action,
  };
}

/**
 * The typeahead's suggestions for `query`: runnable actions only, ranked with
 * the composer's slash-command ranking (stable snapshot order for an empty
 * query), capped at {@link SCRIPT_SUGGESTION_LIMIT}, then kept contiguous by
 * group in order of each group's best match.
 */
export function buildScriptSuggestions(
  actions: readonly ScriptAction[],
  query: string,
  limit: number = SCRIPT_SUGGESTION_LIMIT,
): ScriptSuggestion[] {
  const runnable = actions.filter(isRunnableScriptAction);
  const terms = normalizeSearchText(query)
    .split(/[\s:/_\-.,()]+/)
    .filter(Boolean);
  const repositoryMatches =
    terms.length === 0
      ? []
      : runnable.filter((action) => {
          const words = normalizeSearchText(action.repoName ?? '').split(
            /[\s:/_\-.,()]+/,
          );
          return terms.every((term) =>
            words.some((word) => word.startsWith(term)),
          );
        });
  const packageOptions: RankedOption[] = runnable.map((action) => ({
    name: '',
    description: action.packagePath ?? undefined,
    data: action,
  }));
  const seen = new Set<string>();
  const ranked = [
    ...searchSlashCommands(runnable.map(rankingOption), query).map(
      (option) => option.data,
    ),
    ...repositoryMatches,
    ...searchSlashCommands(packageOptions, query).map((option) => option.data),
  ]
    .filter((action) => {
      if (seen.has(action.id)) return false;
      seen.add(action.id);
      return true;
    })
    .slice(0, Math.max(0, limit));
  const nameCounts = new Map<string, number>();
  for (const action of ranked) {
    const key = action.name.toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const groups = new Map<string, ScriptSuggestion[]>();
  for (const action of ranked) {
    const group = scriptSuggestionGroup(action);
    const collides = (nameCounts.get(action.name.toLowerCase()) ?? 0) > 1;
    const suggestion: ScriptSuggestion = {
      action,
      group,
      preview: commandPreview(action.command),
      detail: collides ? sourceDetail(action) || null : null,
    };
    const rows = groups.get(group);
    if (rows) rows.push(suggestion);
    else groups.set(group, [suggestion]);
  }
  return [...groups.values()].flat();
}

/** Copy for the review row; `count` is the snapshot's pending count. */
export function reviewScriptsLabel(count: number): string {
  return `Review ${count} detected ${count === 1 ? 'script' : 'scripts'}`;
}
