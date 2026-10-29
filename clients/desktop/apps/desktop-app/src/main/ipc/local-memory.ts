import {
  IPC_CHANNELS,
  type LocalMemoryConsolidationStatus,
  type LocalMemoryDocument,
  type LocalMemoryFileSummary,
  type LocalMemoryRebuildResponse,
  type LocalMemoryScopeRequest,
  type LocalMemorySnapshotRestoreResponse,
  type LocalMemorySnapshotSummary,
} from '@canopy/desktop-shared/types';
import { LOCAL_MEMORY_CHAT_SCOPE_SENTINELS } from '@canopy/desktop-shared/lib/local-memory-scope';
import { getUserMemoryDir, getWorkspaceMemoryDir } from '../lib/paths';
import { validateId } from '../lib/validation';
import {
  broadcastLocalMemoryChanged,
  unwatchLocalMemoryScope,
  watchLocalMemoryScope,
} from '../memory/local/change-events';
import { readLocalMemoryConsolidationStatus } from '../memory/local/consolidation-status';
import {
  listLocalMemoryFiles,
  mutateLocalMemoryItem,
  readLocalMemoryDocument,
} from '../memory/local/explorer';
import {
  restoreManualLocalMemorySnapshot,
  runManualLocalMemoryConsolidation,
  runManualLocalMemoryRebuild,
} from '../memory/local/manual-consolidation-trigger';
import { listLocalMemorySnapshots } from '../memory/local/snapshots';
import { registerIpcHandler } from './register';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Invalid memory request.');
  return value;
}

function scopeRequest(value: unknown): LocalMemoryScopeRequest {
  const request = record(value);
  if (request.scope === 'user') return { scope: 'user' };
  if (
    request.scope !== 'workspace' ||
    typeof request.workspaceId !== 'string' ||
    LOCAL_MEMORY_CHAT_SCOPE_SENTINELS.has(request.workspaceId)
  )
    throw new Error('Choose a memory workspace.');
  validateId(request.workspaceId, 'workspaceId');
  return { scope: 'workspace', workspaceId: request.workspaceId };
}

function directory(scope: LocalMemoryScopeRequest): string {
  return scope.scope === 'user'
    ? getUserMemoryDir()
    : getWorkspaceMemoryDir(scope.workspaceId);
}

function field(request: Record<string, unknown>, key: string): string {
  if (typeof request[key] !== 'string')
    throw new Error('Invalid memory request.');
  return request[key];
}

export function registerLocalMemoryHandlers(): void {
  registerIpcHandler<[unknown], LocalMemoryFileSummary[]>(
    IPC_CHANNELS.localMemoryList,
    async (_event, value) =>
      listLocalMemoryFiles(directory(scopeRequest(value))),
  );
  registerIpcHandler<[unknown], LocalMemoryDocument>(
    IPC_CHANNELS.localMemoryRead,
    async (_event, value) =>
      readLocalMemoryDocument(
        directory(scopeRequest(value)),
        field(record(value), 'fileKey'),
      ),
  );
  for (const [channel, update] of [
    [IPC_CHANNELS.localMemoryUpdateItem, true],
    [IPC_CHANNELS.localMemoryDeleteItem, false],
  ] as const) {
    registerIpcHandler<[unknown], LocalMemoryDocument>(
      channel,
      async (_event, value) => {
        const scope = scopeRequest(value);
        const request = record(value);
        const result = await mutateLocalMemoryItem(directory(scope), {
          fileKey: field(request, 'fileKey'),
          itemId: field(request, 'itemId'),
          revision: field(request, 'revision'),
          ...(update ? { text: field(request, 'text') } : {}),
        });
        broadcastLocalMemoryChanged(scope);
        return result;
      },
    );
  }
  registerIpcHandler<[unknown], LocalMemoryConsolidationStatus>(
    IPC_CHANNELS.localMemoryConsolidationStatus,
    async (_event, value) =>
      readLocalMemoryConsolidationStatus(directory(scopeRequest(value))),
  );
  registerIpcHandler<[unknown], LocalMemoryConsolidationStatus>(
    IPC_CHANNELS.localMemoryConsolidate,
    async (_event, value) => {
      const scope = scopeRequest(value);
      // The trigger enforces the single-run guard and records the outcome.
      // The response is the fresh status with the run that just finished
      // layered on top, so a failed state write can never answer with the
      // pre-run outcome.
      const run = await runManualLocalMemoryConsolidation(scope);
      const status = await readLocalMemoryConsolidationStatus(directory(scope));
      if (!run.recorded) return status;
      const succeeded = run.outcome.result === 'success';
      return {
        ...status,
        lastRunAt: run.finishedAt,
        lastResult: run.outcome.result,
        lastReason: run.outcome.reason ?? null,
        ...(succeeded ? { lastConsolidatedAt: run.finishedAt } : {}),
      };
    },
  );
  registerIpcHandler<[unknown], LocalMemoryRebuildResponse>(
    IPC_CHANNELS.localMemoryRebuild,
    async (_event, value) => {
      const scope = scopeRequest(value);
      const rebuild = await runManualLocalMemoryRebuild(scope);
      const status = await readLocalMemoryConsolidationStatus(directory(scope));
      return { rebuild, status };
    },
  );
  registerIpcHandler<[unknown], LocalMemorySnapshotSummary[]>(
    IPC_CHANNELS.localMemoryListSnapshots,
    async (_event, value) =>
      listLocalMemorySnapshots(directory(scopeRequest(value))),
  );
  registerIpcHandler<[unknown], LocalMemorySnapshotRestoreResponse>(
    IPC_CHANNELS.localMemoryRestoreSnapshot,
    async (_event, value) =>
      restoreManualLocalMemorySnapshot(
        scopeRequest(value),
        field(record(value), 'snapshotId'),
      ),
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.localMemoryWatch,
    (event, value): void => {
      const scope = scopeRequest(value);
      watchLocalMemoryScope(scope, directory(scope), event.sender);
    },
  );
  registerIpcHandler<[unknown], void>(
    IPC_CHANNELS.localMemoryUnwatch,
    (event, value): void => {
      unwatchLocalMemoryScope(scopeRequest(value), event.sender.id);
    },
  );
}
