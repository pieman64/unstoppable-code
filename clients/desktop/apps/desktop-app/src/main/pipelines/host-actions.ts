/**
 * Desktop main's `PipelineHostActions`: the core-side policy point for host
 * steps (`runs.using: host`).
 *
 * The shared executor (worker side) validates inputs and raises one typed
 * request; this adapter resolves the task, applies the owner check and does
 * the work through main-owned services. Typed refusals become failure results
 * that keep every action output; unexpected errors are logged and rethrown so
 * the step fails with their message.
 *
 * Idempotency: the request's key arrives in `caller.idempotencyKey`. Group
 * membership is idempotent by construction (re-running yields the same
 * membership; only `group_created` reads `false` on the re-run), so no receipt
 * is recorded. Later host actions with side effects
 * use their domain's keyed receipts.
 *
 * Group names are user text: never logged, and errors name only IDs.
 */
import {
  APP_ADVISOR_PROJECT_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  emptyMoveToGroupOutputs,
  PipelineHostRefusal,
  type MoveToGroupInputs,
  type MoveToGroupNotGroupedReason,
} from '@canopy/desktop-shared/pipelines/host-actions';
import type { SidebarItemGroupScope } from '@canopy/protocol/sidebar';
import type {
  PipelineHostActionCaller,
  PipelineHostActionRequest,
  PipelineHostActionResult,
  PipelineHostActions,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktreesDetailed,
} from '../lib/workspace-persistence';
import { readWorkEntriesFileStrict } from '../lib/cowork-work-entries';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import { isWritableScope } from '../lib/read-only-scope';
import { logMainProcessError } from '../lib/main-process-logging';
import {
  sidebarItemGroupsService,
  SidebarItemGroupRefusalError,
} from '../services/sidebar-item-groups-service';

export type PipelineHostTarget =
  | {
      kind: 'project';
      projectId: string;
      taskId: string;
      workspaceType: WorkspaceType;
    }
  | { kind: 'bot'; botId: 'app_advisor'; taskId: string };

/**
 * Owner-policy seam for CAN-4541. Default allows; CAN-4541 supplies the check
 * that compares the execution owner with the project's saved owner (bots
 * exempt). Throw `PipelineHostRefusal` to refuse.
 */
export type PipelineHostOwnerCheck = (
  caller: PipelineHostActionCaller,
  target: PipelineHostTarget,
) => Promise<void>;

interface ResolvedTask {
  target: PipelineHostTarget;
  scope: SidebarItemGroupScope;
}

const APP_ADVISOR_BOT_ID = 'app_advisor';

function taskNotInProject(taskId: string, projectId: string): string {
  return `Task \`${taskId}\` isn't in project \`${projectId}\``;
}

function projectUnavailable(projectId: string): string {
  return `Project \`${projectId}\` isn't available to this pipeline`;
}

/** A missing file reads as empty; any other read error is unexpected and propagates. */
async function hasWorkEntry(
  workspaceId: string,
  entryId: string,
): Promise<boolean> {
  const { entries } = await readWorkEntriesFileStrict(workspaceId);
  return entries.some((entry) => entry.id === entryId);
}

/**
 * Reads the persisted list only: no worktree stats, fetch or cleanup write. A
 * miss is proof only when the list was read completely (or doesn't exist yet).
 */
async function hasWorktree(
  projectId: string,
  worktreeId: string,
): Promise<boolean> {
  const { worktrees, authority } = await readWorkspaceWorktreesDetailed(
    projectId,
    { persistRemovalCleanup: false },
  );
  if (worktrees.some((worktree) => worktree.id === worktreeId)) return true;
  if (authority === 'ok' || authority === 'absent') return false;
  throw new Error(
    `Worktrees for project \`${projectId}\` couldn't be fully read`,
  );
}

/** Null only for a missing project; an unreadable config is a read error, not a miss. */
async function readProjectType(
  projectId: string,
  workspaceId: string,
): Promise<WorkspaceType | null> {
  const detail = await readWorkspaceConfigDetailed(workspaceId);
  if (detail.authority === 'unreadable') {
    throw new Error(`Project \`${projectId}\` couldn't be read`);
  }
  return detail.authority === 'ok' ? detail.config.type : null;
}

/** Throws `PipelineHostRefusal('not_found')` for any miss. */
async function resolveTask(
  task: MoveToGroupInputs['task'],
): Promise<ResolvedTask> {
  if (task.kind === 'bot') {
    if (task.botId !== APP_ADVISOR_BOT_ID) {
      throw new PipelineHostRefusal(
        'not_found',
        `Bot \`${task.botId}\` isn't available to this pipeline`,
      );
    }
    if (!(await hasWorkEntry(APP_ADVISOR_PROJECT_ID, task.taskId))) {
      throw new PipelineHostRefusal(
        'not_found',
        `Task \`${task.taskId}\` isn't in bot \`${APP_ADVISOR_BOT_ID}\``,
      );
    }
    return {
      target: { kind: 'bot', botId: APP_ADVISOR_BOT_ID, taskId: task.taskId },
      scope: { appAdvisor: true },
    };
  }

  // Bots are addressed only through `bot_id`, and the read-only
  // shared-container viewer isn't a project a pipeline can change.
  if (
    task.projectId === APP_ADVISOR_PROJECT_ID ||
    !isWritableScope(task.projectId)
  ) {
    throw new PipelineHostRefusal(
      'not_found',
      projectUnavailable(task.projectId),
    );
  }
  // A legacy cowork chat-project id reads through its workspace, as the
  // sidebar service resolves it.
  const workspaceId = resolveCoworkWorkspaceId(task.projectId);
  const workspaceType = await readProjectType(task.projectId, workspaceId);
  if (workspaceType === null) {
    throw new PipelineHostRefusal(
      'not_found',
      projectUnavailable(task.projectId),
    );
  }
  const found =
    workspaceType === 'cowork'
      ? await hasWorkEntry(workspaceId, task.taskId)
      : await hasWorktree(workspaceId, task.taskId);
  if (!found) {
    throw new PipelineHostRefusal(
      'not_found',
      taskNotInProject(task.taskId, task.projectId),
    );
  }
  return {
    target: {
      kind: 'project',
      projectId: task.projectId,
      taskId: task.taskId,
      workspaceType,
    },
    // The sidebar service maps cowork ids in its own scope resolution.
    scope: { workspaceLocalId: task.projectId },
  };
}

function notGrouped(
  reason: MoveToGroupNotGroupedReason,
): Record<string, string> {
  return {
    group_id: '',
    group_name: '',
    group_created: 'false',
    grouped: 'false',
    not_grouped_reason: reason,
  };
}

function grouped(
  groupId: string,
  groupName: string,
  created: boolean,
): Record<string, string> {
  return {
    group_id: groupId,
    group_name: groupName,
    group_created: String(created),
    grouped: 'true',
    not_grouped_reason: '',
  };
}

/** Group problems never fail the step (D12): a refusal is a successful `grouped: false`. */
async function applyGroupTarget(
  scope: SidebarItemGroupScope,
  taskId: string,
  target: MoveToGroupInputs['target'],
): Promise<Record<string, string>> {
  try {
    switch (target.kind) {
      case 'remove':
        await sidebarItemGroupsService.moveItem({
          scope,
          itemId: taskId,
          groupId: null,
        });
        return notGrouped('removed');
      case 'id': {
        await sidebarItemGroupsService.moveItem({
          scope,
          itemId: taskId,
          groupId: target.groupId,
        });
        const groups = await sidebarItemGroupsService.list(scope);
        const group = groups.find(
          (candidate) => candidate.id === target.groupId,
        );
        return grouped(target.groupId, group?.name ?? '', false);
      }
      case 'name': {
        const { group, created } =
          await sidebarItemGroupsService.assignItemToNamedGroup({
            scope,
            itemId: taskId,
            name: target.name,
            ...(target.color ? { color: target.color } : {}),
          });
        return grouped(group.id, group.name, created);
      }
    }
  } catch (error) {
    if (error instanceof SidebarItemGroupRefusalError) {
      return notGrouped(error.code);
    }
    throw error;
  }
}

async function runMoveToGroup(
  inputs: MoveToGroupInputs,
  caller: PipelineHostActionCaller,
  assertTargetOwner: PipelineHostOwnerCheck,
  signal: AbortSignal,
): Promise<PipelineHostActionResult> {
  const { target, scope } = await resolveTask(inputs.task);
  await assertTargetOwner(caller, target);
  // The executor has already reported a withdrawn step; don't start a sidebar change after it.
  signal.throwIfAborted();
  const outputs = await applyGroupTarget(scope, target.taskId, inputs.target);
  return { status: 'success', outputs };
}

const allowAnyOwner: PipelineHostOwnerCheck = () => Promise.resolve();

export function createDesktopPipelineHostActions(deps?: {
  assertTargetOwner?: PipelineHostOwnerCheck;
}): PipelineHostActions {
  const assertTargetOwner = deps?.assertTargetOwner ?? allowAnyOwner;
  return {
    async run(
      request: PipelineHostActionRequest,
      caller: PipelineHostActionCaller,
      signal: AbortSignal,
    ): Promise<PipelineHostActionResult> {
      try {
        switch (request.action) {
          case 'move-to-group':
            return await runMoveToGroup(
              request.inputs,
              caller,
              assertTargetOwner,
              signal,
            );
        }
      } catch (error) {
        if (error instanceof PipelineHostRefusal) {
          return {
            status: 'failure',
            failureReason: error.failureReason,
            error: error.message,
            outputs: emptyMoveToGroupOutputs(),
          };
        }
        // The error itself is recorded; the request (and its group name) is not.
        if (!signal.aborted) {
          logMainProcessError('Pipeline host action failed', error);
        }
        throw error;
      }
    },
  };
}
