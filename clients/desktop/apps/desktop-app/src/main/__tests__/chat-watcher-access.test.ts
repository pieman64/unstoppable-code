import type {
  CanonicalChatWatcherEntry,
  ResolvedChatWatcherTarget,
  TrustedChatWatcherRecipient,
  UnresolvedLegacyChatWatcher,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  type ProjectOwnerContext,
  type ChatStateSnapshot,
} from '@canopy/desktop-shared/types';
import {
  decideChatWatcherAccess,
  resolveChatWatcherTarget,
  resolveLegacyChatWatcher,
} from '../app-advisor/chat-watcher-access';
import {
  getCallerOwner,
  requireAuthorizedProject,
  type AuthorizedProject,
} from '../project-discovery/owner-policy';
import { listDiscoverableTaskIds } from '../project-discovery/chats-list';
import { readTaskRuntimeSnapshot } from '../project-discovery/runtime-state';
import {
  requireBotAccess,
  readBotEntries,
  isBotTaskEligible,
} from '../project-discovery/bots/target';
import { readProjectEntries } from '../project-discovery/sources';
import { isWorkspaceTargetRemovalPending } from '../lib/workspace-target-exclusion';

jest.mock('../project-discovery/owner-policy');
jest.mock('../project-discovery/sources');
jest.mock('../project-discovery/chats-list');
jest.mock('../project-discovery/runtime-state');
jest.mock('../project-discovery/bots/target');
jest.mock('../lib/workspace-target-exclusion');
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): typeof mockAccount => mockAccount,
}));
const mockAccount = {
  initialize: jest.fn((): Promise<void> => Promise.resolve()),
  whenIdle: jest.fn((): Promise<void> => Promise.resolve()),
  accountEpoch: (): number => epoch,
};
let epoch = 1;
const personal: ProjectOwnerContext = { kind: 'personal' };
const org: ProjectOwnerContext = {
  kind: 'organization',
  organizationId: 'org',
};
const recipient: TrustedChatWatcherRecipient = {
  destination: {
    projectId: 'origin',
    worktreeId: 'origin-task',
    chatId: 'origin-chat',
  },
  recipient: { kind: 'root' },
};
const advisor: TrustedChatWatcherRecipient = {
  destination: {
    projectId: APP_ADVISOR_PROJECT_ID,
    worktreeId: 'advisor-task',
    chatId: 'advisor-chat',
  },
  recipient: { kind: 'root' },
};
const target: ResolvedChatWatcherTarget = {
  kind: 'project',
  projectType: 'cowork',
  address: { projectId: 'project', taskId: 'task' },
};
const bot: ResolvedChatWatcherTarget = {
  kind: 'bot',
  address: { botId: 'app_advisor', taskId: 'task' },
};
function project(owner: ProjectOwnerContext = personal): AuthorizedProject {
  return {
    projectId: 'project',
    type: 'cowork',
    purpose: 'project',
    name: 'Project',
    displayName: 'Project',
    incarnation: 'project-generation',
    isDefault: false,
    owner,
    readiness: 'ready',
    synthetic: false,
    inventoryAuthority: 'ok',
    inventoryOwnerMalformed: false,
    item: {
      id: 'project',
      type: 'cowork',
      name: 'Project',
      color: '#000000',
      collapsed: false,
      order: 0,
    },
  };
}
function snapshot(taskId = 'task', chatId = 'chat'): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    projectId: 'project',
    worktreeId: taskId,
    revision: 1,
    tabsFile: {
      version: 1,
      tabs: [
        {
          id: chatId,
          title: 'Chat',
          createdAt: '2026-10-16T00:00:00Z',
          messages: [],
        },
      ],
    },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  epoch = 1;
  mockAccount.initialize.mockResolvedValue(undefined);
  mockAccount.whenIdle.mockResolvedValue(undefined);
  jest.mocked(getCallerOwner).mockResolvedValue(personal);
  jest.mocked(requireAuthorizedProject).mockResolvedValue(project());
  jest.mocked(listDiscoverableTaskIds).mockResolvedValue(['task']);
  jest
    .mocked(readTaskRuntimeSnapshot)
    .mockImplementation((_p, t) => Promise.resolve(snapshot(t)));
  jest.mocked(readProjectEntries).mockResolvedValue({
    version: 1,
    entries: [{ id: 'task', createdAt: '2026-10-16T00:00:00Z' }],
  });
  jest
    .mocked(isBotTaskEligible)
    .mockImplementation((entry) => entry.id !== COWORK_HOME_WORKTREE_ID);
  jest
    .mocked(readBotEntries)
    .mockResolvedValue([{ id: 'task', createdAt: '2026-10-16T00:00:00Z' }]);
  jest.mocked(requireBotAccess).mockImplementation((caller) =>
    Promise.resolve({
      caller,
      accountEpoch: epoch,
      owner: caller.kind === 'app_advisor' ? null : personal,
      gate: { allowed: true as const },
    }),
  );
});
it('applies same-owner to roots and delegates using the root origin', async () => {
  jest.mocked(requireAuthorizedProject).mockResolvedValue(project(org));
  for (const trusted of [
    recipient,
    {
      ...recipient,
      recipient: { kind: 'delegate' as const, delegationId: 'delegate' },
    },
  ]) {
    expect(await decideChatWatcherAccess(trusted, target)).toEqual({
      allowed: false,
      reason: 'owner_boundary',
    });
  }
  expect(jest.mocked(getCallerOwner)).toHaveBeenCalledWith({
    kind: 'project_agent',
    projectId: 'origin',
    worktreeId: 'origin-task',
    chatId: 'origin-chat',
  });
});
it('Advisor is owner-exempt but not resource-eligibility exempt', async () => {
  jest.mocked(requireAuthorizedProject).mockResolvedValue(project(org));
  expect(await decideChatWatcherAccess(advisor, target)).toMatchObject({
    allowed: true,
    sourceOwner: org,
  });
  jest
    .mocked(requireAuthorizedProject)
    .mockResolvedValue({ ...project(org), readiness: 'unavailable' });
  expect(await decideChatWatcherAccess(advisor, target)).toEqual({
    allowed: false,
    reason: 'runtime_unavailable',
  });
});
it('fails closed when project inventory membership is revoked', async () => {
  jest
    .mocked(requireAuthorizedProject)
    .mockRejectedValue(new Error('unavailable'));
  expect(await decideChatWatcherAccess(advisor, target)).toEqual({
    allowed: false,
    reason: 'runtime_unavailable',
  });
});
it('uses the phase05 gate for each recipient, including delegates', async () => {
  jest.mocked(requireBotAccess).mockImplementation((caller) => {
    if (caller.kind !== 'app_advisor')
      throw Object.assign(new Error('disabled'), {
        code: 'advisor_access_disabled',
      });
    return Promise.resolve({
      caller,
      accountEpoch: epoch,
      owner: null,
      gate: { allowed: true as const },
    });
  });
  expect(await decideChatWatcherAccess(recipient, bot)).toEqual({
    allowed: false,
    reason: 'advisor_access_disabled',
  });
  expect(await decideChatWatcherAccess(advisor, bot)).toMatchObject({
    allowed: true,
    sourceOwner: null,
  });
});
it('drains queued account changes and rejects changes during an awaited lookup', async () => {
  jest.mocked(requireAuthorizedProject).mockImplementation(() => {
    epoch += 1;
    return Promise.resolve(project());
  });
  expect(await decideChatWatcherAccess(recipient, target)).toEqual({
    allowed: false,
    reason: 'runtime_unavailable',
  });
  expect(mockAccount.whenIdle).toHaveBeenCalled();
});
it('rejects a saved-owner or resource binding change without an account change', async () => {
  jest
    .mocked(requireAuthorizedProject)
    .mockResolvedValueOnce(project())
    .mockResolvedValue({ ...project(), incarnation: 'replacement' });
  expect(await decideChatWatcherAccess(recipient, target)).toEqual({
    allowed: false,
    reason: 'runtime_unavailable',
  });
});
it('checks stable event owner and resource incarnation, ignoring legacy epochs', async () => {
  expect(
    await decideChatWatcherAccess(recipient, target, { sourceOwner: org }),
  ).toEqual({ allowed: false, reason: 'owner_boundary' });
  expect(
    await decideChatWatcherAccess(recipient, target, {
      sourceOwner: personal,
      accountEpoch: 0,
    }),
  ).toMatchObject({ allowed: true });
  expect(
    await decideChatWatcherAccess(recipient, target, {
      sourceOwner: personal,
      resourceIncarnation: 'old',
    }),
  ).toEqual({ allowed: false, reason: 'migration_required' });
});
it('allows completion evidence across a project rename, including pre-change incarnations', async () => {
  const incarnation = (
    name: string,
    createdAt = 'created',
    generation = 1,
  ): string =>
    JSON.stringify({
      projectId: 'project',
      owner: personal,
      readiness: 'ready',
      name,
      type: 'cowork',
      binding: {
        organizationId: 'org',
        projectId: 'shared',
        instanceId: 'instance',
        bindingGeneration: generation,
      },
      createdAt,
    });
  jest
    .mocked(requireAuthorizedProject)
    .mockResolvedValue({ ...project(), incarnation: incarnation('Before') });
  const captured = await decideChatWatcherAccess(recipient, target);
  if (!captured.allowed) throw new Error('Capture denied');
  const renamed = {
    ...project(),
    name: 'After',
    incarnation: incarnation('After'),
  };
  jest.mocked(requireAuthorizedProject).mockResolvedValue(renamed);
  for (const resourceIncarnation of [
    captured.resourceIncarnation,
    incarnation('Before'),
  ]) {
    expect(
      await decideChatWatcherAccess(recipient, target, {
        sourceOwner: personal,
        resourceIncarnation,
      }),
    ).toMatchObject({ allowed: true });
  }
  expect(captured.resourceIncarnation).not.toContain('Before');
  for (const replacement of [
    incarnation('After', 'recreated'),
    incarnation('After', 'created', 2),
  ]) {
    jest
      .mocked(requireAuthorizedProject)
      .mockResolvedValue({ ...project(), incarnation: replacement });
    expect(await decideChatWatcherAccess(recipient, target, captured)).toEqual({
      allowed: false,
      reason: 'migration_required',
    });
  }
  jest
    .mocked(requireAuthorizedProject)
    .mockResolvedValue({ ...project(org), incarnation: incarnation('After') });
  expect(await decideChatWatcherAccess(advisor, target, captured)).toEqual({
    allowed: false,
    reason: 'owner_boundary',
  });
});
it('rejects unknown bot IDs, special bot tasks and retired/removing targets', async () => {
  expect(
    await decideChatWatcherAccess(advisor, {
      kind: 'bot',
      address: { botId: 'app-advisor' },
    }),
  ).toEqual({ allowed: false, reason: 'runtime_unavailable' });
  jest
    .mocked(readBotEntries)
    .mockResolvedValue([{ id: COWORK_HOME_WORKTREE_ID, createdAt: 'date' }]);
  expect(
    await decideChatWatcherAccess(advisor, {
      kind: 'bot',
      address: { botId: 'app_advisor', taskId: COWORK_HOME_WORKTREE_ID },
    }),
  ).toEqual({ allowed: false, reason: 'runtime_unavailable' });
  jest.mocked(isWorkspaceTargetRemovalPending).mockReturnValue(true);
  expect(await decideChatWatcherAccess(recipient, target)).toEqual({
    allowed: false,
    reason: 'runtime_unavailable',
  });
});
it('resolves project type from policy, never from a caller hint', async () => {
  const entry: CanonicalChatWatcherEntry = {
    trigger: 'project_new_chat_started',
    target: { projectId: 'project', taskId: 'task' },
  };
  expect(await resolveChatWatcherTarget(entry)).toEqual(target);
  expect(
    await decideChatWatcherAccess(recipient, {
      ...target,
      projectType: 'code',
    }),
  ).toEqual({ allowed: false, reason: 'migration_required' });
});
it('resolves a legacy cowork chat to its real Work Entry, preserving metadata', async () => {
  const result = await resolveLegacyChatWatcher({
    trigger: 'standalone_chat_completion',
    target: { kind: 'standalone_chat', projectId: 'project', chatId: 'chat' },
    label: 'label',
    armForNextCompletion: true,
  });
  expect(result).toMatchObject({
    ok: true,
    entry: {
      trigger: 'project_task_chat_completion',
      target: { projectId: 'project', taskId: 'task', chatId: 'chat' },
      label: 'label',
      armForNextCompletion: true,
    },
    target: {
      ...target,
      address: { projectId: 'project', taskId: 'task', chatId: 'chat' },
    },
  });
});
it('preserves unresolved, archived, ambiguous and conflicting legacy identities', async () => {
  const legacy = {
    trigger: 'standalone_chat_completion' as const,
    target: {
      kind: 'standalone_chat' as const,
      projectId: 'project',
      chatId: 'missing',
    },
  };
  expect(await resolveLegacyChatWatcher(legacy)).toEqual({
    ok: false,
    reason: 'migration_required',
  });
  jest
    .mocked(listDiscoverableTaskIds)
    .mockResolvedValue(['task', 'other-task']);
  expect(
    await resolveLegacyChatWatcher({
      ...legacy,
      target: { ...legacy.target, chatId: 'chat' },
    }),
  ).toEqual({ ok: false, reason: 'migration_required' });
  jest
    .mocked(requireAuthorizedProject)
    .mockResolvedValue({ ...project(), type: 'code' });
  expect(await resolveLegacyChatWatcher(legacy)).toEqual({
    ok: false,
    reason: 'migration_required',
  });
});

it('returns a main-only authorized transcript context for the exact parent chat', async () => {
  const completion: ResolvedChatWatcherTarget = {
    ...target,
    address: { projectId: 'project', taskId: 'task', chatId: 'chat' },
  };
  expect(
    await decideChatWatcherAccess(recipient, completion, {
      sourceOwner: personal,
      resourceIncarnation: 'project-generation',
    }),
  ).toMatchObject({
    allowed: true,
    resourceIncarnation: 'project-generation',
    context: {
      scope: { workspaceId: 'project', worktreeId: 'task', chatId: 'chat' },
    },
  });
  expect(
    await decideChatWatcherAccess(recipient, {
      ...completion,
      address: { projectId: 'project', taskId: 'wrong', chatId: 'chat' },
    }),
  ).toEqual({ allowed: false, reason: 'runtime_unavailable' });
});
it('accepts eligible code project scopes but not unknown caller owners', async () => {
  jest
    .mocked(requireAuthorizedProject)
    .mockResolvedValue({ ...project(), type: 'code' });
  const code: ResolvedChatWatcherTarget = {
    kind: 'project',
    projectType: 'code',
    address: { projectId: 'project' },
  };
  expect(await decideChatWatcherAccess(recipient, code)).toMatchObject({
    allowed: true,
  });
  jest.mocked(getCallerOwner).mockRejectedValue(new Error('unknown'));
  expect(await decideChatWatcherAccess(recipient, code)).toEqual({
    allowed: false,
    reason: 'runtime_unavailable',
  });
});
it('does not use archive-only chats as live legacy parents', async () => {
  jest.mocked(readTaskRuntimeSnapshot).mockImplementation((_p, t) => {
    const state = snapshot(t);
    state.tabsFile.tabs = [];
    state.archives = [
      {
        chatId: 'chat',
        title: 'Archived',
        turnCount: 1,
        archivedAt: '2026-10-16T00:00:00Z',
        createdAt: '2026-10-16T00:00:00Z',
        restorable: true,
        unread: false,
      },
    ];
    return Promise.resolve(state);
  });
  expect(
    await resolveLegacyChatWatcher({
      trigger: 'standalone_chat_completion',
      target: { kind: 'standalone_chat', projectId: 'project', chatId: 'chat' },
    }),
  ).toEqual({ ok: false, reason: 'migration_required' });
});
it('rechecks the bot setting after awaited resource reads', async () => {
  let projectGateCalls = 0;
  jest.mocked(requireBotAccess).mockImplementation((caller) => {
    if (caller.kind !== 'app_advisor' && ++projectGateCalls > 1)
      return Promise.reject(
        Object.assign(new Error('disabled'), {
          code: 'advisor_access_disabled',
        }),
      );
    return Promise.resolve({
      caller,
      accountEpoch: epoch,
      owner: caller.kind === 'app_advisor' ? null : personal,
      gate: { allowed: true },
    });
  });
  expect(await decideChatWatcherAccess(recipient, bot)).toEqual({
    allowed: false,
    reason: 'advisor_access_disabled',
  });
});
it('rejects mismatched delegate identities', async () => {
  expect(
    await decideChatWatcherAccess(
      {
        ...recipient,
        destination: { ...recipient.destination, delegationId: 'different' },
        recipient: { kind: 'delegate', delegationId: 'delegate' },
      },
      target,
    ),
  ).toEqual({ allowed: false, reason: 'runtime_unavailable' });
});

it('rejects retired plan project scopes before resource reads', async () => {
  expect(
    await decideChatWatcherAccess(advisor, {
      kind: 'project',
      projectType: 'cowork',
      address: { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID },
    }),
  ).toEqual({ allowed: false, reason: 'runtime_unavailable' });
  expect(jest.mocked(requireAuthorizedProject)).not.toHaveBeenCalled();
});

describe('legacy spelling follows authoritative phase03 inventory type', () => {
  const mismatches: Array<{
    type: 'code' | 'cowork';
    legacy: UnresolvedLegacyChatWatcher;
  }> = [
    {
      type: 'code',
      legacy: {
        trigger: 'standalone_chat_completion',
        target: {
          kind: 'standalone_chat',
          projectId: 'project',
          chatId: 'chat',
        },
      },
    },
    {
      type: 'code',
      legacy: {
        trigger: 'standalone_new_chat_started',
        target: { kind: 'standalone_chat_project', projectId: 'project' },
      },
    },
    {
      type: 'cowork',
      legacy: {
        trigger: 'worktree_chat_completion',
        target: {
          kind: 'worktree_chat',
          projectId: 'project',
          worktreeId: 'task',
          chatId: 'chat',
        },
      },
    },
    {
      type: 'cowork',
      legacy: {
        trigger: 'worktree_new_chat_started',
        target: {
          kind: 'worktree_chat_scope',
          projectId: 'project',
          worktreeId: 'task',
        },
      },
    },
  ];
  it.each(mismatches)(
    'rejects $legacy.trigger on inventory $type without rewriting input',
    async ({ type, legacy }) => {
      jest
        .mocked(requireAuthorizedProject)
        .mockResolvedValue({ ...project(), type });
      const original = structuredClone(legacy);
      expect(await resolveLegacyChatWatcher(legacy)).toEqual({
        ok: false,
        reason: 'migration_required',
      });
      expect(legacy).toEqual(original);
      expect(jest.mocked(requireAuthorizedProject)).toHaveBeenCalledWith(
        'project',
        expect.objectContaining({ kind: 'app_advisor' }),
      );
    },
  );
  it('accepts a real cowork task scope only through its canonical spelling', async () => {
    const entry: CanonicalChatWatcherEntry = {
      trigger: 'project_new_chat_started',
      target: { projectId: 'project', taskId: 'task' },
    };
    expect(await resolveChatWatcherTarget(entry)).toEqual({
      kind: 'project',
      projectType: 'cowork',
      address: entry.target,
    });
    expect(
      await resolveLegacyChatWatcher({
        trigger: 'standalone_new_chat_started',
        target: { kind: 'standalone_chat_project', projectId: 'project' },
      }),
    ).toMatchObject({
      ok: true,
      entry: {
        trigger: 'project_new_chat_started',
        target: { projectId: 'project' },
      },
    });
  });
});

it.each([2, 0])(
  'reuses persisted bot evidence at epoch %s after refresh or restart',
  async (currentEpoch) => {
    epoch = currentEpoch;
    expect(
      await decideChatWatcherAccess(advisor, bot, {
        sourceOwner: null,
        resourceIncarnation: 'app_advisor',
        accountEpoch: 1,
      }),
    ).toMatchObject({ allowed: true });
  },
);
it('re-evaluates a transient account write during one access decision', async () => {
  jest.mocked(requireAuthorizedProject).mockImplementationOnce(() => {
    epoch += 1;
    return Promise.resolve(project());
  });
  expect(await decideChatWatcherAccess(recipient, target)).toMatchObject({
    allowed: true,
  });
});

it('re-evaluates an account change even when the raced lookup rejects', async () => {
  jest.mocked(requireAuthorizedProject).mockImplementationOnce(() => {
    epoch += 1;
    return Promise.reject(new Error('stale account lookup'));
  });
  expect(await decideChatWatcherAccess(recipient, target)).toMatchObject({
    allowed: true,
  });
});
