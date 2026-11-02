/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(() => true),
}));

jest.mock('../lib/worktree-chat-turn', () => ({
  dispatchWorktreeChatTurn: jest.fn(),
}));

jest.mock('../lib/chat-tab-dispatch-utils', () => ({
  upsertPersistedChatTab: jest.fn(),
  removePersistedChatTab: jest.fn(),
  completePersistedChatTabTurn: jest.fn(),
  emitChatDispatchFailure: jest.fn(),
}));

const runWithScopeActivityMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: jest.fn(() => ({
    runWithScopeActivity: runWithScopeActivityMock,
  })),
}));

// The launcher resolves its model through the LANE resolver now, not the raw
// `resolveOverallDefault` preference — that bypass is the CAN-1929 defect this
// suite's fixtures were written before.
jest.mock('../lib/default-model-lane-resolver', () => ({
  requireLaneAwareDefaultSelection: jest.fn(),
}));

jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/types', () => {
  const actual = jest.requireActual('@canopy/desktop-shared/types');
  return {
    __esModule: true,
    ...actual,
    getExecutionHarnessForModel: jest.fn(),
    getProviderForModel: jest.fn(),
    requireProviderForModel: jest.fn(),
    resolveKnownModel: jest.fn(),
    normalizeThinkingForProvider: jest.fn(),
  };
});

import {
  getExecutionHarnessForModel,
  getProviderForModel,
  requireProviderForModel,
  resolveKnownModel,
  normalizeThinkingForProvider,
} from '@canopy/desktop-shared/types';
import { requireLaneAwareDefaultSelection } from '../lib/default-model-lane-resolver';
import { resolvePersistedApprovalMode } from '../lib/approval-mode-resolution';
import { BUILTIN_PLUGIN_MARKETPLACE_ID } from '@canopy/desktop-shared/types/plugins';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { sendToWindow } from '../lib/window-send';
import { dispatchWorktreeChatTurn } from '../lib/worktree-chat-turn';
import {
  removePersistedChatTab,
  upsertPersistedChatTab,
} from '../lib/chat-tab-dispatch-utils';
import {
  launchMergeConflictResolutionChat,
  launchPrCommentTriageChat,
  launchCiCheckFixChat,
  launchMergeQueueChat,
} from '../lib/builtin-gh-chat';

const mockedGetProviderForModel = jest.mocked(getProviderForModel);
const mockedRequireProviderForModel = jest.mocked(requireProviderForModel);
const mockedGetExecutionHarnessForModel = jest.mocked(
  getExecutionHarnessForModel,
);
const mockedRequireLaneDefault = jest.mocked(requireLaneAwareDefaultSelection);
const mockedResolveApprovalMode = jest.mocked(resolvePersistedApprovalMode);
const mockedResolveKnownModel = jest.mocked(resolveKnownModel);
const mockedNormalizeThinking = jest.mocked(normalizeThinkingForProvider);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedDispatchTurn = jest.mocked(dispatchWorktreeChatTurn);
const mockedUpsert = jest.mocked(upsertPersistedChatTab);
jest.mocked(sendToWindow);

const BUILTIN_GH_REF = {
  marketplaceId: BUILTIN_PLUGIN_MARKETPLACE_ID,
  pluginName: 'builtin-gh',
};

function setupDefaults(provider: 'codex' | 'claude' | 'ollama'): void {
  mockedRequireLaneDefault.mockResolvedValue({
    model: 'model-x',
    thinkingLevel: 'medium',
  } as any);
  mockedResolveKnownModel.mockReturnValue('model-x');
  mockedNormalizeThinking.mockReturnValue('medium');
  mockedGetProviderForModel.mockReturnValue(provider);
  mockedRequireProviderForModel.mockReturnValue(provider);
  mockedGetExecutionHarnessForModel.mockReturnValue(
    provider === 'codex' ? 'codex' : 'claude',
  );
}

const baseArgs = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  selectedRepoId: 'repo-a',
  prefs: {} as any,
  context: { repoName: 'repo-a', branchName: 'feature/x' },
  getWindow: (): any => ({}),
};

describe('launchMergeConflictResolutionChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadAllSidebarItems.mockResolvedValue({ items: [] } as any);
    mockedDispatchTurn.mockResolvedValue(undefined);
    mockedUpsert.mockResolvedValue(undefined);
    mockedResolveApprovalMode.mockResolvedValue('auto');
  });

  it('sends the Codex ($) prompt and force-enables builtin-gh', async () => {
    setupDefaults('codex');

    await launchMergeConflictResolutionChat(baseArgs);

    expect(runWithScopeActivityMock).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      expect.any(Function),
    );

    const dispatchArg = mockedDispatchTurn.mock.calls[0][0];
    expect(dispatchArg.text).toBe('$builtin-gh:handle-merge-conflicts --push');
    expect(dispatchArg.pluginSelections?.pluginRefs).toContainEqual(
      BUILTIN_GH_REF,
    );
    expect(dispatchArg.initiationSource).toBe('hook');
    expect(dispatchArg.selectedRepoId).toBe('repo-a');
  });

  it('sends the Claude (/) prompt', async () => {
    setupDefaults('claude');

    await launchMergeConflictResolutionChat(baseArgs);

    expect(mockedDispatchTurn.mock.calls[0][0].text).toBe(
      '/builtin-gh:handle-merge-conflicts --push',
    );
  });

  it('resolves its model through the LANE resolver, scoped to the dispatch project (CAN-1929)', async () => {
    // This launcher passes its model to `dispatchWorktreeChatTurn` EXPLICITLY,
    // and central lane resolution there only runs when `options.model` is
    // undefined. Reading the raw `resolveOverallDefault` preference therefore
    // bypassed CAN-1929 entirely: a credits-only user kept creating GitHub
    // chats on the billing-unaware native default.
    setupDefaults('claude');

    await launchMergeConflictResolutionChat(baseArgs);

    expect(mockedRequireLaneDefault).toHaveBeenCalledTimes(1);
    const [, scope, credentialScope] = mockedRequireLaneDefault.mock.calls[0];
    expect(scope).toBe('worktree');
    // Parity with the spawn, which resolves its Environments credentials for
    // this same workspace — otherwise a workspace-only provider credential is
    // invisible here and selection disagrees with what the turn actually runs.
    expect(credentialScope).toEqual({ workspaceId: 'project-1' });
    expect(mockedDispatchTurn.mock.calls[0][0].model).toBe('model-x');
  });

  it('sends the Ollama (/) prompt', async () => {
    setupDefaults('ollama');

    await launchMergeConflictResolutionChat(baseArgs);

    expect(mockedDispatchTurn.mock.calls[0][0].text).toBe(
      '/builtin-gh:handle-merge-conflicts --push',
    );
  });

  it('starts a chat without a launcher turn timer row', async () => {
    setupDefaults('claude');
    await launchMergeConflictResolutionChat(baseArgs);
    const tab = mockedUpsert.mock.calls[0][0].tab;
    expect(
      tab.messages.some((message: any) =>
        message.blocks.some((block: any) => block.type === 'turn_timer'),
      ),
    ).toBe(false);
  });

  it('persists a tab with the merge-conflict marker block', async () => {
    setupDefaults('claude');

    await launchMergeConflictResolutionChat(baseArgs);

    const tab = mockedUpsert.mock.calls[0][0].tab;
    const markerMessage = tab.messages.find((message: any) =>
      message.blocks.some(
        (block: any) => block.type === 'builtin_gh_chat_info',
      ),
    );
    expect(markerMessage).toBeDefined();
    if (!markerMessage)
      throw new Error('Expected a merge-conflict marker message');
    const marker = markerMessage.blocks.find(
      (block: any) => block.type === 'builtin_gh_chat_info',
    );
    expect(marker).toMatchObject({
      type: 'builtin_gh_chat_info',
      kind: 'merge_conflict',
      repoName: 'repo-a',
      branchName: 'feature/x',
    });
    expect(tab.pluginSelections?.pluginRefs).toContainEqual(BUILTIN_GH_REF);
    expect(tab.selectedRepoId).toBe('repo-a');
  });

  it('uses the resolved worktree approval default for the persisted tab and dispatched turn', async () => {
    setupDefaults('claude');

    await launchMergeConflictResolutionChat(baseArgs);

    expect(mockedResolveApprovalMode).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(mockedUpsert.mock.calls[0][0].tab.approvalMode).toBe('auto');
    expect(mockedDispatchTurn.mock.calls[0][0].approvalMode).toBe('auto');
  });

  it('triage: sends the Codex ($) handle-pr-comments prompt', async () => {
    setupDefaults('codex');

    await launchPrCommentTriageChat(baseArgs);

    expect(mockedDispatchTurn.mock.calls[0][0].text).toBe(
      '$builtin-gh:handle-pr-comments',
    );
  });

  it('triage: sends the Claude (/) handle-pr-comments prompt and marks the source', async () => {
    setupDefaults('claude');

    await launchPrCommentTriageChat(baseArgs);

    const dispatchArg = mockedDispatchTurn.mock.calls[0][0];
    expect(dispatchArg.text).toBe('/builtin-gh:handle-pr-comments');
    expect(dispatchArg.pluginSelections?.pluginRefs).toContainEqual(
      BUILTIN_GH_REF,
    );
    expect(dispatchArg.approvalMode).toBe('auto');

    const tab = mockedUpsert.mock.calls[0][0].tab;
    expect(tab.approvalMode).toBe('auto');
    const marker = tab.messages
      .flatMap((message: any) => message.blocks)
      .find((block: any) => block.type === 'builtin_gh_chat_info');
    expect(marker).toMatchObject({
      type: 'builtin_gh_chat_info',
      kind: 'review_comment_triage',
    });
  });

  it('ci fix: sends the Codex ($) handle-pr-checks --auto prompt', async () => {
    setupDefaults('codex');

    await launchCiCheckFixChat(baseArgs);

    expect(mockedDispatchTurn.mock.calls[0][0].text).toBe(
      '$builtin-gh:handle-pr-checks --auto',
    );
  });

  it('ci fix: sends the Claude (/) prompt and marks the source', async () => {
    setupDefaults('claude');

    await launchCiCheckFixChat(baseArgs);

    const dispatchArg = mockedDispatchTurn.mock.calls[0][0];
    expect(dispatchArg.text).toBe('/builtin-gh:handle-pr-checks --auto');
    expect(dispatchArg.pluginSelections?.pluginRefs).toContainEqual(
      BUILTIN_GH_REF,
    );
    expect(dispatchArg.approvalMode).toBe('auto');

    const tab = mockedUpsert.mock.calls[0][0].tab;
    expect(tab.approvalMode).toBe('auto');
    const marker = tab.messages
      .flatMap((message: any) => message.blocks)
      .find((block: any) => block.type === 'builtin_gh_chat_info');
    expect(marker).toMatchObject({
      type: 'builtin_gh_chat_info',
      kind: 'ci_check_fix',
    });
  });

  it('enables only builtin-gh locally and leaves project defaults inherited', async () => {
    setupDefaults('claude');
    mockedReadAllSidebarItems.mockResolvedValue({
      items: [
        {
          id: 'project-1',
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [
              BUILTIN_GH_REF,
              { marketplaceId: 'mkt', pluginName: 'project-default' },
            ],
          },
        },
      ],
    } as any);

    await launchMergeConflictResolutionChat(baseArgs);

    expect(
      mockedDispatchTurn.mock.calls[0][0].pluginSelections?.pluginRefs,
    ).toEqual([BUILTIN_GH_REF]);
    expect(
      mockedUpsert.mock.calls[0]?.[0].tab.inheritedPluginDefaultsVersion,
    ).toBe(1);
  });
});

describe('launchMergeQueueChat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadAllSidebarItems.mockResolvedValue({ items: [] } as any);
    mockedDispatchTurn.mockResolvedValue(undefined);
    mockedResolveApprovalMode.mockResolvedValue('auto');
    jest.mocked(sendToWindow).mockReturnValue(true);
  });
  it.each(['claude', 'codex'] as const)(
    'launches an explicit PR command with %s defaults and marker',
    async (provider) => {
      setupDefaults(provider);
      const args = {
        ...baseArgs,
        context: {
          ...baseArgs.context,
          prUrl: 'https://github.com/org/repo/pull/7',
          prNumber: 7,
        },
      };
      const result = await launchMergeQueueChat(args);
      expect(mockedDispatchTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: `${provider === 'codex' ? '$' : '/'}builtin-gh:merge-pr ${args.context.prUrl}`,
          selectedRepoId: 'repo-a',
          approvalMode: 'auto',
          model: 'model-x',
        }),
      );
      const tab = mockedUpsert.mock.calls[0][0].tab;
      expect(tab.id).toBe(result.chatId);
      expect(tab.title).toBe('Merge repo-a through the merge queue');
      expect(tab.pluginSelections?.pluginRefs).toContainEqual(BUILTIN_GH_REF);
      expect(tab.messages[0].blocks).toEqual([
        {
          type: 'builtin_gh_chat_info',
          kind: 'merge_queue',
          repoName: 'repo-a',
          branchName: 'feature/x',
          timestamp: expect.any(Number),
        },
      ]);
    },
  );
  it.each([
    undefined,
    '',
    'bad',
    'https://github.com/org/repo/pull/7 --admin',
    'https://github.com/org/repo/issues/7',
  ])('validates URL before persistence and dispatch: %s', async (prUrl) => {
    setupDefaults('claude');
    await expect(
      launchMergeQueueChat({ ...baseArgs, context: { prUrl } }),
    ).rejects.toThrow('pull request URL');
    expect(mockedUpsert).not.toHaveBeenCalled();
    expect(mockedDispatchTurn).not.toHaveBeenCalled();
  });
  it('cleans up the tab and reports failure when no window accepts the start', async () => {
    setupDefaults('claude');
    jest.mocked(sendToWindow).mockReturnValueOnce(false);
    await expect(
      launchMergeQueueChat({
        ...baseArgs,
        context: { prUrl: 'https://github.com/org/repo/pull/7' },
        getWindow: () => null,
      }),
    ).rejects.toThrow('active renderer window');
    expect(removePersistedChatTab).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: expect.stringContaining('merge-queue'),
      }),
    );
    expect(mockedDispatchTurn).not.toHaveBeenCalled();
  });
});
