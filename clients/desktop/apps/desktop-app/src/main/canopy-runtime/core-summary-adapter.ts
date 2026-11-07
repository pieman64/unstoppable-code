import { createHash } from 'node:crypto';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import { OperationLedgerRefusedError } from '@canopy/core-runtime/node/operations';
import type {
  CoreSummarySchedule,
  SummaryScope,
} from '@canopy/core-runtime/node/summary';
import type {
  CanopyWorkspaceScope,
  CoreSummaryGetResult,
  CoreSummaryOperationRef,
  CoreSummaryRegenerateParams,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';
import type {
  WorktreeSummaryData,
  WorktreeSummaryFile,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import type { DesktopDomainAdapter } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

export interface CoreSummaryAdapterHost {
  readSummaryFile(
    workspaceId: string,
    worktreeId: string,
  ): Promise<WorktreeSummaryFile | null>;
}

export interface CoreSummaryAdapterOptions {
  schedule: () => Pick<CoreSummarySchedule, 'isPending' | 'regenerate'>;
  /** Receives the stored summary of each core.summary.get, for the IPC projection. */
  captureLegacy?(summary: WorktreeSummaryData | null): void;
}

export const SUMMARY_NONE = 'none';

const CONTENT_MAX = 2_000_000;

/** CAN-4114: the default host reads the summary file the IPC reads. */
export const DESKTOP_SUMMARY_ADAPTER_HOST: CoreSummaryAdapterHost = {
  readSummaryFile: async (workspaceId, worktreeId) =>
    (
      await import('../lib/worktree-summary-persistence')
    ).readWorktreeSummaryFile(workspaceId, worktreeId),
};

export function summarySourceRevision(
  file: WorktreeSummaryFile | null,
): string {
  return file ? `turns:${file.summary.turnCountAtGeneration}` : SUMMARY_NONE;
}

function summaryContent(summary: WorktreeSummaryData): string {
  return stableStringify({
    title: summary.title,
    description: summary.description,
    highlights: summary.highlights,
    ...(summary.repos ? { repos: summary.repos } : {}),
  });
}

function summaryRevision(generatedAt: string | undefined): number {
  const parsed = generatedAt === undefined ? NaN : Date.parse(generatedAt);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export function projectWorktreeSummary(
  scope: SummaryScope,
  file: WorktreeSummaryFile | null,
  pending: boolean,
): CoreSummaryGetResult {
  const resultScope = {
    workspaceId: scope.workspaceId,
    worktreeId: scope.worktreeId,
  };
  if (!file)
    return {
      summaryId: SUMMARY_NONE,
      scope: resultScope,
      sourceRevision: SUMMARY_NONE,
      content: '',
      state: 'missing',
      revision: 0,
      generatedAt: null,
    };
  const content = summaryContent(file.summary);
  if (content.length > CONTENT_MAX)
    throw new CanopyOperationError({
      kind: 'internal',
      message: 'The summary is too large to serve.',
      retry: { kind: 'never' },
    });
  return {
    summaryId:
      file.history[file.history.length - 1]?.snapshotId ?? SUMMARY_NONE,
    scope: resultScope,
    sourceRevision: summarySourceRevision(file),
    content,
    state: pending ? 'stale' : 'ready',
    revision: summaryRevision(file.summary.generatedAt),
    generatedAt: file.summary.generatedAt,
  };
}

function summaryScope(scope: CanopyWorkspaceScope): SummaryScope {
  const { workspaceId, worktreeId } = scope;
  try {
    if (workspaceId === undefined || worktreeId === undefined)
      throw new Error('missing');
    validateId(workspaceId, 'workspaceId');
    validateId(worktreeId, 'worktreeId');
  } catch {
    throw new CanopyOperationError({
      kind: 'invalid_argument',
      message: 'A summary scope needs a workspace and worktree id.',
      retry: { kind: 'never' },
    });
  }
  if (
    scope.targetId !== undefined ||
    (scope.authorityId !== undefined &&
      scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
  )
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected summary authority or target is unavailable.',
      retry: { kind: 'never' },
    });
  return { workspaceId, worktreeId };
}

function operationRef(record: {
  operationId: string;
  kind: string;
  status: CoreSummaryOperationRef['status'];
  authorityId?: string | null;
  executionTargetId?: string | null;
  runtimeDelegationId?: string | null;
  parentOperationId?: string | null;
}): CoreSummaryOperationRef {
  return {
    operationId: record.operationId,
    kind: record.kind,
    status: record.status,
    ...(record.authorityId !== undefined
      ? { authorityId: record.authorityId }
      : {}),
    ...(record.executionTargetId !== undefined
      ? { executionTargetId: record.executionTargetId }
      : {}),
    ...(record.runtimeDelegationId !== undefined
      ? { runtimeDelegationId: record.runtimeDelegationId }
      : {}),
    ...(record.parentOperationId !== undefined
      ? { parentOperationId: record.parentOperationId }
      : {}),
  };
}

export function createCoreSummaryAdapter(
  host: CoreSummaryAdapterHost,
  options: CoreSummaryAdapterOptions,
): DesktopDomainAdapter {
  const { schedule: summarySchedule } = options;
  return {
    queries: {
      'core.summary.get': async (params): Promise<CoreSummaryGetResult> => {
        const scope = summaryScope(params.scope);
        const file = await host
          .readSummaryFile(scope.workspaceId, scope.worktreeId)
          .catch(() => null);
        options.captureLegacy?.(file?.summary ?? null);
        return projectWorktreeSummary(
          scope,
          file,
          summarySchedule().isPending(scope),
        );
      },
    },
    instructions: {
      'core.summary.regenerate': async (
        params: CoreSummaryRegenerateParams,
        context: CanopyHandlerContext,
      ): Promise<CoreSummaryOperationRef> => {
        const scope = summaryScope(params.scope);
        if (
          (params.targetId !== undefined && params.targetId !== null) ||
          Object.keys(params.providerProfile ?? {}).length > 0
        )
          throw new CanopyOperationError({
            kind: 'capability_unavailable',
            message:
              'This host regenerates summaries with the saved summary settings only.',
            retry: { kind: 'never' },
          });
        const fingerprint = createHash('sha256')
          .update(
            stableStringify({
              scope,
              expectedSourceRevision: params.expectedSourceRevision,
              targetId: params.targetId ?? null,
              providerProfile: params.providerProfile ?? {},
            }),
          )
          .digest('hex');
        try {
          const record = await summarySchedule().regenerate(
            scope,
            {
              kind: 'client',
              sourceId: context.caller.principalId,
              context: { mode: 'full' },
            },
            {
              caller: context.caller.principalId,
              idempotencyKey: params._meta.idempotencyKey,
              fingerprint,
            },
            async () => {
              const file = await host
                .readSummaryFile(scope.workspaceId, scope.worktreeId)
                .catch(() => null);
              if (summarySourceRevision(file) !== params.expectedSourceRevision)
                throw new CanopyOperationError({
                  kind: 'conflict',
                  code: 'core.summary.revisionConflict',
                  message:
                    'The summary changed; read it again before regenerating.',
                  retry: {
                    kind: 'after_refresh',
                    resource: 'core.summary.get',
                  },
                });
            },
          );
          return operationRef(record);
        } catch (error) {
          if (
            error instanceof OperationLedgerRefusedError &&
            error.refusal === 'key-reused'
          )
            throw new CanopyOperationError({
              kind: 'conflict',
              code: 'core.summary.invalidState',
              message: 'This idempotency key was used with other parameters.',
              retry: { kind: 'never' },
            });
          throw error;
        }
      },
    },
  };
}
