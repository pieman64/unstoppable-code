/**
 * Moves unattended executable items with a workspace whose owner changed
 * (CAN-3543). Automations, App Advisor watchers and chat/pipeline hook actions
 * persist the Personal or organization context they run in; when the
 * workspace they target moves between Personal and an organization, items
 * still bound to the previous owner (or never bound) are rebound to the new
 * one so they keep running instead of failing with `context-mismatch`.
 *
 * The rebinder is keyed only by workspace id and the two owner contexts, so
 * every ownership transition (Personal to organization, a move back, or a
 * later re-binding such as CAN-3571's org project change) uses the same entry
 * point. A transition that keeps the context is a no-op. Each item store
 * keeps its own single writer; this module only sequences them.
 */
import {
  isSameWorkspaceContext,
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import type { WorkspaceConfigFile } from '@canopy/desktop-shared/types';
import { logMainProcessError } from '../lib/main-process-logging';

export type BackgroundExecutionRebindReason =
  /** The workspace's ownership was just written (conversion or move back). */
  | 'ownership-change'
  /** One-time sweep of workspaces converted before rebinding existed. */
  | 'startup-repair'
  /** A run found its target moved and the account may follow it. */
  | 'runtime-mismatch';

export type BackgroundExecutionItemType = 'automation' | 'watcher' | 'hook';

/** A workspace's owner changed from `from` to `to`. */
export interface WorkspaceOwnershipChange {
  workspaceId: string;
  from: WorkspaceContext;
  to: WorkspaceContext;
}

/** What each item store receives: serialized contexts, as they persist them. */
export interface BackgroundExecutionStoreRebind {
  workspaceId: string;
  previousContext: string;
  nextContext: string;
}

export interface BackgroundExecutionItemStore {
  itemType: BackgroundExecutionItemType;
  /**
   * Rebind items whose destination is `workspaceId` and whose binding is
   * `previousContext` or absent; returns the ids it changed.
   */
  rebind(input: BackgroundExecutionStoreRebind): Promise<string[]>;
}

export interface BackgroundExecutionRebindRecord extends BackgroundExecutionStoreRebind {
  reason: BackgroundExecutionRebindReason;
  itemType: BackgroundExecutionItemType;
  itemId: string;
}

export interface BackgroundExecutionContextRebinderDeps {
  stores: readonly BackgroundExecutionItemStore[];
  /** Ownership changes recorded on every workspace (`ownershipTransfer`). */
  listRecordedOwnershipChanges(): Promise<WorkspaceOwnershipChange[]>;
  hasStartupRepairRun(): Promise<boolean>;
  markStartupRepairRun(): Promise<void>;
  recordRebind(record: BackgroundExecutionRebindRecord): void;
}

export interface BackgroundExecutionContextRebinder {
  /**
   * Rebind every store for one ownership change. Stores run independently:
   * a failing store does not stop the others, and the call rejects after
   * all of them settle when any failed.
   */
  rebindWorkspace(
    change: WorkspaceOwnershipChange,
    reason: BackgroundExecutionRebindReason,
  ): Promise<BackgroundExecutionRebindRecord[]>;
  /**
   * Repair workspaces converted (or moved back) before rebinding existed.
   * Runs once: the marker is written only after every workspace succeeded,
   * so a failure is retried on the next start.
   */
  repairRecordedOwnershipChanges(): Promise<void>;
}

/**
 * The ownership change a workspace's `ownershipTransfer` records, or `null`
 * when it records none (never converted, or an inconsistent record).
 */
export function recordedOwnershipChange(
  workspaceId: string,
  config: Pick<WorkspaceConfigFile, 'owner' | 'ownershipTransfer'>,
): WorkspaceOwnershipChange | null {
  const transfer = config.ownershipTransfer;
  if (!transfer) return null;
  const organization: WorkspaceContext = {
    kind: 'organization',
    organizationId: transfer.organizationId,
  };
  if (transfer.movedBackAt === undefined)
    return config.owner?.organizationId === transfer.organizationId
      ? { workspaceId, from: { kind: 'personal' }, to: organization }
      : null;
  return config.owner === undefined
    ? { workspaceId, from: organization, to: { kind: 'personal' } }
    : null;
}

export function createBackgroundExecutionContextRebinder(
  deps: BackgroundExecutionContextRebinderDeps,
): BackgroundExecutionContextRebinder {
  async function rebindWorkspace(
    change: WorkspaceOwnershipChange,
    reason: BackgroundExecutionRebindReason,
  ): Promise<BackgroundExecutionRebindRecord[]> {
    if (isSameWorkspaceContext(change.from, change.to)) return [];
    const input: BackgroundExecutionStoreRebind = {
      workspaceId: change.workspaceId,
      previousContext: serializeWorkspaceContext(change.from),
      nextContext: serializeWorkspaceContext(change.to),
    };
    const settled = await Promise.allSettled(
      deps.stores.map(async (store) => ({
        itemType: store.itemType,
        ids: await store.rebind(input),
      })),
    );
    const records: BackgroundExecutionRebindRecord[] = [];
    const failures: unknown[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        failures.push(outcome.reason);
        continue;
      }
      for (const itemId of outcome.value.ids)
        records.push({
          ...input,
          reason,
          itemType: outcome.value.itemType,
          itemId,
        });
    }
    for (const record of records) deps.recordRebind(record);
    const [failure] = failures;
    if (failure !== undefined)
      throw failure instanceof Error
        ? failure
        : new Error(
            `Could not rebind background items for workspace ${change.workspaceId}`,
          );
    return records;
  }

  async function repairRecordedOwnershipChanges(): Promise<void> {
    if (await deps.hasStartupRepairRun()) return;
    let failed = false;
    for (const change of await deps.listRecordedOwnershipChanges()) {
      try {
        await rebindWorkspace(change, 'startup-repair');
      } catch (error) {
        failed = true;
        logMainProcessError(
          'Failed to repair background execution bindings for a moved project:',
          error,
        );
      }
    }
    if (!failed) await deps.markStartupRepairRun();
  }

  return { rebindWorkspace, repairRecordedOwnershipChanges };
}

const STARTUP_REPAIR_MIGRATION_KEY = 'background_execution_owner_rebind_v1';

function createProductionDeps(): BackgroundExecutionContextRebinderDeps {
  return {
    stores: [
      {
        itemType: 'automation',
        rebind: async (input): Promise<string[]> =>
          (await import('../automations/service'))
            .getAutomationsService()
            .rebindWorkspaceExecutionContexts(input),
      },
      {
        itemType: 'watcher',
        rebind: async (input): Promise<string[]> =>
          (await import('../app-advisor/watchers'))
            .getAppAdvisorWatcherService()
            .rebindWorkspaceExecutionContexts(input),
      },
      {
        itemType: 'hook',
        rebind: async (input): Promise<string[]> =>
          (
            await import('../lib/workspace-ownership')
          ).rebindWorkspaceHookExecutionContexts({
            ...input,
            source: 'background_execution_rebinding',
          }),
      },
    ],
    listRecordedOwnershipChanges: async (): Promise<
      WorkspaceOwnershipChange[]
    > => {
      const { readAllSidebarItemsSnapshot } =
        await import('../lib/sidebar-items');
      const { readWorkspaceConfigDetailed } =
        await import('../lib/workspace-persistence');
      const { file, authority } = await readAllSidebarItemsSnapshot();
      // Without every workspace a converted one could be missed, and the
      // marker would then skip it for good.
      if (authority !== 'ok' && authority !== 'absent')
        throw new Error('Workspace list is incomplete');
      const changes: WorkspaceOwnershipChange[] = [];
      for (const entry of file.items) {
        const read = await readWorkspaceConfigDetailed(entry.id);
        if (read.authority === 'absent') continue;
        if (read.authority !== 'ok' || read.ownerMalformed)
          throw new Error(`Workspace ${entry.id} is unreadable`);
        const change = recordedOwnershipChange(entry.id, read.config);
        if (change) changes.push(change);
      }
      return changes;
    },
    hasStartupRepairRun: async (): Promise<boolean> =>
      (await import('../lib/migrations')).hasMigrationRun(
        STARTUP_REPAIR_MIGRATION_KEY,
      ),
    markStartupRepairRun: async (): Promise<void> =>
      (await import('../lib/migrations')).markMigrationRun(
        STARTUP_REPAIR_MIGRATION_KEY,
      ),
    recordRebind: (record): void => {
      void import('../observability')
        .then(({ getObservabilityService }): void => {
          getObservabilityService().recordSessionDiagnostic({
            version: 1,
            timestamp: new Date().toISOString(),
            kind: 'background_execution_context_rebound',
            sessionKey: `background-execution-rebind:${record.workspaceId}`,
            projectId: record.workspaceId,
            worktreeId: '',
            chatId: '',
            providerType: 'unknown',
            backgroundExecutionRebindItemType: record.itemType,
            backgroundExecutionRebindItemId: record.itemId,
            backgroundExecutionRebindPreviousContext: record.previousContext,
            backgroundExecutionRebindNextContext: record.nextContext,
            backgroundExecutionRebindReason: record.reason,
          });
        })
        .catch((error: unknown): void => {
          logMainProcessError(
            'Failed to record a background execution rebind:',
            error,
          );
        });
    },
  };
}

let singleton: BackgroundExecutionContextRebinder | null = null;

export function getBackgroundExecutionContextRebinder(): BackgroundExecutionContextRebinder {
  singleton ??= createBackgroundExecutionContextRebinder(
    createProductionDeps(),
  );
  return singleton;
}
