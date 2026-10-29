import type { SubagentChatKind } from '@canopy/agent-transcript';

/**
 * Display types shared by the Subagents panel, the subagent chat panel and
 * the hosts that feed them. Hosts map their backend results onto these; the
 * shared UI never reads a transport type directly.
 */

/** A worktree's change totals, for the list's Changes column and the facts. */
export interface SubagentChangeTotals {
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
}

/** How a file differs from the delegate's starting revision. */
export type SubagentWorktreeFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked';

/** One changed file in an isolated delegate's worktree. */
export interface SubagentWorktreeFile {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly status: SubagentWorktreeFileStatus;
}

/** Whether an isolated delegate's checkout still exists. */
export type SubagentWorktreeCheckout = 'retained' | 'discarded' | 'missing';

/** Whether an isolated delegate's work was brought back to its parent. */
export type SubagentWorktreeApplyState =
  | 'not_applied'
  | 'applied'
  | 'apply_failed'
  | 'discarded';

/** An isolated managed delegate's worktree, read on demand by the host. */
export interface SubagentWorktreeSummary {
  readonly checkout: SubagentWorktreeCheckout;
  /** The full or abbreviated starting commit. */
  readonly startingRevision: string;
  readonly startingSubject?: string;
  readonly startingBranch?: string;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly commitsAhead: number;
  readonly untrackedFiles: number;
  readonly applyState: SubagentWorktreeApplyState;
  /** The most changed files, already ordered by the host. */
  readonly topFiles: readonly SubagentWorktreeFile[];
  /** True when `topFiles` lists only some of the changed files. */
  readonly truncated: boolean;
}

/** The host's read of a worktree summary, including its unready states. */
export type SubagentWorktreeSummaryState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'error';
      readonly error: string;
      readonly onRetry?: () => void;
    }
  | { readonly status: 'unavailable'; readonly reason?: string }
  | { readonly status: 'ready'; readonly summary: SubagentWorktreeSummary };

/**
 * The identity a host needs to open one subagent's chat panel. Workflow run
 * and phase groups never open as chats.
 */
export interface SubagentChatTarget {
  readonly kind: SubagentChatKind;
  readonly id: string;
  readonly title: string;
}
