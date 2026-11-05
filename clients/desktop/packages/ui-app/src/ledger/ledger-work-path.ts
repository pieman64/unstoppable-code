import {
  ledgerViewScopeKey,
  type LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import type { WorkPathPart } from '@canopy/ui-shared/components';

/** This device's names for a scope: its project, and its worktree or task. */
export interface LedgerScopeNames {
  readonly projectName: string;
  /** Null when this device lists the project but not the task. */
  readonly taskName: string | null;
}

/** Looks up this device's names for a scope; null when it doesn't list it. */
export type LedgerScopeNamesFor = (
  scope: LedgerViewScope,
) => LedgerScopeNames | null;

/**
 * A scope's work path, project › task, for `WorkPath`. Each part opens the
 * scope when the host can (`onOpenScope`); `fallback` names unknown work.
 * Further parts, such as an operation, follow in `extra`. Inside `root`, the
 * scope a panel already shows, the path starts below the task: only `extra`.
 */
export function ledgerScopeWorkPath(
  scope: LedgerViewScope,
  names: LedgerScopeNames | null,
  options: {
    readonly fallback: string;
    readonly onOpenScope?: (scope: LedgerViewScope) => void;
    readonly extra?: readonly WorkPathPart[];
    readonly root?: LedgerViewScope;
  },
): WorkPathPart[] {
  if (
    options.root !== undefined &&
    ledgerViewScopeKey(options.root) === ledgerViewScopeKey(scope)
  ) {
    return options.extra === undefined ? [] : [...options.extra];
  }
  const open =
    options.onOpenScope === undefined
      ? undefined
      : (): void => options.onOpenScope?.(scope);
  const withOpen = (key: string, label: string): WorkPathPart =>
    open === undefined ? { key, label } : { key, label, onOpen: open };
  const parts: WorkPathPart[] =
    names === null
      ? [withOpen('scope', options.fallback)]
      : names.taskName === null
        ? [withOpen('project', names.projectName)]
        : [
            withOpen('project', names.projectName),
            withOpen('task', names.taskName),
          ];
  return options.extra === undefined ? parts : [...parts, ...options.extra];
}
