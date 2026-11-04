import * as path from 'node:path';

import {
  WORKER_CODE_GRAPH_BUILD_WARNING_LIMITS,
  type WorkerCodeGraphBuildFailure,
  type WorkerCodeGraphBuildParams,
  type WorkerCodeGraphBuildQueue,
  type WorkerCodeGraphBuildResult,
  type WorkerCodeGraphQueueItem,
} from '@canopy/protocol/canopy-core';

import type { CanopyOperationError } from '../../runtime/errors';
import {
  codeGraphBuildCanceledError,
  codeGraphBuildFailedError,
  codeGraphBuildTimedOutError,
  codeGraphUnavailableError,
  type CodeGraphBuildQueueWorker,
} from './worker-code-graph-builds';

/*
 * The build queue controls over a host's code-graph build scheduler: its
 * queue entries projected to portable queue items, and its reorder, cancel
 * and build. Electron main and the core daemon each compose one over their
 * own scheduler; the structural types here mirror `@canopy/code-graph`'s,
 * which this package may not import.
 */

/** One scheduler queue entry with the scheduling class it holds. */
export interface CodeGraphSchedulerQueueEntry {
  readonly id: string;
  readonly scope: string;
  readonly workspaceIds: readonly string[];
  readonly workspaceLabel?: string;
  readonly worktreeId?: string;
  readonly repositoryId?: string;
  readonly label?: string;
  readonly trigger: string;
  readonly queuedAt: number;
  readonly startedAt: number | null;
  readonly status: WorkerCodeGraphQueueItem['state'];
  readonly reorderable: boolean;
  readonly priority: WorkerCodeGraphQueueItem['priority'];
}

/** The scheduler surface the build and queue operations need. */
export interface CodeGraphSchedulerQueue {
  build(
    graphScope: WorkerCodeGraphBuildParams['graphScope'],
  ): Promise<WorkerCodeGraphBuildResult>;
  queueStatus(): {
    readonly revision: number;
    readonly entries: readonly CodeGraphSchedulerQueueEntry[];
  };
  reorderQueue(request: {
    revision: number;
    orderedQueuedEntryIds: string[];
  }): { revision: number } | { ok: false; code: string; message: string };
  cancelQueueItem(
    queueItemId: string,
  ): Promise<WorkerCodeGraphQueueItem['state'] | null>;
  /** See {@link CodeGraphBuildQueueWorker.cancelWorktree}. */
  cancelWorktree(workspaceId: string, worktreeId: string): Promise<number>;
}

const LABEL_MAX_LENGTH = 512;
const TRIGGER_MAX_LENGTH = 128;

function nullableLabel(value: string | undefined): string | null {
  return value === undefined ? null : value.slice(0, LABEL_MAX_LENGTH);
}

function queueItem(
  entry: CodeGraphSchedulerQueueEntry,
  now: number,
): WorkerCodeGraphQueueItem {
  return {
    queueItemId: entry.id,
    graphScope: entry.scope === 'worktree' ? 'worktree' : 'workspace_base',
    workspaceIds: [...entry.workspaceIds],
    worktreeId: entry.worktreeId ?? null,
    repositoryId: entry.repositoryId ?? null,
    workspaceLabel: nullableLabel(entry.workspaceLabel),
    label: nullableLabel(entry.label),
    trigger: entry.trigger.slice(0, TRIGGER_MAX_LENGTH) || 'unspecified',
    priority: entry.priority,
    state: entry.status,
    reorderable: entry.reorderable,
    enqueuedAt: new Date(entry.queuedAt).toISOString(),
    startedAt:
      entry.startedAt === null ? null : new Date(entry.startedAt).toISOString(),
    timing: {
      queueWaitMs: Math.max(0, (entry.startedAt ?? now) - entry.queuedAt),
      runningMs:
        entry.startedAt === null ? null : Math.max(0, now - entry.startedAt),
    },
  };
}

export function projectCodeGraphBuildQueue(
  status: ReturnType<CodeGraphSchedulerQueue['queueStatus']>,
  now: number,
): WorkerCodeGraphBuildQueue {
  return {
    revision: status.revision,
    items: status.entries.map((entry) => queueItem(entry, now)),
  };
}

export function createCodeGraphBuildQueueWorker(
  scheduler: CodeGraphSchedulerQueue,
  now: () => number = Date.now,
): CodeGraphBuildQueueWorker {
  const queue = (): WorkerCodeGraphBuildQueue =>
    projectCodeGraphBuildQueue(scheduler.queueStatus(), now());
  return {
    queue,
    reorder: (expectedRevision, orderedQueueItemIds) => {
      const outcome = scheduler.reorderQueue({
        revision: expectedRevision,
        orderedQueuedEntryIds: [...orderedQueueItemIds],
      });
      if (!('ok' in outcome)) return { ok: true, queue: queue() };
      return {
        ok: false,
        refusal: outcome.code === 'conflict' ? 'changed' : 'invalid-order',
        message: outcome.message,
      };
    },
    cancel: async (queueItemId) => {
      const canceledState = await scheduler.cancelQueueItem(queueItemId);
      return canceledState === null ? null : { queueItemId, canceledState };
    },
    build: (graphScope) => scheduler.build(graphScope),
    cancelWorktree: (workspaceId, worktreeId) =>
      scheduler.cancelWorktree(workspaceId, worktreeId),
  };
}

/** A worktree build's result, as the graph engine returns it. */
export interface CodeGraphWorktreeBuildCounts {
  readonly filesScanned: number;
  readonly filesParsed: number;
  readonly filesUnchanged: number;
  readonly filesSkipped: number;
  readonly filesRemoved: number;
  readonly parseFailures: number;
  readonly symbolCount: number;
  readonly edgeCount: number;
  readonly durationMs: number;
  /** Epoch milliseconds of the build's `last_build_at` stamp. */
  readonly lastBuildAt?: number;
  /** The build published before its derived analysis. */
  readonly derivedDeferred?: boolean;
  /** One entry per repository; empty when no derived analysis ran. */
  readonly derived: readonly { readonly warnings: readonly string[] }[];
  /** Null without a custom-language configuration. */
  readonly customLanguages: {
    readonly configPath: string;
    readonly diagnostics: readonly {
      readonly entryId: string | null;
      readonly message: string;
    }[];
  } | null;
}

const LIMITS = WORKER_CODE_GRAPH_BUILD_WARNING_LIMITS;

const ABSOLUTE_PATH = /(?:\b[A-Za-z]:[\\/]|(?<![\w.~-])\/)[^\s"'`,;()]+/g;

// Build warnings are host text, and a grammar or derived-analysis failure
// can name an absolute path. The result keeps paths relative to the config
// directory or the worktree, and hides any other absolute path.
function portableText(roots: readonly string[]): (text: string) => string {
  return (text) => {
    let portable = text;
    for (const root of roots) {
      portable = portable
        .split(`${root}${path.sep}`)
        .join('')
        .split(root)
        .join('.');
    }
    return portable.replace(ABSOLUTE_PATH, '<path>');
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function omittedNote(message: string, omitted: number): string {
  const note = ` (${omitted} more not shown)`;
  return `${message.slice(0, LIMITS.messageLength - note.length)}${note}`;
}

// A repository's custom-language configuration decides how many diagnostics
// a build reports and how long they are; the result keeps within its schema
// so a committed build is never reported as failed.
function boundedList<T>(
  items: T[],
  max: number,
  last: (item: T, omitted: number) => T,
): T[] {
  if (items.length <= max) return items;
  const kept = items.slice(0, max);
  const tail = kept[max - 1];
  if (tail !== undefined) kept[max - 1] = last(tail, items.length - max);
  return kept;
}

/**
 * A completed worktree build as `worker.codeGraph.build` answers it, with
 * every warning made portable against the worktree root the host resolved.
 */
export function codeGraphWorktreeBuildResult(
  result: CodeGraphWorktreeBuildCounts,
  worktreeRoot: string | null,
): WorkerCodeGraphBuildResult {
  const portable = portableText([
    ...(result.customLanguages === null
      ? []
      : [path.dirname(result.customLanguages.configPath)]),
    ...(worktreeRoot === null ? [] : [worktreeRoot]),
  ]);
  return {
    kind: 'worktree',
    filesScanned: result.filesScanned,
    filesParsed: result.filesParsed,
    filesUnchanged: result.filesUnchanged,
    filesSkipped: result.filesSkipped,
    filesRemoved: result.filesRemoved,
    parseFailures: result.parseFailures,
    symbolCount: result.symbolCount,
    edgeCount: result.edgeCount,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    lastBuildAt:
      result.lastBuildAt === undefined
        ? null
        : new Date(result.lastBuildAt).toISOString(),
    derivedPending: result.derivedDeferred === true,
    customLanguageDiagnostics:
      result.customLanguages === null
        ? null
        : boundedList(
            result.customLanguages.diagnostics.map((diagnostic) => ({
              entryId:
                diagnostic.entryId === null
                  ? null
                  : clip(diagnostic.entryId, LIMITS.entryIdLength),
              message: clip(portable(diagnostic.message), LIMITS.messageLength),
            })),
            LIMITS.diagnostics,
            (diagnostic, omitted) => ({
              entryId: null,
              message: omittedNote(diagnostic.message, omitted),
            }),
          ),
    derivedWarnings:
      result.derived.length === 0
        ? null
        : boundedList(
            result.derived
              .flatMap((repository) => repository.warnings)
              .map((warning) => clip(portable(warning), LIMITS.messageLength)),
            LIMITS.derivedWarnings,
            omittedNote,
          ),
  };
}

type WorktreeBuildScope = Extract<
  WorkerCodeGraphBuildParams['graphScope'],
  { kind: 'worktree' }
>;

/** How a worktree generation starts for a `worker.codeGraph.build` scope. */
export interface CodeGraphWorktreeGenerationStart {
  readonly reason:
    | NonNullable<WorktreeBuildScope['background']>['trigger']
    | 'tool-request'
    | 'manual';
  readonly options:
    | Record<string, never>
    | { readonly verifyContent: true }
    | { readonly forceReparse: true };
  readonly observedFingerprint?: string;
  readonly observedFingerprintMs?: number;
}

const BUILD_MODE_OPTIONS = {
  incremental: {},
  verified: { verifyContent: true },
  full: { forceReparse: true },
} as const;

/**
 * A person's or agent's build keeps its trigger; a background build
 * (CAN-5617) keeps the scheduler's trigger and the fingerprint it read.
 */
export function codeGraphWorktreeGenerationStart(
  scope: WorktreeBuildScope,
): CodeGraphWorktreeGenerationStart {
  const options = BUILD_MODE_OPTIONS[scope.mode];
  const { background } = scope;
  if (background === undefined)
    return {
      reason: scope.requestedBy === 'agent' ? 'tool-request' : 'manual',
      options,
    };
  return {
    reason: background.trigger,
    options,
    ...(background.observedFingerprint === undefined
      ? {}
      : {
          observedFingerprint: background.observedFingerprint.value,
          observedFingerprintMs: background.observedFingerprint.observedMs,
        }),
  };
}

const FAILURES: Readonly<Record<string, WorkerCodeGraphBuildFailure>> = {
  'worker-exit': 'worker_exit',
  'spawn-failed': 'spawn_failed',
  'post-failed': 'post_failed',
  'malformed-response': 'malformed_response',
};

/**
 * The typed refusal for a build the scheduler rejected. Its failures carry a
 * `reason`, as `CodeGraphWorkerBuildError` does; the channels matched them
 * by that field before this operation existed.
 */
export function codeGraphBuildRefusal(error: unknown): CanopyOperationError {
  const reason =
    typeof error === 'object' && error !== null && 'reason' in error
      ? error.reason
      : undefined;
  if (reason === 'unavailable') return codeGraphUnavailableError();
  if (reason === 'timeout') return codeGraphBuildTimedOutError();
  if (reason === 'canceled') return codeGraphBuildCanceledError();
  const failure = typeof reason === 'string' ? FAILURES[reason] : undefined;
  return codeGraphBuildFailedError(failure ?? 'internal', error);
}
