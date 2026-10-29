import type { ScriptAction } from '@canopy/protocol/script-actions';
import { SCRIPT_ACTIONS_REVIEW_BATCH_LIMIT } from '@canopy/protocol/script-actions';

/** Selected pending rows: action ID to the revision the user saw. */
export type ScriptReviewSelection = ReadonlyMap<string, string>;

export interface ScriptActionGroup {
  readonly key: string;
  readonly label: string;
  readonly actions: readonly ScriptAction[];
}

export const PERSONAL_ALIASES_LABEL = 'Personal aliases';
const ALIAS_GROUP_KEY = 'alias';

/** Resolves a repository ID to the name the host shows for it. */
export type RepositoryNameResolver = (repoId: string) => string | undefined;

function repositoryLabel(
  action: ScriptAction,
  resolveRepositoryName: RepositoryNameResolver | undefined,
): string {
  const named =
    action.repoId === null ? undefined : resolveRepositoryName?.(action.repoId);
  return named ?? action.repoName ?? 'Project root';
}

/**
 * Groups rows by repository and package, with personal aliases last. Groups
 * and rows keep the service's stable order.
 */
export function groupScriptActions(
  actions: readonly ScriptAction[],
  resolveRepositoryName?: RepositoryNameResolver,
): ScriptActionGroup[] {
  const groups = new Map<string, { label: string; actions: ScriptAction[] }>();
  const aliases: ScriptAction[] = [];
  for (const action of actions) {
    if (action.kind === 'alias') {
      aliases.push(action);
      continue;
    }
    const key = JSON.stringify([action.repoId, action.packagePath]);
    const existing = groups.get(key);
    if (existing) {
      existing.actions.push(action);
      continue;
    }
    const repo = repositoryLabel(action, resolveRepositoryName);
    groups.set(key, {
      label: action.packagePath ? `${repo}/${action.packagePath}` : repo,
      actions: [action],
    });
  }
  const result: ScriptActionGroup[] = Array.from(groups, ([key, group]) => ({
    key,
    label: group.label,
    actions: group.actions,
  }));
  if (aliases.length > 0)
    result.push({
      key: ALIAS_GROUP_KEY,
      label: PERSONAL_ALIASES_LABEL,
      actions: aliases,
    });
  return result;
}

/**
 * Keeps only selections whose row is still pending at the revision the user
 * selected. A changed or vanished row drops out; newly arrived rows are never
 * added.
 */
export function reconcileScriptSelection(
  selection: ScriptReviewSelection,
  pending: readonly ScriptAction[],
): Map<string, string> {
  const revisions = new Map(
    pending.map((action) => [action.id, action.revision]),
  );
  const next = new Map<string, string>();
  for (const [id, revision] of selection)
    if (revisions.get(id) === revision) next.set(id, revision);
  return next;
}

export type SelectAllState = 'none' | 'some' | 'all';

export function selectAllState(
  selection: ScriptReviewSelection,
  rows: readonly ScriptAction[],
): SelectAllState {
  if (rows.length === 0) return 'none';
  const selected = rows.filter(
    (action) => selection.get(action.id) === action.revision,
  ).length;
  if (selected === 0) return 'none';
  return selected === rows.length ? 'all' : 'some';
}

/** Selects every row when any is unselected, otherwise clears them. */
export function toggleScriptSelection(
  selection: ScriptReviewSelection,
  rows: readonly ScriptAction[],
): Map<string, string> {
  const next = new Map(selection);
  if (selectAllState(selection, rows) === 'all')
    for (const action of rows) next.delete(action.id);
  else for (const action of rows) next.set(action.id, action.revision);
  return next;
}

export interface ScriptReviewBatch {
  readonly store: 'workspace' | 'alias';
  readonly entries: readonly {
    readonly id: string;
    readonly revision: string;
  }[];
}

/**
 * Splits a submission by store. The service refuses a batch that spans
 * personal aliases and workspace rows (`mixed_stores`), and there is no
 * cross-store atomic write, so each store is submitted and reported alone.
 */
export function splitScriptReviewBatches(
  selection: ScriptReviewSelection,
  pending: readonly ScriptAction[],
): ScriptReviewBatch[] {
  const workspace: { id: string; revision: string }[] = [];
  const alias: { id: string; revision: string }[] = [];
  for (const action of pending) {
    if (selection.get(action.id) !== action.revision) continue;
    (action.kind === 'alias' ? alias : workspace).push({
      id: action.id,
      revision: action.revision,
    });
  }
  const batches: ScriptReviewBatch[] = [];
  for (const [store, entries] of [
    ['workspace', workspace],
    ['alias', alias],
  ] as const) {
    for (
      let index = 0;
      index < entries.length;
      index += SCRIPT_ACTIONS_REVIEW_BATCH_LIMIT
    )
      batches.push({
        store,
        entries: entries.slice(
          index,
          index + SCRIPT_ACTIONS_REVIEW_BATCH_LIMIT,
        ),
      });
  }
  return batches;
}

export function scriptCountLabel(count: number): string {
  return count === 1 ? '1 script' : `${count} scripts`;
}

export function aliasCountLabel(count: number): string {
  return count === 1 ? '1 personal alias' : `${count} personal aliases`;
}

/** The post-add notice copy, shared by desktop and Portal toasts. */
export function scriptActionsFoundMessage(
  count: number,
  targetName: string | null,
): string {
  return `Found ${scriptCountLabel(count)} in ${targetName ?? 'this project'} to review`;
}

/** Display path for a row's source, such as `package.json:12`. */
export function scriptSourceLabel(action: ScriptAction): string {
  return action.source.line === null
    ? action.source.file
    : `${action.source.file}:${action.source.line}`;
}

function errorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return null;
  return typeof error.code === 'string' ? error.code : null;
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message
    : fallback;
}

/** The service rejected a revision the user reviewed: the row changed. */
export function isStaleRevisionError(error: unknown): boolean {
  if (errorCode(error) === 'stale_revision') return true;
  // Portal relays the desktop's message without the code.
  return (
    error instanceof Error && /stale|definition changed/i.test(error.message)
  );
}
