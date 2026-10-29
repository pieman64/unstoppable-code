import {
  parseProjectDiscoveryAction,
  type ProjectDiscoveryAction,
  type ProjectsListResult,
  type ProjectsListTasksResult,
  type ProjectsListTaskChatsResult,
  type ProjectTaskRow,
} from '@canopy/desktop-shared/lib/project-discovery';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { DiscoveryError } from './errors';
import { getCallerOwner, requireAuthorizedProject } from './owner-policy';
import { listProjectCandidates, hydrateProjectRow } from './projects-list';
import { listTaskRows } from './tasks-list';
import { listChatRows } from './chats-list';
import {
  cursorBinding,
  pageRows,
  toDiscoveryJson,
  validateCursor,
} from './paging';
import type { AppAdvisorActionResponse } from '@canopy/desktop-shared/types';

export type ProjectDiscoveryCaller =
  | {
      kind: 'project_agent';
      projectId: string;
      worktreeId: string;
      chatId: string;
    }
  | { kind: 'app_advisor'; chatId: string };

export { isProjectDiscoveryActionType } from '@canopy/desktop-shared/lib/project-discovery';

function sortValue(
  row: {
    title?: string;
    name?: string;
    createdAt?: string;
    lastActivityAt?: string;
  },
  sort: ProjectDiscoveryAction['sort'],
): string {
  if (sort === 'name') return (row.name ?? '').toLowerCase();
  if (sort === 'title') return (row.title ?? '').toLowerCase();
  return (sort === 'created_at' ? row.createdAt : row.lastActivityAt) ?? '';
}

/** Explicit metadata allowlist: activity, health and runtime samples stay live. */
function taskIncarnation(row: ProjectTaskRow): string {
  const details = row.details;
  return JSON.stringify({
    taskId: row.taskId,
    kind: row.kind,
    createdAt: row.createdAt,
    title: row.title,
    status: row.status,
    retentionState: row.retentionState,
    details:
      details.kind === 'work_entry'
        ? {
            kind: details.kind,
            pinned: details.pinned,
            titleOverride: details.titleOverride,
          }
        : {
            kind: details.kind,
            branchName: details.branchName,
            hidden: details.hidden,
            trackedBaseBranch: details.trackedBaseBranch,
            trackedRepoBaseBranches: details.trackedRepoBaseBranches,
          },
  });
}

async function bindingFor(
  action: ProjectDiscoveryAction,
  caller: ProjectDiscoveryCaller,
): Promise<string> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  const accountEpoch = service.accountEpoch();
  const owner = await getCallerOwner(caller);
  const target =
    action.type === 'projects.list'
      ? null
      : await requireAuthorizedProject(action.projectId, caller);
  // Authorization itself awaits metadata reads. Drain changes queued during
  // those reads before accepting an account-bound result or continuation.
  await service.whenIdle();
  if (accountEpoch !== service.accountEpoch())
    throw new DiscoveryError(
      'cursor_context_changed',
      'This listing context changed. Restart the listing.',
    );
  return (
    cursorBinding(action, caller, owner, accountEpoch) +
    JSON.stringify(
      target
        ? {
            owner: target.owner,
            readiness: target.readiness,
            incarnation: target.incarnation,
          }
        : null,
    )
  );
}

export async function dispatchProjectDiscoveryAction(
  action: ProjectDiscoveryAction,
  caller: ProjectDiscoveryCaller,
): Promise<Omit<AppAdvisorActionResponse, 'requestId'>> {
  const parsed = parseProjectDiscoveryAction(action);
  if (!parsed.ok)
    return {
      ok: false,
      error: { code: 'invalid_payload', message: parsed.message },
    };
  const input = parsed.action;
  try {
    validateCursor(input.cursor);
    const binding = await bindingFor(input, caller);
    validateCursor(input.cursor, binding);
    let result:
      | ProjectsListResult
      | ProjectsListTasksResult
      | ProjectsListTaskChatsResult;
    if (input.type === 'projects.list') {
      const candidates = await listProjectCandidates(input, caller);
      const page = pageRows(
        candidates,
        input,
        binding,
        (candidate) => ({
          id: candidate.projectId,
          incarnation: candidate.incarnation,
        }),
        (candidate) => sortValue(candidate, input.sort),
      );
      const items = [];
      for (const candidate of page.items)
        items.push(await hydrateProjectRow(candidate));
      // Recheck the page's target owners after asynchronous metadata reads.
      const authorizedNow = await listProjectCandidates(input, caller);
      for (const candidate of page.items) {
        const current = authorizedNow.find(
          (row) => row.projectId === candidate.projectId,
        );
        if (
          !current ||
          current.incarnation !== candidate.incarnation ||
          JSON.stringify(current.owner) !== JSON.stringify(candidate.owner)
        ) {
          throw new DiscoveryError(
            'cursor_context_changed',
            'This listing context changed. Restart the listing.',
          );
        }
      }
      result = { ...page, items };
    } else if (input.type === 'projects.list_tasks') {
      const runtimeFiltered = input.hasRunningChats !== undefined;
      const readInput =
        input.cursor && runtimeFiltered
          ? { ...input, hasRunningChats: undefined }
          : input;
      const { items, projectType } = await listTaskRows(readInput, caller);
      const page = pageRows(
        items,
        input,
        binding,
        (row) => ({
          id: row.taskId,
          incarnation: taskIncarnation(row),
        }),
        (row) => sortValue(row, input.sort),
        true,
      );
      result = { ...page, projectId: input.projectId, projectType };
    } else {
      const runtimeFiltered =
        input.runtimeStates !== undefined ||
        input.hasQueuedMessages !== undefined;
      const readInput =
        input.cursor && runtimeFiltered
          ? { ...input, runtimeStates: undefined, hasQueuedMessages: undefined }
          : input;
      const items = await listChatRows(readInput, caller);
      const page = pageRows(
        items,
        input,
        binding,
        (row) => ({
          id: JSON.stringify([row.taskId, row.chatId]),
          incarnation: JSON.stringify({
            createdAt: row.createdAt,
            title: row.title,
            retentionState: row.retentionState,
            providerType: row.providerType,
            executionHarness: row.executionHarness,
          }),
        }),
        (row) => sortValue(row, input.sort),
        true,
      );
      result = {
        ...page,
        projectId: input.projectId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      };
    }
    if (binding !== (await bindingFor(input, caller)))
      throw new DiscoveryError(
        'cursor_context_changed',
        'This listing context changed. Restart the listing.',
      );
    return { ok: true, result: toDiscoveryJson(result) };
  } catch (error) {
    if (error instanceof DiscoveryError) {
      if (
        input.cursor &&
        (error.code === 'owner_context_unavailable' ||
          error.code === 'not_found')
      ) {
        return {
          ok: false,
          error: {
            code: 'cursor_context_changed',
            message: 'This listing context changed. Restart the listing.',
          },
        };
      }
      return { ok: false, error: { code: error.code, message: error.message } };
    }
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Project discovery metadata could not be read.',
      },
    };
  }
}
