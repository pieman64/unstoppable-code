import { randomUUID } from 'node:crypto';
import { CHILD_TOOLS_ENDED_EVENT_TYPE } from '@canopy/agent-transcript';
import type { ActivityLiveBgTask } from '@canopy/desktop-shared/types/activity-panel';
import { getChatStateService } from '../services/chat-state-service';
import type {
  ProviderEventIngestResult,
  ProviderEventInput,
} from '../services/chat-state-service';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { drainCurrentSessionEvents } from './session-event-router';
import {
  listLiveBackgroundTaskOwners,
  subscribeLiveBackgroundTasks,
} from './session-manager';
import type { LiveBackgroundTaskOwner } from './session-manager';

type SettlementTarget = Pick<
  LiveBackgroundTaskOwner,
  'projectId' | 'worktreeId' | 'chatId'
>;

interface SettlementBatch {
  target: SettlementTarget;
  toolUseIds: string[];
  mutationId: string;
}

export interface ChildToolsSettlementDependencies {
  listLiveBackgroundTaskOwners: typeof listLiveBackgroundTaskOwners;
  subscribeLiveBackgroundTasks: typeof subscribeLiveBackgroundTasks;
  drainCurrentSessionEvents: typeof drainCurrentSessionEvents;
  ingestProviderEvent: (
    input: ProviderEventInput,
  ) => Promise<ProviderEventIngestResult>;
}

export interface ChildToolsSettlementHandle {
  stop(): void;
  drain(): Promise<void>;
}

function snapshotTasks(
  tasks: readonly ActivityLiveBgTask[],
): Map<string, ActivityLiveBgTask> {
  return new Map(tasks.map((task) => [task.taskId, { ...task }]));
}

function defaultDependencies(): ChildToolsSettlementDependencies {
  return {
    listLiveBackgroundTaskOwners,
    subscribeLiveBackgroundTasks,
    drainCurrentSessionEvents,
    ingestProviderEvent: (input) =>
      getChatStateService().ingestProviderEventWithResult(input),
  };
}

/**
 * Close retained child controls after their live agent task disappears. The
 * task listener runs during provider bookkeeping, before that frame is handed
 * to the session router. Snapshot task edges synchronously, then defer the
 * router drain and canonical commit to a microtask so the current provider
 * frame is part of the drain prefix. Never await this work from that provider
 * callback: it would wait on its own router receipt.
 */
export function startChildToolsSettlement(
  injectedDependencies: Partial<ChildToolsSettlementDependencies> = {},
): ChildToolsSettlementHandle {
  const defaults = defaultDependencies();
  const dependencies: ChildToolsSettlementDependencies = {
    ...defaults,
    ...injectedDependencies,
  };
  const previousTasksBySession = new Map<
    string,
    Map<string, ActivityLiveBgTask>
  >();
  const targetsBySession = new Map<string, SettlementTarget>();
  const pendingBatchesBySession = new Map<string, SettlementBatch[]>();
  const scheduledSessions = new Set<string>();
  const ingestionTails = new Map<string, Promise<void>>();
  let stopped = false;

  const flushSession = async (sessionKey: string): Promise<void> => {
    const batches = pendingBatchesBySession.get(sessionKey);
    if (!batches) return;

    while (batches.length > 0) {
      const batch = batches[0];
      if (!batch) break;
      // Admission belongs to the canonical chat-state service. This emitter
      // reports every live-task edge immediately after the current router
      // prefix; it must not hold a removal until the parent turn settles.
      await dependencies.drainCurrentSessionEvents(batch.target);

      const result = await dependencies.ingestProviderEvent({
        ...batch.target,
        mutationId: batch.mutationId,
        data: {
          type: CHILD_TOOLS_ENDED_EVENT_TYPE,
          parent_tool_use_ids: batch.toolUseIds,
        },
      });
      if (result.outcome !== 'applied') {
        logMainProcessWarn(
          `[child-tools-settlement] Canonical ingest declined settlement for ${sessionKey}`,
          { outcome: result.outcome },
        );
      }
      batches.shift();
    }

    pendingBatchesBySession.delete(sessionKey);
  };

  const scheduleFlush = (sessionKey: string): void => {
    if (scheduledSessions.has(sessionKey)) return;
    scheduledSessions.add(sessionKey);
    queueMicrotask(() => {
      scheduledSessions.delete(sessionKey);
      const previous = ingestionTails.get(sessionKey) ?? Promise.resolve();
      const next = previous
        .then(() => flushSession(sessionKey))
        .catch((error: unknown) => {
          logMainProcessWarn(
            `[child-tools-settlement] Failed to settle live child tools for ${sessionKey}`,
            error,
          );
        });
      ingestionTails.set(sessionKey, next);
      void next.then(() => {
        if (ingestionTails.get(sessionKey) === next) {
          ingestionTails.delete(sessionKey);
        }
      });
    });
  };

  const onLiveTasksChanged = (sessionKey: string): void => {
    if (stopped) return;
    const owner = dependencies
      .listLiveBackgroundTaskOwners()
      .find((candidate) => candidate.sessionKey === sessionKey);
    const previous =
      previousTasksBySession.get(sessionKey) ??
      new Map<string, ActivityLiveBgTask>();
    const current: Map<string, ActivityLiveBgTask> = owner
      ? snapshotTasks(owner.liveTasks)
      : new Map<string, ActivityLiveBgTask>();

    if (owner) {
      previousTasksBySession.set(sessionKey, current);
      targetsBySession.set(sessionKey, {
        projectId: owner.projectId,
        worktreeId: owner.worktreeId,
        chatId: owner.chatId,
      });
    }
    const target = targetsBySession.get(sessionKey);
    if (!owner) {
      // An ended session reports nothing more; its batch keeps the target.
      previousTasksBySession.delete(sessionKey);
      targetsBySession.delete(sessionKey);
    }
    if (!target) return;
    const toolUseIds = new Set<string>();
    for (const [taskId, task] of Array.from(previous.entries())) {
      if (current.has(taskId)) continue;
      if (task.taskType === 'local_bash' || task.taskType === 'mcp_task') {
        continue;
      }
      if (task.toolUseId) toolUseIds.add(task.toolUseId);
    }
    if (toolUseIds.size === 0) return;

    const batches = pendingBatchesBySession.get(sessionKey) ?? [];
    batches.push({
      target,
      toolUseIds: Array.from(toolUseIds),
      mutationId: `child-tools-settlement:${randomUUID()}`,
    });
    pendingBatchesBySession.set(sessionKey, batches);
    scheduleFlush(sessionKey);
  };

  const unsubscribeLiveTasks =
    dependencies.subscribeLiveBackgroundTasks(onLiveTasksChanged);
  for (const owner of dependencies.listLiveBackgroundTaskOwners()) {
    targetsBySession.set(owner.sessionKey, {
      projectId: owner.projectId,
      worktreeId: owner.worktreeId,
      chatId: owner.chatId,
    });
    previousTasksBySession.set(
      owner.sessionKey,
      snapshotTasks(owner.liveTasks),
    );
  }

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribeLiveTasks();
    },
    async drain(): Promise<void> {
      for (const sessionKey of Array.from(pendingBatchesBySession.keys())) {
        scheduleFlush(sessionKey);
      }
      // A scheduled microtask captures the router's received prefix before
      // adding its ingestion tail. Queue one reaction behind those tasks.
      await Promise.resolve();
      await Promise.all(Array.from(ingestionTails.values()));
    },
  };
}
