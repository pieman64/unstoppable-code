/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return */
//
// Direct coverage for the rebase-resolution launcher. Before CAN-1929 round-6
// this file had NONE — it is mocked away in both `github-pull.test.ts` and
// `github-commit-and-push.test.ts` — so the lane-aware conversion landed with
// its explicit-model branch, its refusal path, and its thinking-level fallback
// all unexercised.
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

jest.mock('../lib/default-model-lane-resolver', () => ({
  resolveOptionalLaneAwareDefaultSelection: jest.fn(),
  NoDispatchableModelError: class NoDispatchableModelError extends Error {
    readonly missing: string;
    constructor(missing: string) {
      super(`No dispatchable model is available (${missing}).`);
      this.name = 'NoDispatchableModelError';
      this.missing = missing;
    }
  },
}));

jest.mock('../lib/approval-mode-resolution', () => ({
  resolvePersistedApprovalMode: jest.fn(),
}));

import {
  initClaudeModels,
  initCodexModels,
  type PreferencesData,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { readAllSidebarItems } from '../lib/sidebar-items';
import { sendToWindow } from '../lib/window-send';
import { dispatchWorktreeChatTurn } from '../lib/worktree-chat-turn';
import { upsertPersistedChatTab } from '../lib/chat-tab-dispatch-utils';
import { resolveOptionalLaneAwareDefaultSelection } from '../lib/default-model-lane-resolver';
import { resolvePersistedApprovalMode } from '../lib/approval-mode-resolution';
import { launchRebaseResolutionChat } from '../lib/rebase-resolution-chat';

const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedDispatchTurn = jest.mocked(dispatchWorktreeChatTurn);
const mockedUpsert = jest.mocked(upsertPersistedChatTab);
const mockedResolveOptional = jest.mocked(
  resolveOptionalLaneAwareDefaultSelection,
);
const mockedResolveApprovalMode = jest.mocked(resolvePersistedApprovalMode);

function prefs(overrides?: Partial<PreferencesData>): PreferencesData {
  return {
    agentRebaseResolutionEnabled: true,
    defaultWorktreeProvider: 'claude',
    defaultWorktreeModelByProvider: {
      claude: { model: 'claude-model', thinkingLevel: 'high' },
      codex: { model: 'codex-model', thinkingLevel: 'low' },
      ollama: null,
      aiCredits: null,
    },
    ...overrides,
  } as any;
}

const baseArgs = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  context: {
    kind: 'rebase_conflict' as const,
    repoName: 'repo-a',
    branchName: 'feature/x',
    repoPath: '/tmp/repo-a',
    errorMessage: 'CONFLICT (content)',
  },
  getWindow: (): any => ({}),
};

describe('launchRebaseResolutionChat', () => {
  beforeAll(() => {
    initClaudeModels([{ id: 'claude-model', label: 'Claude' }]);
    initCodexModels([{ id: 'codex-model', label: 'Codex' }]);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadAllSidebarItems.mockResolvedValue({ items: [] } as any);
    mockedDispatchTurn.mockResolvedValue(undefined as any);
    mockedUpsert.mockResolvedValue(undefined as any);
    mockedResolveOptional.mockResolvedValue({
      selection: { model: 'claude-model', thinkingLevel: 'high' },
      requireModel: () => ({ model: 'claude-model', thinkingLevel: 'high' }),
    } as any);
    mockedResolveApprovalMode.mockResolvedValue('auto');
  });

  it('resolves its model through the LANE resolver, scoped to the dispatch project (CAN-1929)', async () => {
    // This launcher passes its model to `dispatchWorktreeChatTurn` EXPLICITLY,
    // and central lane resolution there only runs when `options.model` is
    // undefined. Reading the raw worktree preference therefore bypassed
    // CAN-1929: a credits-only user kept creating rebase chats on the
    // billing-unaware native default.
    await launchRebaseResolutionChat({ ...baseArgs, prefs: prefs() } as any);

    expect(runWithScopeActivityMock).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'worktree-1' },
      expect.any(Function),
    );

    expect(mockedResolveOptional).toHaveBeenCalledTimes(1);
    const [, scope, credentialScope] = mockedResolveOptional.mock.calls[0];
    expect(scope).toBe('worktree');
    // Parity with the spawn, which resolves its Environments credentials for
    // this same workspace.
    expect(credentialScope).toEqual({ workspaceId: 'project-1' });
    expect(mockedDispatchTurn.mock.calls[0][0].model).toBe('claude-model');
  });

  it('leaves project default plugins inherited instead of copying them', async () => {
    const items: SidebarItem[] = [
      {
        id: 'project-1',
        name: 'Project',
        repoPath: '/tmp/project',
        color: '#000000',
        worktrees: [],
        collapsed: false,
        order: 0,
        type: 'single-repo',
        defaultPluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'mkt', pluginName: 'default' }],
        },
      },
    ];
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items });

    await launchRebaseResolutionChat({ ...baseArgs, prefs: prefs() });

    expect(
      mockedDispatchTurn.mock.calls[0][0].pluginSelections,
    ).toBeUndefined();
    expect(mockedUpsert.mock.calls[0]?.[0]).not.toHaveProperty(
      'tab.pluginSelections',
    );
    expect(
      mockedUpsert.mock.calls[0]?.[0].tab.inheritedPluginDefaultsVersion,
    ).toBe(1);
  });

  it('lets an explicitly configured model supersede the lane default without refusing', async () => {
    // `requireModel()` must be consumed LAZILY. A user with a configured
    // rebase model and no dispatchable lane needs this flow to work — throwing
    // for a default it never uses would strand them.
    mockedResolveOptional.mockResolvedValue({
      selection: undefined,
      requireModel: () => {
        throw new Error('No dispatchable model is available (billing-lane).');
      },
    } as any);

    await launchRebaseResolutionChat({
      ...baseArgs,
      prefs: prefs({ agentRebaseResolutionModel: 'codex-model' } as any),
    } as any);

    expect(mockedDispatchTurn.mock.calls[0][0].model).toBe('codex-model');
  });

  it('keys the thinking level on the NAMED model provider, not the surface default', async () => {
    // Same rule as `hook-chat.ts`: borrowing the preferred provider's level for
    // a differently-provided model overrides that provider's own config.
    mockedResolveOptional.mockResolvedValue({
      selection: undefined,
      requireModel: () => {
        throw new Error('unused on the explicit branch');
      },
    } as any);

    await launchRebaseResolutionChat({
      ...baseArgs,
      prefs: prefs({ agentRebaseResolutionModel: 'codex-model' } as any),
    } as any);

    // Codex's own configured `low`, not Claude's `high`.
    expect(mockedDispatchTurn.mock.calls[0][0].thinkingLevel).toBe('low');
  });

  // The user asked for the pull, so the chat that resolves it comes forward
  // like any chat they start; only chats nobody asked for stay behind.
  it('opens the resolution chat as the active tab', async () => {
    await launchRebaseResolutionChat({ ...baseArgs, prefs: prefs() });

    expect(mockedUpsert.mock.calls[0][0].activateTab).toBe(true);
    expect(jest.mocked(sendToWindow)).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ activateTab: true }),
    );
  });

  it('uses the resolved worktree approval default for the persisted tab and dispatched turn', async () => {
    await launchRebaseResolutionChat({ ...baseArgs, prefs: prefs() });

    expect(mockedResolveApprovalMode).toHaveBeenCalledWith(
      'project-1',
      'worktree-1',
    );
    expect(mockedUpsert.mock.calls[0][0].tab.approvalMode).toBe('auto');
    expect(mockedDispatchTurn.mock.calls[0][0].approvalMode).toBe('auto');
  });

  it('propagates the lane refusal when no explicit model is configured', async () => {
    // With no configured model the default IS what runs, so a dead lane is a
    // real refusal — `ipc/github.ts` catches it and falls back to the manual
    // resolution guidance rather than surfacing this text.
    mockedResolveOptional.mockResolvedValue({
      selection: undefined,
      requireModel: () => {
        throw new Error('No dispatchable model is available (billing-lane).');
      },
    } as any);

    await expect(
      launchRebaseResolutionChat({ ...baseArgs, prefs: prefs() } as any),
    ).rejects.toThrow(/dispatchable model/i);
    expect(mockedDispatchTurn).not.toHaveBeenCalled();
  });
});
