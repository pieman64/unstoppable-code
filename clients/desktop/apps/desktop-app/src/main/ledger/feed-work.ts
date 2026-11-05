import {
  readLedgerContainerLiveChats,
  type LedgerActorDirectory,
} from './actor-directory';
import type {
  LedgerFeedLocalScope,
  LedgerFeedWorkContext,
  LedgerFeedWorkContextReader,
} from './feed-service';

const SAFE_REGISTRY_ID = /^[a-z0-9][a-z0-9-]*$/;

interface LedgerFeedScopeNames {
  readonly projectName: string | null;
  readonly taskName: string | null;
}

function nonemptyName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}

async function scopeNames(
  scope: LedgerFeedLocalScope,
): Promise<LedgerFeedScopeNames> {
  const { container } = scope;
  // A global (workflow) Ledger has no project or task.
  if (container.kind === 'global') return { projectName: null, taskName: null };
  const projectId =
    container.kind === 'advisor_entry'
      ? container.appWorkspaceId
      : container.workspaceId;
  if (!SAFE_REGISTRY_ID.test(projectId)) {
    return { projectName: null, taskName: null };
  }

  const [workspace, taskName] = await Promise.all([
    import('../lib/sidebar-items')
      .then(({ readWorkspaceIndexEntry }) => readWorkspaceIndexEntry(projectId))
      .catch(() => null),
    (async (): Promise<string | null> => {
      if (container.kind === 'code_worktree') {
        if (!SAFE_REGISTRY_ID.test(container.worktreeId)) return null;
        const worktrees = await import('../lib/workspace-persistence')
          .then(({ readWorkspaceWorktrees }) =>
            readWorkspaceWorktrees(projectId, {
              persistRemovalCleanup: false,
            }),
          )
          .catch(() => []);
        const worktree = worktrees.find(
          (candidate) => candidate.id === container.worktreeId,
        );
        return (
          nonemptyName(worktree?.label) ?? nonemptyName(worktree?.branchName)
        );
      }

      if (!SAFE_REGISTRY_ID.test(container.entryId)) return null;
      const registry = await import('../lib/cowork-work-entries-file')
        .then(({ readWorkEntriesFile }) => readWorkEntriesFile(projectId))
        .catch(() => null);
      const entry = registry?.entries.find(
        (candidate) => candidate.id === container.entryId,
      );
      return nonemptyName(entry?.title) ?? nonemptyName(entry?.summary?.title);
    })(),
  ]);

  return {
    projectName: nonemptyName(workspace?.name),
    taskName,
  };
}

function activityTime(chat: {
  readonly lastActivityAt?: string;
  readonly createdAt: string | null;
}): number | null {
  const value = chat.lastActivityAt ?? chat.createdAt;
  if (value === null) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

async function mostRecentTaskChatId(
  scope: LedgerFeedLocalScope,
): Promise<string | null> {
  const chats = await readLedgerContainerLiveChats(scope.container).catch(
    (): [] => [],
  );
  let mostRecent: {
    readonly chatId: string;
    readonly activity: number;
  } | null = null;
  for (const chat of chats) {
    const activity = activityTime(chat);
    if (
      activity !== null &&
      (mostRecent === null || activity > mostRecent.activity)
    ) {
      mostRecent = { chatId: chat.chatId, activity };
    }
  }
  return mostRecent?.chatId ?? null;
}

/**
 * Resolves the main-process registry names and this-device actor metadata for
 * Feed work rows. Names use the workspace index, worktree registry or
 * Work Entry registry; chat recency uses the persisted tab's last message
 * time, falling back to creation time for an empty chat. A chat owner gets its
 * own live chat as the Message target; non-chat owners use the most recently
 * active live chat in the task scope, or null when there is no such chat.
 */
export function createLedgerFeedWorkContextReader(
  actors: Pick<LedgerActorDirectory, 'workViewFor'>,
): LedgerFeedWorkContextReader {
  return async (
    scope: LedgerFeedLocalScope,
    actorIds: readonly string[],
  ): Promise<LedgerFeedWorkContext> => {
    const [names, mostRecentChatId, actorView] = await Promise.all([
      scopeNames(scope),
      mostRecentTaskChatId(scope),
      actors.workViewFor(scope, actorIds),
    ]);
    return {
      ...names,
      mostRecentChatId,
      actors: actorView.actors,
      actorHosts: actorView.actorHosts,
    };
  };
}
