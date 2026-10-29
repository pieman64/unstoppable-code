import type {
  SubagentChangeTotals,
  SubagentNode,
  SubagentRecipient,
} from '@canopy/ui-shared';

/**
 * What the host can do for the subagent viewer. Every field is a plain
 * boolean the host derives from its `CanopyCapabilities`
 * (`delegationStop`, `delegationMessaging`, `delegationWorktreeDetails`,
 * `nativeSubagentInterrupt`) or from the workflow data it can reach. A control the host cannot fulfil renders its
 * unavailable state; the shared UI never branches on host identity.
 */
export interface SubagentViewerCapabilities {
  /** Stop a live managed delegation and its subtree (inspector Stop). */
  readonly stop: boolean;
  /** Follow-up, steer and interrupt a managed delegate (To = this subagent). */
  readonly messaging: boolean;
  /** Read an isolated delegate's worktree summary and its changes. */
  readonly worktreeDetails: boolean;
  /** Interrupt a running native Claude or Codex subagent. */
  readonly nativeInterrupt: boolean;
  /** Open a Claude Code workflow run in the host's workflow view. */
  readonly openWorkflow: boolean;
  /** Stop a live Claude Code workflow run. */
  readonly stopWorkflow: boolean;
}

/**
 * Whether a subagent has changes to show: a managed delegate that ran in its
 * own isolated checkout, which still exists. Shared-worktree delegates write
 * straight to the parent's worktree, so there is nothing separate to diff.
 */
export function subagentHasIsolatedChanges(node: SubagentNode): boolean {
  return (
    node.kind === 'managed' &&
    node.workspace === 'isolated' &&
    node.isolatedRevision !== undefined &&
    node.workspaceDiscarded !== true
  );
}

/** Result of a host command that either succeeded or failed with a reason. */
export type SubagentCommandResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

/** One open, non-archived root chat that has started subagents (D4). */
export interface SubagentRootChatSummary {
  readonly id: string;
  readonly title: string;
  /** Subagents the chat has started, at any depth. */
  readonly total: number;
  /** Of those, how many are queued, starting, running or awaiting approval. */
  readonly live: number;
  /** Epoch milliseconds of the latest activity, for recency order. */
  readonly lastActivityAt?: number;
  /** True while the host is still counting this chat's subagents. */
  readonly loading?: boolean;
}

/** Tree or List (D5). */
export type SubagentsViewMode = 'tree' | 'list';

/** Per-node change totals for the list's Changes column and the inspector. */
export type SubagentChangeTotalsLookup = (
  node: SubagentNode,
) => SubagentChangeTotals | undefined;

/** The tree read for the selected root chat. */
export type SubagentTreeLoadState =
  | { readonly status: 'ready' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'error';
      readonly error: string;
      readonly onRetry?: () => void;
    };

/** A managed-delegate command issued from the subagent composer. */
export interface SubagentMessageRequest {
  readonly operation: 'follow_up' | 'steer' | 'interrupt';
  /** Present for `follow_up` and `steer`. */
  readonly message?: string;
  /** A fresh UUID per attempt, so the host can deduplicate retries. */
  readonly operationId: string;
}

/** Why a managed-delegate command was refused. */
export type SubagentMessageErrorCode =
  | 'parent_unavailable'
  | 'busy'
  | 'not_found'
  | 'discarded'
  | 'invalid_request'
  | 'failed';

export type SubagentMessageResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: SubagentMessageErrorCode;
      readonly error: string;
    };

/** Why a native interrupt was refused. */
export type SubagentNativeInterruptErrorCode =
  | 'unsupported'
  | 'not_running'
  | 'not_found'
  | 'failed';

export type SubagentNativeInterruptResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: SubagentNativeInterruptErrorCode;
      readonly error: string;
    };

/** A breadcrumb or lineage target: the root chat or one subagent. */
export type SubagentLineageTarget =
  | { readonly kind: 'root'; readonly id: string; readonly title: string }
  | {
      readonly kind: SubagentNode['kind'];
      readonly id: string;
      readonly title: string;
    };

/** A recipient the subagent composer can send to besides the subagent itself. */
export type SubagentSendRecipient = SubagentRecipient;
