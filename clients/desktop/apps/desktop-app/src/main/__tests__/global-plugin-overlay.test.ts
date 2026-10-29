import type {
  ChatTabPluginSelections,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import type { ProjectPluginDefaults } from '../plugins/project-plugin-defaults-cache';

const readPreferencesFileMock = jest.fn<Promise<Partial<PreferencesData>>, []>(
  () => Promise.resolve({}),
);
const readProjectPluginDefaultsMock = jest.fn<
  Promise<ProjectPluginDefaults>,
  [string]
>(() => Promise.resolve({}));
const readPersistedChatPluginTombstonesMock = jest.fn<
  Promise<unknown>,
  [string, string, string]
>(() => Promise.resolve(undefined));
// Chats the app creates now are stamped; a legacy chat is not.
const readPersistedChatStampMock = jest.fn<boolean, [string]>(() => true);

jest.mock('../lib/preferences-store', () => ({
  DEFAULT_PREFERENCES: {},
  readPreferencesFile: (): Promise<Partial<PreferencesData>> =>
    readPreferencesFileMock(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readProjectPluginDefaults: (workspaceId: string): Promise<unknown> =>
    readProjectPluginDefaultsMock(workspaceId),
}));
const loadAccountMcpRefConnectionsMock = jest.fn();
jest.mock('../feature-flags/service', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));
jest.mock('../canopy-cloud/mcp-connections', () => ({
  listAccountMcpConnections: (): unknown => loadAccountMcpRefConnectionsMock(),
}));
jest.mock('../lib/chat-tabs-reader', () => ({
  readPersistedChatPluginInheritance: async (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<unknown> => ({
    tombstones: await readPersistedChatPluginTombstonesMock(
      projectId,
      worktreeId,
      chatId,
    ),
    inheritsProjectDefaults: readPersistedChatStampMock(chatId),
  }),
}));

import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  resolveBackgroundChatPluginSelections,
  resolveEffectiveChatPluginContext,
  resolveEffectiveChatPluginSelections,
} from '../plugins/global-plugin-overlay';

const TARGET = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' };
const pluginA = { marketplaceId: 'mkt', pluginName: 'plug-a' };
const pluginB = { marketplaceId: 'mkt', pluginName: 'plug-b' };

function selections(
  overrides: Partial<ChatTabPluginSelections> = {},
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [], ...overrides };
}

describe('resolveEffectiveChatPluginSelections', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    readPreferencesFileMock.mockResolvedValue({});
    readProjectPluginDefaultsMock.mockResolvedValue({});
    readPersistedChatPluginTombstonesMock.mockResolvedValue(undefined);
    readPersistedChatStampMock.mockReturnValue(true);
  });

  // Home discovery resolves a draft that has no chat yet; it must match the
  // chat the draft creates, which turns off every default the draft lacks.
  it('turns off the project defaults a draft left out, like the chat it creates', async () => {
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({ pluginRefs: [pluginB] }),
    });
    readProjectPluginDefaultsMock.mockResolvedValue({
      defaultPluginSelections: selections({
        pluginRefs: [pluginA],
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      }),
    });
    const result = await resolveEffectiveChatPluginSelections(
      selections({
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      }),
      { ...TARGET, chatId: '__home_discovery__' },
      { draft: true },
    );
    expect(result.pluginRefs).toEqual([pluginB]);
    expect(result.mcpServerRefs).toEqual([
      { serverId: 'linear', configId: 'default' },
    ]);
    expect(readPersistedChatPluginTombstonesMock).not.toHaveBeenCalled();
  });

  // A chat from before live project defaults keeps exactly the selection it
  // had until it is normalized; only the global layer reaches it meanwhile.
  describe('an unstamped chat', () => {
    beforeEach(() => {
      readPreferencesFileMock.mockResolvedValue({
        globalPluginSelections: selections({ pluginRefs: [pluginB] }),
      });
      readProjectPluginDefaultsMock.mockResolvedValue({
        defaultPluginSelections: selections({
          pluginRefs: [pluginA],
          mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
        }),
      });
      readPersistedChatStampMock.mockReturnValue(false);
    });

    it('does not inherit the project defaults it lacked', async () => {
      const result = await resolveEffectiveChatPluginSelections(
        selections(),
        TARGET,
        true,
      );
      expect(result.pluginRefs).toEqual([pluginB]);
      expect(result.mcpServerRefs).toEqual([]);
    });

    it('reads the stamp even when the tombstones are in flight', async () => {
      const result = await resolveEffectiveChatPluginSelections(
        selections(),
        TARGET,
        { chatTombstones: {} },
      );
      expect(result.pluginRefs).toEqual([pluginB]);
      expect(readPersistedChatStampMock).toHaveBeenCalledWith('chat-1');
    });

    it('follows a caller that says the chat inherits them', async () => {
      const result = await resolveEffectiveChatPluginSelections(
        selections(),
        TARGET,
        {
          chatTombstones: { pluginRefs: [pluginA] },
          inheritsProjectDefaults: true,
        },
      );
      expect(result.pluginRefs).toEqual([pluginB]);
      expect(result.mcpServerRefs).toEqual([
        { serverId: 'linear', configId: 'default' },
      ]);
      expect(readPersistedChatStampMock).not.toHaveBeenCalled();
      expect(readPersistedChatPluginTombstonesMock).not.toHaveBeenCalled();
    });
  });

  it('performs no IO when the overlay is not requested', async () => {
    const local = selections({ pluginRefs: [pluginA] });
    const result = await resolveEffectiveChatPluginSelections(
      local,
      TARGET,
      false,
    );
    expect(result.pluginRefs).toEqual([pluginA]);
    expect(readPreferencesFileMock).not.toHaveBeenCalled();
    expect(readProjectPluginDefaultsMock).not.toHaveBeenCalled();
    expect(readPersistedChatPluginTombstonesMock).not.toHaveBeenCalled();
  });

  it('skips the chat tombstone read when neither inherited layer has entries', async () => {
    const result = await resolveEffectiveChatPluginSelections(
      selections({ pluginRefs: [pluginA] }),
      TARGET,
      true,
    );
    expect(result.pluginRefs).toEqual([pluginA]);
    expect(readPreferencesFileMock).toHaveBeenCalledTimes(1);
    expect(readProjectPluginDefaultsMock).toHaveBeenCalledTimes(1);
    expect(readPersistedChatPluginTombstonesMock).not.toHaveBeenCalled();
  });

  it('inherits project defaults live even without global defaults', async () => {
    readProjectPluginDefaultsMock.mockResolvedValue({
      defaultPluginSelections: selections({
        mcpServerRefs: [{ serverId: 'linear', configId: 'default' }],
      }),
    });
    const result = await resolveEffectiveChatPluginSelections(
      selections({ pluginRefs: [pluginA] }),
      TARGET,
      true,
    );
    expect(result.pluginRefs).toEqual([pluginA]);
    expect(result.mcpServerRefs).toEqual([
      { serverId: 'linear', configId: 'default' },
    ]);
    expect(readProjectPluginDefaultsMock).toHaveBeenCalledWith('ws-1');
  });

  it('lets a chat tombstone turn off a project default but not a local choice', async () => {
    readProjectPluginDefaultsMock.mockResolvedValue({
      defaultPluginSelections: selections({ pluginRefs: [pluginA, pluginB] }),
    });
    readPersistedChatPluginTombstonesMock.mockResolvedValue({
      pluginRefs: [pluginA, pluginB],
    });
    const result = await resolveEffectiveChatPluginSelections(
      selections({ pluginRefs: [pluginB] }),
      TARGET,
      true,
    );
    expect(result.pluginRefs).toEqual([pluginB]);
  });

  it('keeps a project default the workspace suppressed as a global default', async () => {
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({ pluginRefs: [pluginA] }),
    });
    readProjectPluginDefaultsMock.mockResolvedValue({
      defaultPluginSelections: selections({ pluginRefs: [pluginA] }),
      disabledGlobalPluginSelections: { pluginRefs: [pluginA] },
    });
    const result = await resolveEffectiveChatPluginSelections(
      selections(),
      TARGET,
      true,
    );
    expect(result.pluginRefs).toEqual([pluginA]);
  });

  it('reads the cowork workspace defaults for a legacy standalone target', async () => {
    await resolveEffectiveChatPluginSelections(
      selections(),
      {
        projectId: 'standalone-chat',
        worktreeId: 'cowork-1',
        chatId: 'chat-1',
      },
      true,
    );
    expect(readProjectPluginDefaultsMock).toHaveBeenCalledWith('cowork-1');
  });

  it('unions the global overlay into local selections', async () => {
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({ pluginRefs: [pluginB] }),
    });
    const result = await resolveEffectiveChatPluginSelections(
      selections({ pluginRefs: [pluginA] }),
      TARGET,
      true,
    );
    expect(result.pluginRefs).toEqual([pluginB, pluginA]);
  });

  it('subtracts project and persisted chat tombstone layers', async () => {
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({
        pluginRefs: [pluginA, pluginB],
        collectionIds: ['col-g'],
      }),
    });
    readProjectPluginDefaultsMock.mockResolvedValue({
      disabledGlobalPluginSelections: { pluginRefs: [pluginA] },
    });
    readPersistedChatPluginTombstonesMock.mockResolvedValue({
      collectionIds: ['col-g'],
    });
    const result = await resolveEffectiveChatPluginSelections(
      selections(),
      TARGET,
      true,
    );
    expect(result.pluginRefs).toEqual([pluginB]);
    expect(result.collectionIds).toEqual([]);
    expect(readPersistedChatPluginTombstonesMock).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      'chat-1',
    );
  });

  it('maps legacy account MCP refs in every layer before applying tombstones', async () => {
    loadAccountMcpRefConnectionsMock.mockResolvedValue([
      {
        id: 'connection-github',
        serverKey: 'github',
        configId: 'default',
        kind: 'CURATED',
      },
      {
        id: 'connection-custom',
        serverKey: 'custom:11111111-2222-4333-8444-555555555555',
        configId: 'default',
        kind: 'CUSTOM',
      },
    ]);
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({
        mcpServerRefs: [
          { serverId: 'account:connection-github', configId: 'default' },
          { serverId: 'account:connection-custom', configId: 'default' },
        ],
      }),
    });
    readProjectPluginDefaultsMock.mockResolvedValue({
      disabledGlobalPluginSelections: {
        mcpServerRefs: [{ serverId: 'github', configId: 'default' }],
      },
    });
    readPersistedChatPluginTombstonesMock.mockResolvedValue({
      mcpServerRefs: [
        { serverId: 'account:connection-custom', configId: 'default' },
      ],
    });
    const result = await resolveEffectiveChatPluginSelections(
      selections({
        mcpServerRefs: [{ serverId: 'account:gone', configId: 'default' }],
      }),
      TARGET,
      true,
    );
    expect(result.mcpServerRefs).toEqual([]);
  });

  it('prefers in-flight chat tombstones over the persisted read', async () => {
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({ pluginRefs: [pluginA, pluginB] }),
    });
    const result = await resolveEffectiveChatPluginSelections(
      selections(),
      TARGET,
      { chatTombstones: { pluginRefs: [pluginB] } },
    );
    expect(result.pluginRefs).toEqual([pluginA]);
    expect(readPersistedChatPluginTombstonesMock).not.toHaveBeenCalled();
  });

  it('applies no suppression when tombstone reads fail', async () => {
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({ pluginRefs: [pluginA] }),
    });
    readProjectPluginDefaultsMock.mockRejectedValue(
      new Error('corrupt config'),
    );
    readPersistedChatPluginTombstonesMock.mockRejectedValue(
      new Error('missing tab file'),
    );
    const result = await resolveEffectiveChatPluginSelections(
      selections(),
      TARGET,
      true,
    );
    expect(result.pluginRefs).toEqual([pluginA]);
  });

  it('degrades to local selections when preferences cannot be read', async () => {
    readPreferencesFileMock.mockRejectedValue(new Error('corrupt preferences'));
    const local = selections({ pluginRefs: [pluginA] });

    const context = await resolveEffectiveChatPluginContext(
      local,
      TARGET,
      true,
    );

    expect(context.selections.pluginRefs).toEqual([pluginA]);
    expect(context.preferences).toEqual({});
    expect(readPersistedChatPluginTombstonesMock).not.toHaveBeenCalled();
  });

  it('reads and exposes the chat tombstones with no default layer when a harness asks for them', async () => {
    // Nothing is inherited from the defaults, but the chat turned a plugin
    // off; Cursor's Claude Code inheritance must still see that.
    readPersistedChatPluginTombstonesMock.mockResolvedValue({
      pluginRefs: [pluginB],
    });

    const context = await resolveEffectiveChatPluginContext(
      selections({ pluginRefs: [pluginA] }),
      TARGET,
      { includeChatTombstones: true },
    );

    expect(context.selections.pluginRefs).toEqual([pluginA]);
    expect(context.chatTombstones?.pluginRefs).toEqual([pluginB]);
    expect(readPersistedChatPluginTombstonesMock).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      'chat-1',
    );

    // Without the request the read is still skipped, as before.
    readPersistedChatPluginTombstonesMock.mockClear();
    const plain = await resolveEffectiveChatPluginContext(
      selections(),
      TARGET,
      true,
    );
    expect(plain.chatTombstones).toBeUndefined();
    expect(readPersistedChatPluginTombstonesMock).not.toHaveBeenCalled();
  });

  it('exposes the chat tombstones it read so a harness can honor them for its own inherited layers', async () => {
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({ pluginRefs: [pluginA] }),
    });
    readPersistedChatPluginTombstonesMock.mockResolvedValue({
      pluginRefs: [pluginB],
    });

    const context = await resolveEffectiveChatPluginContext(
      selections(),
      TARGET,
      true,
    );

    expect(context.chatTombstones?.pluginRefs).toEqual([pluginB]);
    expect(context.selections.pluginRefs).toEqual([pluginA]);

    const withoutOverlay = await resolveEffectiveChatPluginContext(
      selections(),
      TARGET,
      false,
    );
    expect(withoutOverlay.chatTombstones).toBeUndefined();
  });
});

// An unattended send into an existing chat authorizes what its turn runs
// under the project layer, which is inherited live and so is never part of
// the chat's own saved selection.
describe('resolveBackgroundChatPluginSelections', () => {
  const pluginC = { marketplaceId: 'mkt', pluginName: 'plug-c' };
  const skill = { sourceId: 'custom:local', skillName: 'review' };

  beforeEach(() => {
    jest.clearAllMocks();
    readPreferencesFileMock.mockResolvedValue({
      globalPluginSelections: selections({ pluginRefs: [pluginC] }),
    });
    readProjectPluginDefaultsMock.mockResolvedValue({
      defaultPluginSelections: selections({ pluginRefs: [pluginA, pluginB] }),
    });
    readPersistedChatPluginTombstonesMock.mockResolvedValue(undefined);
    readPersistedChatStampMock.mockReturnValue(true);
  });

  it('adds the project defaults the chat inherits, less the ones it turned off', async () => {
    readPersistedChatPluginTombstonesMock.mockResolvedValue({
      pluginRefs: [pluginB],
    });

    const result = await resolveBackgroundChatPluginSelections(
      selections({ skillRefs: [skill] }),
      TARGET,
    );

    expect(result?.pluginRefs).toEqual([pluginA]);
    expect(result?.skillRefs).toEqual([skill]);
    expect(readPersistedChatPluginTombstonesMock).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      'chat-1',
    );
    expect(readPreferencesFileMock).not.toHaveBeenCalled();
  });

  it('adds no project defaults to a chat that keeps its own selection', async () => {
    readPersistedChatStampMock.mockReturnValue(false);
    const local = selections({ skillRefs: [skill] });

    const result = await resolveBackgroundChatPluginSelections(local, TARGET);

    expect(result?.pluginRefs).toEqual([]);
    expect(result?.skillRefs).toEqual([skill]);
  });

  it('authorizes every project default when the chat state cannot be read', async () => {
    readPersistedChatPluginTombstonesMock.mockRejectedValue(
      new Error('missing tab file'),
    );

    const result = await resolveBackgroundChatPluginSelections(
      undefined,
      TARGET,
    );

    expect(result?.pluginRefs).toEqual([pluginA, pluginB]);
  });

  it('returns the chat selection untouched when the project has no defaults', async () => {
    readProjectPluginDefaultsMock.mockResolvedValue({});
    const local = selections({ skillRefs: [skill] });

    expect(await resolveBackgroundChatPluginSelections(local, TARGET)).toBe(
      local,
    );
    expect(readPersistedChatPluginTombstonesMock).not.toHaveBeenCalled();
  });

  it('adds nothing on a surface that does not inherit defaults', async () => {
    const local = selections({ skillRefs: [skill] });

    expect(
      await resolveBackgroundChatPluginSelections(local, {
        ...TARGET,
        projectId: APP_ADVISOR_PROJECT_ID,
      }),
    ).toBe(local);
    expect(readProjectPluginDefaultsMock).not.toHaveBeenCalled();
  });

  it('reads the cowork workspace defaults for a legacy standalone target', async () => {
    await resolveBackgroundChatPluginSelections(undefined, {
      projectId: 'standalone-chat',
      worktreeId: 'cowork-1',
      chatId: 'chat-1',
    });

    expect(readProjectPluginDefaultsMock).toHaveBeenCalledWith('cowork-1');
  });
});
