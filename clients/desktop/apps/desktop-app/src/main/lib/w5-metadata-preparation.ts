import {
  prepareW5ReadBinding,
  type W5MetadataCaptureOutcome,
  type W5PreparationFallbackReason,
} from './w5-commit-log-file-store';
import { readWorkspaceIndexStoredDetailed } from './sidebar-items';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from './workspace-persistence';

export type W5MetadataSlotResult<T> =
  | { status: 'fulfilled'; detail: T }
  | { status: 'rejected'; error: unknown };
export interface W5MetadataSlot<T> {
  consume(): Promise<W5MetadataSlotResult<T>>;
}
export type W5IndexDetail = Awaited<
  ReturnType<typeof readWorkspaceIndexStoredDetailed>
>;
export type W5ManifestDetail = Awaited<
  ReturnType<typeof readWorkspaceConfigDetailed>
>;
export type W5WorktreesDetail = Awaited<
  ReturnType<typeof readWorkspaceWorktreesDetailed>
>;

export interface PreparedW5Metadata {
  status: 'prepared';
  phase: symbol;
  outcome: W5MetadataCaptureOutcome;
  index: W5MetadataSlot<W5IndexDetail>;
  manifest(workspaceId: string): W5MetadataSlot<W5ManifestDetail>;
  worktrees(workspaceId: string): W5MetadataSlot<W5WorktreesDetail>;
  /** Join started decodes before effects or closing; tags never reject. */
  join(): Promise<void>;
  close(): void;
}
export type W5MetadataPreparation =
  | { status: 'fallback'; reason: W5PreparationFallbackReason; cause?: unknown }
  | PreparedW5Metadata;

export class W5MetadataPhaseClosedError extends Error {
  constructor() {
    super('This metadata phase has closed.');
    this.name = 'W5MetadataPhaseClosedError';
  }
}

/** Restore rejection at the caller's original operation, not after settleAll. */
export function consumeW5Metadata<T>(slot: W5MetadataSlot<T>): Promise<T> {
  return slot.consume().then(unwrapW5Metadata);
}

function unwrapW5Metadata<T>(result: W5MetadataSlotResult<T>): T {
  if (result.status === 'rejected') throw result.error;
  return result.detail;
}

export async function prepareW5Metadata(
  request: { kind: 'targeted'; workspaceId: string } | { kind: 'discovery' },
): Promise<W5MetadataPreparation> {
  const binding = await prepareW5ReadBinding({
    files:
      request.kind === 'targeted'
        ? [
            { kind: 'index' },
            { kind: 'index-backup' },
            { kind: 'manifest', workspaceId: request.workspaceId },
            { kind: 'worktrees', workspaceId: request.workspaceId },
          ]
        : [{ kind: 'index' }, { kind: 'index-backup' }],
    discoverWorkspaces: request.kind === 'discovery',
  });
  if (binding.status === 'fallback') return binding;
  const bind = binding.bind.bind(binding);
  let closed = false;
  const started: Promise<unknown>[] = [];
  function slot<T>(decode: () => Promise<T>): W5MetadataSlot<T> {
    let pending: Promise<W5MetadataSlotResult<T>> | undefined;
    return {
      consume: () => {
        if (closed)
          return Promise.resolve({
            status: 'rejected',
            error: new W5MetadataPhaseClosedError(),
          });
        if (!pending) {
          pending = Promise.resolve()
            .then(() => {
              if (closed) throw new W5MetadataPhaseClosedError();
              return bind(decode);
            })
            .then(
              (detail): W5MetadataSlotResult<T> => ({
                status: 'fulfilled',
                detail,
              }),
              (error: unknown): W5MetadataSlotResult<T> => ({
                status: 'rejected',
                error,
              }),
            );
          started.push(pending);
        }
        return pending;
      },
    };
  }
  const manifests = new Map<string, W5MetadataSlot<W5ManifestDetail>>();
  const lists = new Map<string, W5MetadataSlot<W5WorktreesDetail>>();
  // Even undeclared IDs decode only through the binding's missing-capture evidence.
  return {
    status: 'prepared',
    phase: Symbol('w5-metadata-phase'),
    outcome: binding.outcome,
    index: slot(readWorkspaceIndexStoredDetailed),
    manifest: (workspaceId) => {
      let value = manifests.get(workspaceId);
      if (!value) {
        value = slot(() => readWorkspaceConfigDetailed(workspaceId));
        manifests.set(workspaceId, value);
      }
      return value;
    },
    worktrees: (workspaceId) => {
      let value = lists.get(workspaceId);
      if (!value) {
        value = slot(() =>
          readWorkspaceWorktreesDetailed(workspaceId, {
            persistRemovalCleanup: false,
          }),
        );
        lists.set(workspaceId, value);
      }
      return value;
    },
    join: async () => {
      await Promise.all(started);
    },
    close: () => {
      closed = true;
    },
  };
}

/** Hints trigger the ordinary fresh locked repair, never a write from captured rows. */
export function readPreparedW5Worktrees(
  metadata: PreparedW5Metadata,
  workspaceId: string,
): Promise<W5WorktreesDetail> {
  // Unwrap at the same promise depth as manifest reads: an extra await here
  // reverses competing initial-stage failures for multi-repo entries.
  return metadata
    .worktrees(workspaceId)
    .consume()
    .then((result) => {
      const detail = unwrapW5Metadata(result);
      return detail.recentlyRemovedWorktreeIds?.length
        ? repairPreparedW5Worktrees(metadata, workspaceId)
        : detail;
    });
}

async function repairPreparedW5Worktrees(
  metadata: PreparedW5Metadata,
  workspaceId: string,
): Promise<W5WorktreesDetail> {
  await metadata.join();
  metadata.close();
  return readWorkspaceWorktreesDetailed(workspaceId);
}
