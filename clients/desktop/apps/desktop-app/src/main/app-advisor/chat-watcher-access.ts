import {
  legacyChatWatcherToCanonical,
  type CanonicalChatWatcherEntry,
  type ChatWatcherAvailability,
  type ChatWatcherEvidence,
  type ResolvedChatWatcherTarget,
  type TrustedChatWatcherRecipient,
  type UnresolvedLegacyChatWatcher,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  type ProjectOwnerContext,
} from '@canopy/desktop-shared/types';
import { isRetiredPlanChatScope } from '@canopy/desktop-shared/lib/retired-chat-scopes';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import {
  assertWorkspaceTargetRuntimeStartAllowed,
  isWorkspaceTargetRemovalPending,
} from '../lib/workspace-target-exclusion';
import type { ProjectDiscoveryCaller } from '../project-discovery';
import {
  getCallerOwner,
  requireAuthorizedProject,
} from '../project-discovery/owner-policy';
import {
  resolveAuthorizedChat,
  type ChatReadContext,
} from '../project-discovery/chat-target';
import { listDiscoverableTaskIds } from '../project-discovery/chats-list';
import { readTaskRuntimeSnapshot } from '../project-discovery/runtime-state';
import {
  readProjectEntries,
  readProjectWorktrees,
} from '../project-discovery/sources';
import { requireBot } from '../project-discovery/bots/registry';
import {
  isBotTaskEligible,
  readBotEntries,
  requireBotAccess,
  resolveBotReadBinding,
} from '../project-discovery/bots/target';

/** Safe to project: never propagate target-derived errors from policy/storage. */
export class ChatWatcherAccessError extends Error {
  public constructor(public readonly reason: ChatWatcherAvailability) {
    super('Chat watcher access is unavailable.');
    this.name = 'ChatWatcherAccessError';
  }
}

export type ChatWatcherAccessDecision =
  | {
      allowed: true;
      target: ResolvedChatWatcherTarget;
      caller: ProjectDiscoveryCaller;
      accountEpoch: number;
      sourceOwner: ProjectOwnerContext | null;
      resourceIncarnation: string;
      /** Main-only, authorized scope for TranscriptReader's bound turn query. */
      context?: ChatReadContext;
    }
  | { allowed: false; reason: ChatWatcherAvailability };

export type LegacyChatWatcherAccessResolution =
  | {
      ok: true;
      entry: CanonicalChatWatcherEntry;
      target: ResolvedChatWatcherTarget;
    }
  | { ok: false; reason: ChatWatcherAvailability };

const resourceCaller: ProjectDiscoveryCaller = {
  kind: 'app_advisor',
  chatId: 'chat-watcher-resource-policy',
};

function callerFor(
  trusted: TrustedChatWatcherRecipient,
): ProjectDiscoveryCaller {
  const { destination, recipient } = trusted;
  // Reject inconsistent main-side identities rather than silently switching a
  // delegate's authority or letting a destination decoration create a delegate.
  if (
    (recipient.kind === 'root' && destination.delegationId !== undefined) ||
    (recipient.kind === 'delegate' &&
      (!recipient.delegationId ||
        (destination.delegationId !== undefined &&
          destination.delegationId !== recipient.delegationId)))
  ) {
    throw new ChatWatcherAccessError('runtime_unavailable');
  }
  return destination.projectId === APP_ADVISOR_PROJECT_ID
    ? { kind: 'app_advisor', chatId: destination.chatId }
    : {
        kind: 'project_agent',
        projectId: destination.projectId,
        worktreeId: destination.worktreeId,
        chatId: destination.chatId,
      };
}

function sameOwner(
  left: ProjectOwnerContext | null,
  right: ProjectOwnerContext | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    (left.kind === 'personal' ||
      (right.kind === 'organization' &&
        left.organizationId.toLowerCase() ===
          right.organizationId.toLowerCase()))
  );
}

class AccountChangedDuringRead extends Error {}

/** Every await drains already queued account transitions before using its result. */
async function coherentRead<T>(
  epoch: number,
  read: () => Promise<T>,
): Promise<T> {
  const result = await read().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const service = getWorkspaceContextService();
  await service.whenIdle();
  if (service.accountEpoch() !== epoch) throw new AccountChangedDuringRead();
  if (!result.ok) throw result.error;
  return result.value;
}

async function beginRead(): Promise<number> {
  const service = getWorkspaceContextService();
  await service.initialize();
  await service.whenIdle();
  return service.accountEpoch();
}

function assertLiveScope(projectId: string, taskId?: string): void {
  if (isRetiredPlanChatScope(projectId))
    throw new ChatWatcherAccessError('runtime_unavailable');
  if (taskId === undefined) return;
  if (
    taskId === COWORK_HOME_WORKTREE_ID ||
    isWorkspaceTargetRemovalPending(projectId, taskId)
  ) {
    throw new ChatWatcherAccessError('runtime_unavailable');
  }
  assertWorkspaceTargetRuntimeStartAllowed(projectId, taskId);
}

type ResourceSnapshot = {
  binding: string;
  target: ResolvedChatWatcherTarget;
  sourceOwner: ProjectOwnerContext | null;
  resourceIncarnation: string;
  context?: ChatReadContext;
};

/**
 * Discovery's JSON incarnation also contains mutable name/readiness metadata.
 * Project watcher evidence binds only stable identity/generation facts. Apply
 * the same projection to saved evidence so pre-change receipts survive renames;
 * opaque incarnation formats (including bot IDs) retain exact equality.
 */
export function normalizeChatWatcherResourceIncarnation(
  incarnation: string,
): string {
  try {
    const value: unknown = JSON.parse(incarnation);
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !('projectId' in value) ||
      typeof value.projectId !== 'string' ||
      !('type' in value) ||
      typeof value.type !== 'string'
    )
      return incarnation;
    return JSON.stringify({
      projectId: value.projectId,
      owner: 'owner' in value ? value.owner : undefined,
      type: value.type,
      binding: 'binding' in value ? value.binding : undefined,
      createdAt: 'createdAt' in value ? value.createdAt : undefined,
    });
  } catch {
    return incarnation;
  }
}

/** Advisor bypasses caller owner policy, never canonical resource eligibility. */
async function inspectResource(
  target: ResolvedChatWatcherTarget,
  epoch: number,
): Promise<ResourceSnapshot> {
  const { address } = target;
  if (target.kind === 'bot' && 'botId' in address) {
    const bot = requireBot(address.botId);
    assertLiveScope(bot.projectId, address.taskId);
    await coherentRead(epoch, () => requireBotAccess(resourceCaller));
    let taskCreatedAt: string | undefined;
    if (address.taskId !== undefined) {
      const entries = await coherentRead(epoch, () =>
        readBotEntries(bot.botId),
      );
      const entry = entries.find(
        (candidate) => candidate.id === address.taskId,
      );
      if (!entry || !isBotTaskEligible(entry))
        throw new ChatWatcherAccessError('runtime_unavailable');
      taskCreatedAt = entry.createdAt;
    }
    let context: ChatReadContext | undefined;
    if ('chatId' in address && address.taskId !== undefined) {
      const resolved = await coherentRead(epoch, () =>
        resolveBotReadBinding(
          {
            type: 'bots.get_last_agent_response',
            botId: address.botId,
            taskId: address.taskId,
            chatId: address.chatId,
          },
          resourceCaller,
        ),
      );
      context = resolved.context;
    }
    assertLiveScope(bot.projectId, address.taskId);
    return {
      target,
      sourceOwner: null,
      resourceIncarnation: bot.botId,
      binding: JSON.stringify([
        bot.botId,
        bot.projectId,
        address.taskId ?? null,
        taskCreatedAt ?? null,
        context?.tab.createdAt ?? null,
      ]),
      ...(context ? { context } : {}),
    };
  }
  if (target.kind !== 'project' || !('projectId' in address))
    throw new ChatWatcherAccessError('migration_required');
  assertLiveScope(address.projectId, address.taskId);
  const project = await coherentRead(epoch, () =>
    requireAuthorizedProject(address.projectId, resourceCaller),
  );
  if (project.readiness !== 'ready' || project.synthetic)
    throw new ChatWatcherAccessError('runtime_unavailable');
  if (project.type !== target.projectType)
    throw new ChatWatcherAccessError('migration_required');
  let taskCreatedAt: string | undefined;
  if (address.taskId !== undefined) {
    const ids = await coherentRead(epoch, () =>
      listDiscoverableTaskIds(address.projectId, project.type),
    );
    if (!ids.includes(address.taskId))
      throw new ChatWatcherAccessError('runtime_unavailable');
    const tasks =
      project.type === 'cowork'
        ? (
            await coherentRead(epoch, () =>
              readProjectEntries(address.projectId),
            )
          ).entries
        : await coherentRead(epoch, () =>
            readProjectWorktrees(address.projectId),
          );
    const task = tasks.find((candidate) => candidate.id === address.taskId);
    if (!task) throw new ChatWatcherAccessError('runtime_unavailable');
    taskCreatedAt = task.createdAt;
  }
  let context: ChatReadContext | undefined;
  if ('chatId' in address && address.taskId !== undefined) {
    const chatAddress = {
      projectId: address.projectId,
      taskId: address.taskId,
      chatId: address.chatId,
    };
    context = await coherentRead(epoch, () =>
      resolveAuthorizedChat(chatAddress, resourceCaller),
    );
  }
  assertLiveScope(address.projectId, address.taskId);
  const incarnation = normalizeChatWatcherResourceIncarnation(
    project.incarnation,
  );
  return {
    target,
    sourceOwner: project.owner,
    resourceIncarnation: incarnation,
    binding: JSON.stringify([
      incarnation,
      address.taskId ?? null,
      taskCreatedAt ?? null,
      context?.tab.createdAt ?? null,
    ]),
    ...(context ? { context } : {}),
  };
}

function failureReason(error: unknown): ChatWatcherAvailability {
  if (error instanceof ChatWatcherAccessError) return error.reason;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'advisor_access_disabled'
  ) {
    return 'advisor_access_disabled';
  }
  return 'runtime_unavailable';
}

/**
 * Current eligibility is sampled twice around caller policy. Comparing stable
 * resource facts catches owner/parent recreation without an account event;
 * runtime state, activity and transcript revision deliberately are not bindings.
 * Reinvoke after enrichment and at each delivery ingress, never cache an allow.
 */
export async function decideChatWatcherAccess(
  recipient: TrustedChatWatcherRecipient,
  target: ResolvedChatWatcherTarget,
  evidence?: ChatWatcherEvidence,
): Promise<ChatWatcherAccessDecision> {
  // A routine account refresh invalidates the sample, not the durable event.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const caller = callerFor(recipient);
      const accountEpoch = await beginRead();
      if (target.kind === 'bot')
        await coherentRead(accountEpoch, () => requireBotAccess(caller));
      const first = await inspectResource(target, accountEpoch);
      const owner = await coherentRead(accountEpoch, () =>
        getCallerOwner(caller),
      );
      if (
        target.kind === 'project' &&
        caller.kind !== 'app_advisor' &&
        !sameOwner(owner, first.sourceOwner)
      )
        throw new ChatWatcherAccessError('owner_boundary');
      if (target.kind === 'bot')
        await coherentRead(accountEpoch, () => requireBotAccess(caller));
      const latest = await inspectResource(target, accountEpoch);
      const latestOwner = await coherentRead(accountEpoch, () =>
        getCallerOwner(caller),
      );
      if (
        !sameOwner(owner, latestOwner) ||
        !sameOwner(first.sourceOwner, latest.sourceOwner) ||
        first.binding !== latest.binding
      )
        throw new ChatWatcherAccessError('runtime_unavailable');
      // Recheck setting after resource awaits, so a revoked gate never enriches.
      if (target.kind === 'bot')
        await coherentRead(accountEpoch, () => requireBotAccess(caller));
      if (evidence) {
        if (!sameOwner(evidence.sourceOwner, latest.sourceOwner))
          throw new ChatWatcherAccessError('owner_boundary');
        if (
          evidence.resourceIncarnation !== undefined &&
          normalizeChatWatcherResourceIncarnation(
            evidence.resourceIncarnation,
          ) !== latest.resourceIncarnation
        )
          throw new ChatWatcherAccessError('migration_required');
      }
      if (target.kind === 'bot')
        assertLiveScope(
          requireBot(target.address.botId).projectId,
          target.address.taskId,
        );
      else assertLiveScope(target.address.projectId, target.address.taskId);
      return {
        allowed: true,
        target: latest.target,
        sourceOwner: latest.sourceOwner,
        resourceIncarnation: latest.resourceIncarnation,
        ...(latest.context ? { context: latest.context } : {}),
        caller,
        accountEpoch,
      };
    } catch (error) {
      if (error instanceof AccountChangedDuringRead) continue;
      return { allowed: false, reason: failureReason(error) };
    }
  }
  return { allowed: false, reason: 'runtime_unavailable' };
}

/** Resolves main-owned project type and verifies the complete live parent chain. */
export async function resolveChatWatcherTarget(
  entry: CanonicalChatWatcherEntry,
): Promise<ResolvedChatWatcherTarget> {
  try {
    const epoch = await beginRead();
    let target: ResolvedChatWatcherTarget;
    const entryTarget = entry.target;
    if ('projectId' in entryTarget) {
      const project = await coherentRead(epoch, () =>
        requireAuthorizedProject(entryTarget.projectId, resourceCaller),
      );
      target = {
        kind: 'project',
        projectType: project.type,
        address: entryTarget,
      };
    } else target = { kind: 'bot', address: entryTarget };
    const first = await inspectResource(target, epoch);
    const latest = await inspectResource(target, epoch);
    if (
      first.binding !== latest.binding ||
      !sameOwner(first.sourceOwner, latest.sourceOwner)
    )
      throw new ChatWatcherAccessError('runtime_unavailable');
    return target;
  } catch (error) {
    throw new ChatWatcherAccessError(failureReason(error));
  }
}

/**
 * Historical rows remain untouched. Resolve live cowork metadata through the
 * dispatcher, never assume task=chat or accept an archive-only match. Multiple
 * live parents are corruption, not permission to pick the first one.
 */
export async function resolveLegacyChatWatcher(
  legacy: UnresolvedLegacyChatWatcher,
): Promise<LegacyChatWatcherAccessResolution> {
  try {
    const epoch = await beginRead();
    const project = await coherentRead(epoch, () =>
      requireAuthorizedProject(legacy.target.projectId, resourceCaller),
    );
    let address: ResolvedChatWatcherTarget & { kind: 'project' };
    if (legacy.trigger === 'standalone_chat_completion') {
      if (project.type !== 'cowork')
        return { ok: false, reason: 'migration_required' };
      const tasks = await coherentRead(epoch, () =>
        listDiscoverableTaskIds(project.projectId, 'cowork'),
      );
      const matches: string[] = [];
      for (const taskId of tasks) {
        assertLiveScope(project.projectId, taskId);
        const snapshot = await coherentRead(epoch, () =>
          readTaskRuntimeSnapshot(project.projectId, taskId),
        );
        if (
          snapshot.tabsFile.tabs.some(
            (tab) => tab.kind !== 'file' && tab.id === legacy.target.chatId,
          )
        )
          matches.push(taskId);
      }
      if (matches.length !== 1)
        return { ok: false, reason: 'migration_required' };
      address = {
        kind: 'project',
        projectType: project.type,
        address: {
          projectId: project.projectId,
          taskId: matches[0],
          chatId: legacy.target.chatId,
        },
      };
    } else if (legacy.trigger === 'standalone_new_chat_started') {
      address = {
        kind: 'project',
        projectType: project.type,
        address: { projectId: project.projectId },
      };
    } else {
      address = {
        kind: 'project',
        projectType: project.type,
        address: {
          projectId: project.projectId,
          taskId: legacy.target.worktreeId,
          ...('chatId' in legacy.target
            ? { chatId: legacy.target.chatId }
            : {}),
        },
      };
    }
    const canonical = legacyChatWatcherToCanonical(legacy, address);
    if (!canonical.ok) return canonical;
    const target = await coherentRead(epoch, () =>
      resolveChatWatcherTarget(canonical.entry),
    );
    return { ok: true, entry: canonical.entry, target };
  } catch {
    return { ok: false, reason: 'migration_required' };
  }
}
