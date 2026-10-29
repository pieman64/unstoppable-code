/**
 * Portal invocable inventory (CAN-3923): the remote composer lists the same
 * `/` and `$` rows the desktop composer shows for a chat, and resolving an
 * "Available to enable" row enables it through the canonical chat command
 * path before returning the authoritative insert text.
 */
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof FsPromises>('node:fs/promises'),
  readFile: jest.fn(),
}));
jest.mock('../chat-state-query', () => ({
  queryPortalChatState: jest.fn(),
}));
jest.mock('../../../services/files-service', () => ({
  buildFileIndexes: jest.fn(),
}));
jest.mock('../../../plugins/invocable-inventory-service', () => ({
  listInvocableInventory: jest.fn(),
  resolveInvocableSelection: jest.fn(),
}));
jest.mock('../../../plugins/plugin-service', () => ({
  prepareCodexCompatibilityPlugin: jest.fn(),
}));
jest.mock('../../../plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext: jest.fn(),
}));
jest.mock('../../../collections/collection-store', () => ({
  readCollectionConfig: jest.fn(),
}));
jest.mock('../../../agents/agent-model-store', () => ({
  getAgentModel: jest.fn(),
}));
jest.mock('../../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/host/checkout'),
}));
jest.mock('../../../services/standalone-chat-service', () => ({
  resolveStandaloneChatTarget: jest.fn(),
  emitStandaloneChatSummary: jest.fn(() => Promise.resolve()),
}));

import type * as FsPromises from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import {
  APP_ADVISOR_PROJECT_ID,
  type ChatCommandRequest,
  type ChatCommandResult,
  type ChatStateSnapshot,
  type ChatTabPluginSelections,
  type InvocableInventoryEntry,
  type PersistedChatTab,
  type PortalCommandEnvelope,
} from '@canopy/desktop-shared/types';
import { PORTAL_CATALOG_RESULT_MAX_BYTES } from '@canopy/protocol/portal';
import {
  handlePortalEditorListInvocables,
  handlePortalEditorResolveInvocable,
} from '../editor-adapter';
import { queryPortalChatState } from '../chat-state-query';
import {
  listInvocableInventory,
  resolveInvocableSelection,
} from '../../../plugins/invocable-inventory-service';
import { prepareCodexCompatibilityPlugin } from '../../../plugins/plugin-service';
import { resolveEffectiveChatPluginContext } from '../../../plugins/global-plugin-overlay';
import { readCollectionConfig } from '../../../collections/collection-store';
import { getAgentModel } from '../../../agents/agent-model-store';
import {
  emitStandaloneChatSummary,
  resolveStandaloneChatTarget,
} from '../../../services/standalone-chat-service';
import type { PortalAdapterContext } from '../types';

const mockedReadFile = jest.mocked(readFile);
const mockedQuery = jest.mocked(queryPortalChatState);
const mockedList = jest.mocked(listInvocableInventory);
const mockedResolve = jest.mocked(resolveInvocableSelection);
const mockedPrepare = jest.mocked(prepareCodexCompatibilityPlugin);
const mockedOverlay = jest.mocked(resolveEffectiveChatPluginContext);
const mockedReadCollection = jest.mocked(readCollectionConfig);
const mockedGetAgent = jest.mocked(getAgentModel);
const mockedStandaloneTarget = jest.mocked(resolveStandaloneChatTarget);
const mockedEmitStandalone = jest.mocked(emitStandaloneChatSummary);

const EMPTY: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};

function entry(
  input: Partial<InvocableInventoryEntry> &
    Pick<InvocableInventoryEntry, 'id' | 'name' | 'enableRef'>,
): InvocableInventoryEntry {
  return {
    provider: 'claude',
    kind: input.enableRef.kind === 'skill' ? 'skill' : 'plugin_command',
    displayName: input.name,
    description: `${input.name} description`,
    insertText: `/${input.name} `,
    invocationKey: `/${input.name}`,
    ...input,
  };
}

const DEPLOY = entry({
  id: 'deploy-entry',
  name: 'deploy',
  enableRef: {
    kind: 'plugin',
    marketplaceId: 'market',
    pluginName: 'deployer',
  },
  sourceLabel: 'deployer',
});
const LINT = entry({
  id: 'lint-entry',
  name: 'lint',
  enableRef: { kind: 'skill', sourceId: 'src', skillName: 'lint' },
  sourceLabel: 'owner/skills',
});
const DEFAULTED = entry({
  id: 'default-entry',
  name: 'standup',
  enableRef: { kind: 'plugin', marketplaceId: 'market', pluginName: 'daily' },
});
const AGENT = entry({
  id: 'agent-entry',
  name: 'triage',
  enableRef: { kind: 'plugin', marketplaceId: 'market', pluginName: 'agentic' },
});
const BRANCH_DUPLICATE = entry({
  id: 'branch-entry',
  name: 'branch',
  enableRef: { kind: 'plugin', marketplaceId: 'market', pluginName: 'git' },
});
const REVIEW = entry({
  id: 'review-entry',
  name: 'review',
  enableRef: { kind: 'skill', sourceId: 'src', skillName: 'review' },
  // A local skill source names a host folder; it must not reach the wire.
  sourceLabel: '/Users/someone/skills',
});

function chatTab(overrides: Partial<PersistedChatTab> = {}): PersistedChatTab {
  return {
    id: 'chat-1',
    title: 'Chat',
    createdAt: '2026-10-08T00:00:00.000Z',
    kind: 'chat',
    model: 'claude-sonnet-4-6',
    providerType: 'claude',
    executionHarness: 'claude',
    messages: [],
    pluginSelections: {
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'deployer' }],
    },
    disabledGlobalPluginSelections: {
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'retired' }],
    },
    inheritedPluginDefaultsVersion: 1,
    discovery: {
      providerType: 'claude',
      slashCommands: [
        {
          name: 'branch',
          description: 'Name a branch',
          insertText: '/branch ',
        },
      ],
      mcpServers: [],
      discoveredAt: '2026-10-08T00:00:00.000Z',
    },
    ...overrides,
  };
}

function snapshot(
  tab: PersistedChatTab,
  scope = { projectId: 'project-1', worktreeId: 'worktree-1' },
): ChatStateSnapshot {
  return {
    schemaVersion: 1,
    ...scope,
    revision: 7,
    tabsFile: { version: 1, activeTabId: tab.id, tabs: [tab] },
    archives: [],
    runtimeByChatId: {},
    queue: [],
  };
}

type CompleteMock = jest.Mock<void, [PortalCommandEnvelope, unknown?]>;
type FailMock = jest.Mock<
  void,
  [PortalCommandEnvelope, string, string, boolean?]
>;

interface Harness {
  context: PortalAdapterContext;
  complete: CompleteMock;
  fail: FailMock;
  dispatch: jest.Mock<Promise<ChatCommandResult>, [ChatCommandRequest]>;
}

function harness(outcome: ChatCommandResult['outcome'] = 'applied'): Harness {
  const complete = jest.fn<void, [PortalCommandEnvelope, unknown?]>();
  const fail = jest.fn<
    void,
    [PortalCommandEnvelope, string, string, boolean?]
  >();
  const dispatch = jest.fn((request: ChatCommandRequest) =>
    Promise.resolve({
      commandId: request.commandId,
      outcome,
      revision: 8,
    }),
  );
  return {
    complete,
    fail,
    dispatch,
    context: {
      sessionId: 'session-1',
      chatStatePort: {
        command: jest.fn(),
        getState: jest.fn(),
        getTranscriptPage: jest.fn(),
        readToolOutput: jest.fn(),
        subscribe: jest.fn(() => jest.fn()),
      },
      dispatchChatCommand: dispatch,
      getWindow: () => null,
      enqueueEvent: jest.fn(),
      complete,
      fail,
    },
  };
}

function envelope<T>(type: string, payload: T): PortalCommandEnvelope<T> {
  return {
    id: 'command-1',
    sequence: 1,
    type: type as PortalCommandEnvelope['type'],
    payload,
    createdAt: '2026-10-08T00:00:00.000Z',
    expiresAt: null,
  };
}

function expectFailed(fail: FailMock, code: string, retryable = false): void {
  expect(fail).toHaveBeenCalledTimes(1);
  expect(fail.mock.calls[0]?.[1]).toBe(code);
  expect(fail.mock.calls[0]?.[3] ?? false).toBe(retryable);
}

const WORKTREE_TARGET = {
  kind: 'worktree',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
} as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockedQuery.mockResolvedValue(snapshot(chatTab()));
  mockedList.mockResolvedValue({
    success: true,
    data: {
      entries: [REVIEW, AGENT, DEFAULTED, BRANCH_DUPLICATE, LINT, DEPLOY],
      stale: false,
      rebuilding: false,
      builtAt: '2026-10-08T00:00:00.000Z',
    },
  });
  // The inherited layers add the workspace default plugin.
  mockedOverlay.mockImplementation((local) =>
    Promise.resolve({
      selections: {
        ...(local ?? EMPTY),
        pluginRefs: [
          ...(local?.pluginRefs ?? []),
          { marketplaceId: 'market', pluginName: 'daily' },
        ],
      },
    }),
  );
  mockedReadCollection.mockResolvedValue({
    version: 1,
    collection: {
      id: 'collection-1',
      name: 'Collection',
      skills: [{ sourceId: 'src', skillName: 'lint' }],
      plugins: [],
    },
  } as unknown as Awaited<ReturnType<typeof readCollectionConfig>>);
  mockedGetAgent.mockResolvedValue(null);
  // A foreign-provider worktree discovery must not replace the tab's own.
  mockedReadFile.mockResolvedValue(
    JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'worktree-1',
          discovery: {
            providerType: 'codex',
            slashCommands: [{ name: 'codex-only', description: '' }],
          },
        },
      ],
    }),
  );
  mockedStandaloneTarget.mockResolvedValue({
    workspaceId: 'cowork-default',
    entryId: 'entry-1',
    archivedInEntryId: null,
    isArchived: false,
  });
});

describe('portal.editor.list_invocables', () => {
  it('returns the desktop menu rows for a worktree chat, including available rows', async () => {
    const { context, complete, fail } = harness();

    await handlePortalEditorListInvocables(
      envelope('portal.editor.list_invocables', { target: WORKTREE_TARGET }),
      context,
    );

    expect(fail).not.toHaveBeenCalled();
    expect(mockedList).toHaveBeenCalledWith({ providerType: 'claude' });
    // Canonical tombstones and layering stamp come from the queried tab, so
    // the overlay never rereads the legacy chat file.
    expect(mockedOverlay).toHaveBeenCalledWith(
      chatTab().pluginSelections,
      { projectId: 'project-1', worktreeId: 'worktree-1', chatId: 'chat-1' },
      {
        chatTombstones: chatTab().disabledGlobalPluginSelections,
        inheritsProjectDefaults: true,
      },
    );
    expect(complete).toHaveBeenCalledWith(expect.anything(), {
      commands: [
        {
          name: 'branch',
          description: 'Name a branch',
          insertText: '/branch ',
          section: 'discovered',
        },
        // Enabled directly, by the inherited default and by the Collection.
        {
          name: 'standup',
          displayName: 'standup',
          description: 'standup description',
          insertText: '/standup ',
          section: 'discovered',
          entryId: 'default-entry',
        },
        {
          name: 'deploy',
          displayName: 'deploy',
          description: 'deploy description',
          insertText: '/deploy ',
          section: 'discovered',
          category: 'deployer',
          entryId: 'deploy-entry',
        },
        {
          name: 'lint',
          displayName: 'lint',
          description: 'lint description',
          insertText: '/lint ',
          section: 'discovered',
          category: 'owner/skills',
          entryId: 'lint-entry',
        },
        {
          name: 'triage',
          displayName: 'triage',
          description: 'triage description',
          insertText: '/triage ',
          section: 'available',
          entryId: 'agent-entry',
          requiresResolution: true,
        },
        {
          name: 'review',
          displayName: 'review',
          description: 'review description',
          insertText: '/review ',
          section: 'available',
          entryId: 'review-entry',
          requiresResolution: true,
        },
      ],
      stale: false,
      rebuilding: false,
      builtAt: '2026-10-08T00:00:00.000Z',
    });
  });

  it('counts an Agent model selection as enabled', async () => {
    mockedQuery.mockResolvedValue(
      snapshot(chatTab({ model: 'agent_model_reviewer' })),
    );
    mockedGetAgent.mockResolvedValue({
      pluginSelections: {
        ...EMPTY,
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'agentic' }],
      },
    } as unknown as Awaited<ReturnType<typeof getAgentModel>>);
    const { context, complete } = harness();

    await handlePortalEditorListInvocables(
      envelope('portal.editor.list_invocables', { target: WORKTREE_TARGET }),
      context,
    );

    expect(mockedGetAgent).toHaveBeenCalledWith(
      'agent_model_reviewer',
      'project-1',
    );
    const result = complete.mock.calls[0]?.[1] as {
      commands: Array<{ name: string; section: string }>;
    };
    expect(result.commands.find((row) => row.name === 'triage')).toMatchObject({
      section: 'discovered',
    });
  });

  it('falls back to matching worktree discovery when the tab has none', async () => {
    mockedQuery.mockResolvedValue(
      snapshot(
        chatTab({
          model: 'gpt-5.4',
          providerType: 'codex',
          executionHarness: 'codex',
          discovery: undefined,
        }),
      ),
    );
    mockedList.mockResolvedValue({
      success: true,
      data: { entries: [], stale: true, rebuilding: true },
    });
    const { context, complete } = harness();

    await handlePortalEditorListInvocables(
      envelope('portal.editor.list_invocables', { target: WORKTREE_TARGET }),
      context,
    );

    expect(mockedList).toHaveBeenCalledWith({ providerType: 'codex' });
    expect(complete).toHaveBeenCalledWith(expect.anything(), {
      commands: [
        { name: 'codex-only', description: '', section: 'discovered' },
      ],
      stale: true,
      rebuilding: true,
    });
  });

  it('lists a standalone chat by its Work Entry without a worktree read', async () => {
    mockedQuery.mockResolvedValue(
      snapshot(
        chatTab({
          id: 'standalone-1',
          model: 'gpt-5.4',
          providerType: 'codex',
          executionHarness: 'codex',
          discovery: undefined,
        }),
        { projectId: 'cowork-default', worktreeId: 'entry-1' },
      ),
    );
    const { context, complete, fail } = harness();

    await handlePortalEditorListInvocables(
      envelope('portal.editor.list_invocables', {
        target: {
          kind: 'standalone',
          projectLocalId: 'cowork-default',
          chatId: 'standalone-1',
        },
      }),
      context,
    );

    expect(fail).not.toHaveBeenCalled();
    expect(mockedStandaloneTarget).toHaveBeenCalledWith({
      projectLocalId: 'cowork-default',
      chatId: 'standalone-1',
    });
    expect(mockedQuery).toHaveBeenCalledWith(context, {
      projectId: 'cowork-default',
      worktreeId: 'entry-1',
    });
    expect(mockedList).toHaveBeenCalledWith({ providerType: 'codex' });
    expect(mockedReadFile).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]?.[1]).toHaveProperty('commands');
  });

  it('reports an explicit partial list instead of an oversized result', async () => {
    const entries = Array.from({ length: 4_000 }, (_, index) =>
      entry({
        id: `bulk-${index}`,
        name: `bulk-${index}`,
        description: 'x'.repeat(200),
        enableRef: {
          kind: 'skill',
          sourceId: 'bulk',
          skillName: `bulk-${index}`,
        },
      }),
    );
    mockedList.mockResolvedValue({
      success: true,
      data: { entries, stale: false, rebuilding: false },
    });
    const { context, complete } = harness();

    await handlePortalEditorListInvocables(
      envelope('portal.editor.list_invocables', { target: WORKTREE_TARGET }),
      context,
    );

    const result = complete.mock.calls[0]?.[1] as {
      commands: unknown[];
      truncated?: boolean;
    };
    expect(result.truncated).toBe(true);
    expect(result.commands.length).toBeGreaterThan(0);
    expect(
      Buffer.byteLength(JSON.stringify(result), 'utf8'),
    ).toBeLessThanOrEqual(PORTAL_CATALOG_RESULT_MAX_BYTES);
  });

  it.each([
    ['a host path target', { target: { ...WORKTREE_TARGET, chatId: '../x' } }],
    ['a missing target', {}],
    [
      'an embedded App Advisor scope',
      {
        target: { ...WORKTREE_TARGET, projectId: APP_ADVISOR_PROJECT_ID },
      },
    ],
    ['an unknown provider', { target: WORKTREE_TARGET, providerType: 'x' }],
  ])('rejects %s before reading chat state', async (_label, payload) => {
    const { context, complete, fail } = harness();

    await handlePortalEditorListInvocables(
      envelope('portal.editor.list_invocables', payload),
      context,
    );

    expectFailed(fail, 'invalid_payload');
    expect(mockedQuery).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects a provider scope that conflicts with the chat', async () => {
    const { context, complete, fail } = harness();

    await handlePortalEditorListInvocables(
      envelope('portal.editor.list_invocables', {
        target: WORKTREE_TARGET,
        providerType: 'codex',
      }),
      context,
    );

    expectFailed(fail, 'invalid_payload');
    expect(mockedList).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ['an archived standalone chat', { isArchived: true }],
    ['a standalone chat without a Work Entry', { entryId: null }],
  ])('reports %s as not found', async (_label, resolution) => {
    mockedStandaloneTarget.mockResolvedValue({
      workspaceId: 'cowork-default',
      entryId: 'entry-1',
      archivedInEntryId: null,
      isArchived: false,
      ...resolution,
    });
    const { context, fail } = harness();

    await handlePortalEditorListInvocables(
      envelope('portal.editor.list_invocables', {
        target: {
          kind: 'standalone',
          projectLocalId: 'cowork-default',
          chatId: 'standalone-1',
        },
      }),
      context,
    );

    expectFailed(fail, 'not_found');
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});

describe('portal.editor.resolve_invocable', () => {
  beforeEach(() => {
    mockedResolve.mockResolvedValue({
      success: true,
      data: { insertText: '/review ', invocationKey: '/review' },
    });
  });

  it('enables an available row through the canonical chat command and returns its insert text', async () => {
    const { context, complete, fail, dispatch } = harness();

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: WORKTREE_TARGET,
        entryId: 'review-entry',
      }),
      context,
    );

    expect(fail).not.toHaveBeenCalled();
    // The resolver sees the effective selection plus the new ref and the
    // host-resolved checkout; the client supplies neither.
    expect(mockedResolve).toHaveBeenCalledWith({
      providerType: 'claude',
      entry: REVIEW,
      selections: {
        collectionIds: ['collection-1'],
        skillRefs: [{ sourceId: 'src', skillName: 'review' }],
        pluginRefs: [
          { marketplaceId: 'market', pluginName: 'deployer' },
          { marketplaceId: 'market', pluginName: 'daily' },
        ],
      },
      chatTombstones: chatTab().disabledGlobalPluginSelections,
      projectPath: '/host/checkout',
    });
    // Only the chat's own selection gains the ref; inherited defaults stay
    // live instead of being pinned as local picks. The patch is guarded by
    // the selections it was computed from.
    const observed: ChatTabPluginSelections = {
      collectionIds: ['collection-1'],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'deployer' }],
    };
    const committed: ChatTabPluginSelections = {
      ...observed,
      skillRefs: [{ sourceId: 'src', skillName: 'review' }],
    };
    expect(dispatch).toHaveBeenCalledWith({
      schemaVersion: 1,
      commandId: 'command-1',
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      origin: 'portal',
      command: {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { pluginSelections: committed },
        expectedPluginSelections: observed,
      },
    });
    expect(complete).toHaveBeenCalledWith(expect.anything(), {
      insertText: '/review ',
      invocationKey: '/review',
      pluginSelections: committed,
    });
    expect(mockedEmitStandalone).not.toHaveBeenCalled();
  });

  it('projects the standalone summary after the commit', async () => {
    mockedQuery.mockResolvedValue(
      snapshot(chatTab({ id: 'standalone-1' }), {
        projectId: 'cowork-default',
        worktreeId: 'entry-1',
      }),
    );
    const { context, complete, dispatch } = harness();

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: {
          kind: 'standalone',
          projectLocalId: 'cowork-default',
          chatId: 'standalone-1',
        },
        entryId: 'review-entry',
      }),
      context,
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'cowork-default',
        worktreeId: 'entry-1',
      }),
    );
    expect(mockedEmitStandalone).toHaveBeenCalledWith(
      'cowork-default',
      'entry-1',
      'standalone-1',
    );
    expect(mockedEmitStandalone.mock.invocationCallOrder[0]).toBeLessThan(
      complete.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('completes a duplicate delivery from the existing receipt', async () => {
    const { context, complete, fail } = harness('already_applied');

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: WORKTREE_TARGET,
        entryId: 'review-entry',
      }),
      context,
    );

    expect(fail).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ insertText: '/review ' }),
    );
  });

  it('reports a conflict outcome as retryable without completing', async () => {
    const { context, complete, fail } = harness('conflict');

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: WORKTREE_TARGET,
        entryId: 'review-entry',
      }),
      context,
    );

    expectFailed(fail, 'conflict', true);
    expect(complete).not.toHaveBeenCalled();
  });

  it('never completes when the durable commit is unavailable', async () => {
    const { context, complete, fail, dispatch } = harness();
    dispatch.mockRejectedValue(new Error('storage offline'));

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: WORKTREE_TARGET,
        entryId: 'review-entry',
      }),
      context,
    );

    expectFailed(fail, 'execution_failed', true);
    expect(complete).not.toHaveBeenCalled();
  });

  it('resolves an inherited row without writing a selection', async () => {
    const inherited = entry({
      id: 'inherited-entry',
      name: 'notes',
      provider: 'cursor',
      kind: 'inherited_skill',
      enableRef: { kind: 'none' },
    });
    mockedQuery.mockResolvedValue(
      snapshot(
        chatTab({
          model: 'cursor-default',
          providerType: 'cursor',
          executionHarness: 'cursor',
        }),
      ),
    );
    mockedList.mockResolvedValue({
      success: true,
      data: { entries: [inherited], stale: false, rebuilding: false },
    });
    mockedResolve.mockResolvedValue({
      success: true,
      data: { insertText: '/notes-1 ', invocationKey: '/notes-1' },
    });
    const { context, complete, dispatch } = harness();

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: WORKTREE_TARGET,
        entryId: 'inherited-entry',
      }),
      context,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.anything(), {
      insertText: '/notes-1 ',
      invocationKey: '/notes-1',
    });
  });

  it('prepares Codex compatibility before resolving and stops when it fails', async () => {
    const compat = entry({
      id: 'compat-entry',
      name: 'compat',
      provider: 'codex',
      enableRef: {
        kind: 'plugin',
        marketplaceId: 'market',
        pluginName: 'compat',
      },
      requiresCodexCompatPrepare: true,
    });
    mockedQuery.mockResolvedValue(
      snapshot(
        chatTab({
          model: 'gpt-5.4',
          providerType: 'codex',
          executionHarness: 'codex',
        }),
      ),
    );
    mockedList.mockResolvedValue({
      success: true,
      data: { entries: [compat], stale: false, rebuilding: false },
    });
    mockedPrepare.mockResolvedValue({ success: false, error: 'offline' });
    const { context, complete, fail, dispatch } = harness();

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: WORKTREE_TARGET,
        entryId: 'compat-entry',
      }),
      context,
    );

    expect(mockedPrepare).toHaveBeenCalledWith('market', 'compat');
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expectFailed(fail, 'execution_failed');
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ['a removed row', 'missing-entry', 'not_found'],
    ['a row the resolver no longer finds', 'review-entry', 'not_found'],
  ])('rejects %s without mutating selections', async (label, entryId, code) => {
    if (label === 'a row the resolver no longer finds') {
      mockedResolve.mockResolvedValue({
        success: false,
        error: 'Selected plugin is no longer installed.',
      });
    }
    const { context, complete, fail, dispatch } = harness();

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: WORKTREE_TARGET,
        entryId,
      }),
      context,
    );

    expect(dispatch).not.toHaveBeenCalled();
    expectFailed(fail, code);
    expect(complete).not.toHaveBeenCalled();
  });

  it('ignores client-supplied enable refs and insert text', async () => {
    const { context, dispatch } = harness();

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', {
        target: WORKTREE_TARGET,
        entryId: 'review-entry',
        entry: { ...REVIEW, insertText: '/forged ' },
        enableRef: { kind: 'plugin', marketplaceId: 'x', pluginName: 'y' },
      }),
      context,
    );

    expect(mockedResolve.mock.calls[0]?.[0].entry).toEqual(REVIEW);
    expect(dispatch.mock.calls[0]?.[0].command).toEqual({
      type: 'chat.patch_tab_settings',
      tabId: 'chat-1',
      patch: {
        pluginSelections: {
          collectionIds: ['collection-1'],
          skillRefs: [{ sourceId: 'src', skillName: 'review' }],
          pluginRefs: [{ marketplaceId: 'market', pluginName: 'deployer' }],
        },
      },
      expectedPluginSelections: {
        collectionIds: ['collection-1'],
        skillRefs: [],
        pluginRefs: [{ marketplaceId: 'market', pluginName: 'deployer' }],
      },
    });
  });

  it('rejects a missing entry id before reading chat state', async () => {
    const { context, fail } = harness();

    await handlePortalEditorResolveInvocable(
      envelope('portal.editor.resolve_invocable', { target: WORKTREE_TARGET }),
      context,
    );

    expectFailed(fail, 'invalid_payload');
    expect(mockedQuery).not.toHaveBeenCalled();
  });
});
