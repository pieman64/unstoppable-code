/**
 * Portal invocable resolve against the real canonical chat writer
 * (CAN-3923): enabling a row must keep the selections another writer commits
 * while the host prepares or resolves the item. A Portal plugin save that
 * reads the chat's MCP auth choices keeps the same guarantee (CAN-3922).
 */
jest.mock('../chat-state-query', () => ({
  queryPortalChatState: jest.fn(),
}));
jest.mock('../../../plugins/invocable-inventory-service', () => ({
  listInvocableInventory: jest.fn(),
  resolveInvocableSelection: jest.fn(),
}));
jest.mock('../../../plugins/plugin-service', () => ({
  ...jest.requireActual<object>('../../../plugins/plugin-service'),
  prepareCodexCompatibilityPlugin: jest.fn(),
}));
jest.mock('../../../plugins/global-plugin-overlay', () => ({
  ...jest.requireActual<object>('../../../plugins/global-plugin-overlay'),
  resolveEffectiveChatPluginContext: jest.fn(),
}));
jest.mock('../../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(() => '/host/checkout'),
}));
jest.mock('../../../agents/agent-model-store', () => ({
  getAgentModel: jest.fn(),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatCommand,
  ChatCommandEnvelope,
  ChatTabPluginSelections,
  InvocableInventoryEntry,
  McpHttpAuthPreference,
  PersistedChatTab,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import {
  assignCursorInvocationIds,
  cursorInvocationKey,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import { effectivePluginSelections } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import { normalizePluginSelections } from '@canopy/desktop-shared/lib/plugin-selections-normalization';
import { AGENT_MODEL_PREFIX } from '@canopy/desktop-shared/types/agent-models';
import { getAgentModel } from '../../../agents/agent-model-store';
import { resolveAgentModelRuntime } from '../../../agents/agent-model-runtime';
import { createDesktopRuntime } from '../../../canopy-runtime/desktop-runtime';
import {
  createChatCommandDispatchOptions,
  dispatchTrustedChatCommand,
  getIncompatibleLegacyChatPayloadFallthroughCount,
} from '../../../canopy-runtime/core-chat-command-adapter';
import { setChatStateCommandPort } from '../../../ipc/chat-state';
import {
  ChatStateService,
  type ChatStateServiceOptions,
} from '../../../services/chat-state-service';
import { ChatStateV2Repository } from '../../../services/chat-state-v2-repository';
import {
  listInvocableInventory,
  resolveInvocableSelection,
} from '../../../plugins/invocable-inventory-service';
import { prepareCodexCompatibilityPlugin } from '../../../plugins/plugin-service';
import { resolveEffectiveChatPluginContext } from '../../../plugins/global-plugin-overlay';
import { queryPortalChatState } from '../chat-state-query';
import { handlePortalChatSetPluginSelections } from '../chat-adapter';
import { handlePortalEditorResolveInvocable } from '../editor-adapter';
import type { PortalAdapterContext } from '../types';

const SCOPE = { projectId: 'project-1', worktreeId: 'worktree-1' };

const DEPLOY: InvocableInventoryEntry = {
  id: 'deploy-entry',
  provider: 'codex',
  kind: 'plugin_command',
  name: 'deploy',
  displayName: 'deploy',
  description: 'Deploy',
  insertText: '/deploy ',
  invocationKey: '/deploy',
  enableRef: {
    kind: 'plugin',
    marketplaceId: 'market',
    pluginName: 'deployer',
  },
  requiresCodexCompatPrepare: true,
};

/** A desktop edit: another plugin, an MCP server and an HTTP auth choice. */
const CONCURRENT: ChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [{ sourceId: 'src', skillName: 'lint' }],
  pluginRefs: [{ marketplaceId: 'market', pluginName: 'helper' }],
  mcpServerRefs: [{ serverId: 'docs', configId: 'docs-config' }],
  mcpHttpAuthPreferences: [
    {
      target: { kind: 'standalone', serverId: 'docs', configId: 'docs-config' },
      handler: 'provider',
    },
  ],
};

jest.setTimeout(30_000);

describe('portal.editor.resolve_invocable with the canonical writer', () => {
  let tempDir: string;
  let repository: ChatStateV2Repository;
  let service: ChatStateService;

  function envelope<T extends ChatCommand>(
    commandId: string,
    command: T,
  ): ChatCommandEnvelope<T> {
    return { schemaVersion: 1, commandId, ...SCOPE, command };
  }

  /** A Portal command context that commits through the trusted dispatcher. */
  function portalContext(
    complete: PortalAdapterContext['complete'],
    fail: PortalAdapterContext['fail'],
  ): PortalAdapterContext {
    const dispatchOptions = createChatCommandDispatchOptions(
      service,
      createDesktopRuntime(),
      {
        principalId: 'local-desktop-user',
        clientInstanceId: 'portal-command',
        authorityId: 'local-desktop',
        interfaceKind: 'desktop',
        grants: ['core.chat.write'],
      },
    );
    return {
      sessionId: 'session-1',
      chatStatePort: service,
      dispatchChatCommand: (request) =>
        dispatchTrustedChatCommand(request, dispatchOptions),
      getWindow: () => null,
      enqueueEvent: jest.fn(),
      complete,
      fail,
    };
  }

  beforeEach(async (): Promise<void> => {
    jest.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'canopy-portal-resolve-race-'));
    const paths = {
      tabs: join(tempDir, 'chats.json'),
      archives: join(tempDir, 'archives.json'),
      journal: join(tempDir, 'journal.jsonl'),
    };
    repository = new ChatStateV2Repository({
      resolvePaths: (): typeof paths => paths,
    });
    const options: ChatStateServiceOptions = {
      repository,
      now: () => 1_786_104_000_000,
      createId: () => 'event-id',
      dispatch: () => Promise.resolve(),
      onInputPickup: () => Promise.resolve(undefined),
      authorizeSend: () => Promise.resolve(undefined),
      cleanupSession: () => Promise.resolve(undefined),
      recordDiagnostic: jest.fn(),
    };
    service = new ChatStateService(options);
    setChatStateCommandPort(service);
    jest
      .mocked(queryPortalChatState)
      .mockImplementation((_context, scope) => service.getState(scope));
    jest.mocked(resolveEffectiveChatPluginContext).mockImplementation((local) =>
      Promise.resolve({
        selections: local ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
        },
      }),
    );
    jest.mocked(listInvocableInventory).mockResolvedValue({
      success: true,
      data: { entries: [DEPLOY], stale: false, rebuilding: false },
    });
    jest.mocked(resolveInvocableSelection).mockResolvedValue({
      success: true,
      data: { insertText: '/deploy ', invocationKey: '/deploy' },
    });
    await expect(
      service.command(
        envelope('create-1', {
          type: 'chat.create_tab',
          tabId: 'chat-1',
          title: 'Chat',
          providerType: 'codex',
          model: 'gpt-5-codex',
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
  });

  afterEach(async (): Promise<void> => {
    setChatStateCommandPort(null);
    await repository.drainAll();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Every point where another writer can commit during a resolve. The
  // invariant: the concurrent edit is never lost; the resolve either adds its
  // ref to it or fails with a retryable conflict.
  it.each([
    ['during Codex compatibility preparation', 'prepare', 'merged'],
    ['between the latest read and the write', 'latest_read', 'conflict'],
  ] as const)(
    'keeps a selection edit committed %s',
    async (_label, point, expectedOutcome) => {
      const complete = jest.fn<void, [PortalCommandEnvelope, unknown?]>();
      const fail = jest.fn();
      const context = portalContext(complete, fail);
      const desktopEdit = (): Promise<unknown> =>
        expect(
          service.command(
            envelope('desktop-edit', {
              type: 'chat.patch_tab_settings',
              tabId: 'chat-1',
              patch: { pluginSelections: CONCURRENT },
            }),
          ),
        ).resolves.toMatchObject({ outcome: 'applied' });
      jest
        .mocked(prepareCodexCompatibilityPlugin)
        .mockImplementation(async () => {
          if (point === 'prepare') await desktopEdit();
          return { success: true };
        });
      let reads = 0;
      jest
        .mocked(queryPortalChatState)
        .mockImplementation(async (_context, scope) => {
          const state = await service.getState(scope);
          reads += 1;
          // The second read, after preparation, supplies the selections that
          // the item is resolved against and the guarded patch expects.
          if (point === 'latest_read' && reads === 2) await desktopEdit();
          return state;
        });
      const fallthroughs = getIncompatibleLegacyChatPayloadFallthroughCount();

      await handlePortalEditorResolveInvocable(
        {
          id: 'resolve-1',
          sequence: 1,
          type: 'portal.editor.resolve_invocable',
          payload: {
            target: { kind: 'worktree', ...SCOPE, chatId: 'chat-1' },
            entryId: 'deploy-entry',
          },
          createdAt: '2026-10-08T00:00:00.000Z',
          expiresAt: null,
        },
        context,
      );

      const tab = (await service.getState(SCOPE)).tabsFile.tabs.find(
        (candidate) => candidate.id === 'chat-1',
      );
      if (expectedOutcome === 'merged') {
        const expected = {
          ...CONCURRENT,
          pluginRefs: [
            ...CONCURRENT.pluginRefs,
            { marketplaceId: 'market', pluginName: 'deployer' },
          ],
        };
        expect(fail).not.toHaveBeenCalled();
        expect(tab?.pluginSelections).toEqual(expected);
        expect(complete).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            insertText: '/deploy ',
            pluginSelections: expected,
          }),
        );
      } else {
        expect(complete).not.toHaveBeenCalled();
        expect(fail).toHaveBeenCalledWith(
          expect.anything(),
          'conflict',
          expect.any(String),
          true,
        );
        expect(tab?.pluginSelections).toEqual(CONCURRENT);
      }
      // The guarded patch stays on the canonical core route.
      expect(getIncompatibleLegacyChatPayloadFallthroughCount()).toBe(
        fallthroughs,
      );
    },
  );

  // Cursor names a colliding skill by its place in the selection order, so the
  // returned text must name the item in the committed order.
  const reviewA: InvocableInventoryEntry = {
    id: 'review-a',
    provider: 'cursor',
    kind: 'skill',
    name: 'review',
    displayName: 'review',
    description: 'Review',
    insertText: '/review ',
    invocationKey: '/review',
    enableRef: { kind: 'skill', sourceId: 'source-a', skillName: 'review' },
  };
  const reviewARef = { sourceId: 'source-a', skillName: 'review' };
  const reviewB = { sourceId: 'source-b', skillName: 'review' };

  /** Cursor's name for a skill among these selections. */
  function cursorName(
    selections: ChatTabPluginSelections,
    ref: { sourceId: string; skillName: string },
  ): string | undefined {
    return assignCursorInvocationIds(
      selections.skillRefs.map((skill) => ({ kind: 'skill', ...skill })),
    ).get(cursorInvocationKey({ kind: 'skill', ...ref }));
  }

  async function createCursorChat(model?: string): Promise<void> {
    await expect(
      service.command(
        envelope('create-cursor', {
          type: 'chat.create_tab',
          tabId: 'cursor-chat',
          seedTab: {
            id: 'cursor-chat',
            title: 'Cursor chat',
            createdAt: '2026-10-08T00:00:00.000Z',
            messages: [],
            executionHarness: 'cursor',
            ...(model ? { model } : {}),
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'applied' });
    jest
      .mocked(resolveInvocableSelection)
      .mockImplementation(({ entry, selections }) => {
        const id =
          entry.enableRef.kind === 'skill'
            ? cursorName(selections, entry.enableRef)
            : undefined;
        return Promise.resolve(
          id
            ? {
                success: true,
                data: { insertText: `/${id} `, invocationKey: `/${id}` },
              }
            : { success: false, error: 'Not selected.' },
        );
      });
  }

  function resolveReviewCommand(): PortalCommandEnvelope {
    return {
      id: 'resolve-review',
      sequence: 1,
      type: 'portal.editor.resolve_invocable',
      payload: {
        target: { kind: 'worktree', ...SCOPE, chatId: 'cursor-chat' },
        entryId: 'review-a',
      },
      createdAt: '2026-10-08T00:00:00.000Z',
      expiresAt: null,
    };
  }

  it('returns the insert text of the committed selection order', async () => {
    await createCursorChat();
    // The desktop selects the other source's skill while the host looks up
    // the row.
    jest.mocked(listInvocableInventory).mockImplementationOnce(async () => {
      await service.command(
        envelope('desktop-select', {
          type: 'chat.patch_tab_settings',
          tabId: 'cursor-chat',
          patch: {
            pluginSelections: {
              collectionIds: [],
              skillRefs: [reviewB],
              pluginRefs: [],
            },
          },
        }),
      );
      return {
        success: true,
        data: { entries: [reviewA], stale: false, rebuilding: false },
      };
    });
    const complete = jest.fn<void, [PortalCommandEnvelope, unknown?]>();
    const fail = jest.fn();

    await handlePortalEditorResolveInvocable(
      resolveReviewCommand(),
      portalContext(complete, fail),
    );

    const committed = {
      collectionIds: [],
      skillRefs: [reviewB, reviewARef],
      pluginRefs: [],
    };
    const tab = (await service.getState(SCOPE)).tabsFile.tabs.find(
      (candidate) => candidate.id === 'cursor-chat',
    );
    expect(fail).not.toHaveBeenCalled();
    expect(tab?.pluginSelections).toEqual(committed);
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        insertText: '/review-1 ',
        invocationKey: '/review-1',
        pluginSelections: committed,
      }),
    );
  });

  // An Agent's selections and the inherited defaults join the chat's own at
  // run time, so the text must name the item in the order the turn uses
  // after the commit, not in the order the selections were read.
  it('returns the insert text of the post-commit run order with an Agent', async () => {
    const agentModel = `${AGENT_MODEL_PREFIX}reviewer`;
    const agentSelections = {
      collectionIds: [],
      skillRefs: [reviewB],
      pluginRefs: [],
    };
    const inherited = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'source-c', skillName: 'review' }],
      pluginRefs: [],
    };
    jest.mocked(getAgentModel).mockResolvedValue({
      id: agentModel,
      name: 'Reviewer',
      baseModel: 'cursor-default',
      instructions: '',
      pluginSelections: agentSelections,
      createdAt: '2026-10-08T00:00:00.000Z',
      updatedAt: '2026-10-08T00:00:00.000Z',
    });
    // The inherited layer as the real overlay composes it.
    jest.mocked(resolveEffectiveChatPluginContext).mockImplementation((local) =>
      Promise.resolve({
        selections: effectivePluginSelections(
          normalizePluginSelections(local),
          inherited,
        ),
      }),
    );
    await createCursorChat(agentModel);
    jest.mocked(listInvocableInventory).mockResolvedValue({
      success: true,
      data: { entries: [reviewA], stale: false, rebuilding: false },
    });
    const complete = jest.fn<void, [PortalCommandEnvelope, unknown?]>();
    const fail = jest.fn();

    await handlePortalEditorResolveInvocable(
      resolveReviewCommand(),
      portalContext(complete, fail),
    );

    const committed = {
      collectionIds: [],
      skillRefs: [reviewARef],
      pluginRefs: [],
    };
    const tab = (await service.getState(SCOPE)).tabsFile.tabs.find(
      (candidate) => candidate.id === 'cursor-chat',
    );
    expect(fail).not.toHaveBeenCalled();
    expect(tab?.pluginSelections).toEqual(committed);
    // The turn's selections: the Agent runtime merge, then the overlay.
    const runtime = await resolveAgentModelRuntime({
      projectId: SCOPE.projectId,
      model: agentModel,
      pluginSelections: tab?.pluginSelections,
    });
    const turn = await resolveEffectiveChatPluginContext(
      runtime.pluginSelections,
      { ...SCOPE, chatId: 'cursor-chat' },
      false,
    );
    const name = cursorName(turn.selections, reviewARef);
    expect(name).toBe('review-1');
    expect(complete).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        insertText: `/${name} `,
        invocationKey: `/${name}`,
        pluginSelections: committed,
      }),
    );
  });

  it('rejects a guarded selection patch whose observed selections are stale', async () => {
    await service.command(
      envelope('desktop-edit', {
        type: 'chat.patch_tab_settings',
        tabId: 'chat-1',
        patch: { pluginSelections: CONCURRENT },
      }),
    );

    await expect(
      service.command(
        envelope('stale-enable', {
          type: 'chat.patch_tab_settings',
          tabId: 'chat-1',
          patch: {
            pluginSelections: {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [{ marketplaceId: 'market', pluginName: 'deployer' }],
            },
          },
          expectedPluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          },
        }),
      ),
    ).resolves.toMatchObject({ outcome: 'conflict' });
    const tab = (await service.getState(SCOPE)).tabsFile.tabs.find(
      (candidate) => candidate.id === 'chat-1',
    );
    expect(tab?.pluginSelections).toEqual(CONCURRENT);
  });

  // The Portal summary projects the selection refs but not the chat's MCP
  // auth choices, so a Portal save that leaves the choices out keeps the
  // saved ones (CAN-3922). It must never restore or erase choices that
  // another writer commits after the save reads the chat.
  describe('portal.chat.set_plugin_selections without MCP auth choices', () => {
    const server = { serverId: 'docs', configId: 'docs-config' };
    const authChoice = (
      handler: McpHttpAuthPreference['handler'],
    ): McpHttpAuthPreference[] => [
      {
        target: { kind: 'standalone', ...server },
        handler,
      },
    ];
    /** What a Portal client sends after it turns on one plugin. */
    const projected: ChatTabPluginSelections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [{ marketplaceId: 'market', pluginName: 'deployer' }],
      mcpServerRefs: [server],
    };

    function save(
      selections: ChatTabPluginSelections,
    ): PortalCommandEnvelope<
      PortalCommandPayloadMap['portal.chat.set_plugin_selections']
    > {
      return {
        id: 'portal-save',
        sequence: 1,
        type: 'portal.chat.set_plugin_selections',
        payload: { ...SCOPE, chatId: 'chat-1', selections },
        createdAt: '2026-10-19T00:00:00.000Z',
        expiresAt: null,
      };
    }

    async function desktopPatch(
      commandId: string,
      patch: Extract<ChatCommand, { type: 'chat.patch_tab_settings' }>['patch'],
    ): Promise<void> {
      await expect(
        service.command(
          envelope(commandId, {
            type: 'chat.patch_tab_settings',
            tabId: 'chat-1',
            patch,
          }),
        ),
      ).resolves.toMatchObject({ outcome: 'applied' });
    }

    async function savedTab(): Promise<PersistedChatTab | undefined> {
      return (await service.getState(SCOPE)).tabsFile.tabs.find(
        (candidate) => candidate.id === 'chat-1',
      );
    }

    /** Runs `edit` after the Portal save reads the chat, before it commits. */
    function editAfterRead(edit: () => Promise<void>): void {
      jest
        .mocked(queryPortalChatState)
        .mockImplementationOnce(async (_context, scope) => {
          const state = await service.getState(scope);
          await edit();
          return state;
        });
    }

    async function runSave(
      selections: ChatTabPluginSelections,
    ): Promise<{ complete: jest.Mock; fail: jest.Mock }> {
      const complete = jest.fn<void, [PortalCommandEnvelope, unknown?]>();
      const fail = jest.fn();
      await handlePortalChatSetPluginSelections(
        save(selections),
        portalContext(complete, fail),
      );
      return { complete, fail };
    }

    it.each([
      ['replaces the saved choices', authChoice('provider')],
      ['adds the first choices', undefined],
    ] as const)(
      'keeps auth choices that a desktop edit commits after the read (%s)',
      async (_label, savedAuth) => {
        await desktopPatch('desktop-before', {
          pluginSelections: {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
            mcpServerRefs: [server],
            ...(savedAuth ? { mcpHttpAuthPreferences: savedAuth } : {}),
          },
        });
        const desktopEdit: ChatTabPluginSelections = {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [server],
          mcpHttpAuthPreferences: authChoice('account'),
        };
        editAfterRead(() =>
          desktopPatch('desktop-after', { pluginSelections: desktopEdit }),
        );

        const { complete, fail } = await runSave(projected);

        expect((await savedTab())?.pluginSelections).toEqual(desktopEdit);
        expect(complete).not.toHaveBeenCalled();
        expect(fail).toHaveBeenCalledWith(
          expect.anything(),
          'conflict',
          expect.any(String),
          true,
        );
      },
    );

    it('keeps the saved auth choices when nothing changes after the read', async () => {
      await desktopPatch('desktop-before', {
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [server],
          mcpHttpAuthPreferences: authChoice('provider'),
        },
      });

      const { complete, fail } = await runSave(projected);

      expect(fail).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
      expect((await savedTab())?.pluginSelections).toEqual({
        ...projected,
        mcpHttpAuthPreferences: authChoice('provider'),
      });
    });

    it('commits after an unrelated chat change between the read and the commit', async () => {
      await desktopPatch('desktop-before', {
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [server],
          mcpHttpAuthPreferences: authChoice('provider'),
        },
      });
      editAfterRead(() =>
        desktopPatch('desktop-rename', { customTitle: 'Renamed' }),
      );

      const { complete, fail } = await runSave(projected);

      expect(fail).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
      const tab = await savedTab();
      expect(tab?.customTitle).toBe('Renamed');
      expect(tab?.pluginSelections).toEqual({
        ...projected,
        mcpHttpAuthPreferences: authChoice('provider'),
      });
    });

    it('replaces the saved auth choices with an empty list that the save names', async () => {
      await desktopPatch('desktop-before', {
        pluginSelections: {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [server],
          mcpHttpAuthPreferences: authChoice('provider'),
        },
      });
      const named = { ...projected, mcpHttpAuthPreferences: [] };

      const { complete, fail } = await runSave(named);

      expect(fail).not.toHaveBeenCalled();
      expect(complete).toHaveBeenCalledTimes(1);
      expect((await savedTab())?.pluginSelections).toEqual(named);
    });
  });
});
