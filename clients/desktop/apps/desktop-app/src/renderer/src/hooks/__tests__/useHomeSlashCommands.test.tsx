/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  InvocableInventoryEntry,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import {
  useHomeSlashCommands,
  type UseHomeSlashCommandsResult,
} from '../useHomeSlashCommands';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

interface HookProbe {
  current: UseHomeSlashCommandsResult | null;
}

function HookHarness({ probe }: { probe: HookProbe }): null {
  probe.current = useHomeSlashCommands();
  return null;
}

function makeProject(
  id: string,
  overrides?: Partial<SingleRepoSidebarItem>,
): SingleRepoSidebarItem {
  return {
    id,
    type: 'single-repo',
    name: id,
    repoPath: `/tmp/${id}`,
    color: '#123456',
    order: 0,
    collapsed: false,
    worktrees: [],
    scripts: {},
    effectiveScripts: {},
    hooks: {},
    effectiveHooks: {},
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<InvocableInventoryEntry> & { name: string },
): InvocableInventoryEntry {
  const { name } = overrides;
  return {
    id: overrides.id ?? `id:${name}`,
    provider: overrides.provider ?? 'claude',
    kind: overrides.kind ?? 'skill',
    name,
    displayName: overrides.displayName ?? `/${name}`,
    description: overrides.description ?? `${name} description`,
    insertText: overrides.insertText ?? `/${name} `,
    invocationKey: overrides.invocationKey ?? `claude:${name}`,
    enableRef:
      overrides.enableRef ??
      ({ kind: 'skill', sourceId: 'src-1', skillName: name } as const),
    ...overrides,
  };
}

describe('useHomeSlashCommands', () => {
  let container: HTMLDivElement;
  let root: Root;
  // Held as plain variables (rather than read back off `window.*` in
  // assertions) so Jest mock-call assertions don't trip
  // `@typescript-eslint/unbound-method` on a bare `object.method` reference.
  let mockList: jest.Mock;
  let mockResolveSelection: jest.Mock;

  beforeEach(() => {
    initClaudeModels([{ id: 'claude-sonnet-4-5', label: 'Sonnet 5' }]);
    initCodexModels([{ id: 'gpt-6-sol', label: 'GPT 6 Sol' }]);
    useHomeComposerStore.getState().reset();
    useProjectsStore.setState({ projects: [] });
    useChatStore.setState({ modelDefaults: null });

    mockList = jest.fn(() =>
      Promise.resolve({
        success: true,
        data: { entries: [], stale: false, rebuilding: false },
      }),
    );
    mockResolveSelection = jest.fn();
    Object.defineProperty(window, 'invocableInventory', {
      configurable: true,
      value: {
        list: mockList,
        refresh: jest.fn(() =>
          Promise.resolve({
            success: true,
            data: { entries: [], stale: false, rebuilding: false },
          }),
        ),
        resolveSelection: mockResolveSelection,
        onChanged: jest.fn((): (() => void) => () => undefined),
      },
    });
    Object.defineProperty(window, 'plugins', {
      configurable: true,
      value: {
        prepareCodexCompatibilityPlugin: jest.fn(),
      },
    });
    Object.defineProperty(window, 'collections', {
      configurable: true,
      value: {
        loadCollection: jest.fn(() => Promise.resolve(null)),
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("lists Cursor inventory rows and enables them, ignoring another provider's cached discovery", async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const entry = makeEntry({
      name: 'review',
      provider: 'cursor',
      insertText: '/review ',
      invocationKey: '/review',
    });
    mockList.mockResolvedValue({
      success: true,
      data: { entries: [entry], stale: false, rebuilding: false },
    });
    mockResolveSelection.mockResolvedValue({
      success: true,
      data: { insertText: '/review ', invocationKey: '/review' },
    });
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      model: 'cursor-default',
      // Left over from a Claude draft: Cursor has no provider discovery, so
      // a cached Claude command must not show up as a Cursor command.
      discovery: {
        slashCommands: [
          { name: 'cached-claude-command', description: 'cached' },
        ],
        mcpServers: [],
        discoveredAt: new Date().toISOString(),
      },
    });
    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
    });
    expect(mockList).toHaveBeenCalledWith({ providerType: 'cursor' });
    expect(probe.current?.isCodex).toBe(false);
    expect(probe.current?.commands.map((command) => command.name)).toEqual([
      'review',
    ]);
    const insert = jest.fn();
    await act(async () => {
      await probe.current?.runInventoryCommand(entry, insert);
    });
    expect(mockResolveSelection).toHaveBeenCalledWith(
      expect.objectContaining({ providerType: 'cursor', entry }),
    );
    expect(insert).toHaveBeenCalledWith('/review ');
    expect(useHomeComposerStore.getState().pluginSelections?.skillRefs).toEqual(
      [{ sourceId: 'src-1', skillName: 'review' }],
    );
  });

  it("inserts an inherited row's resolved id without writing the draft's plugin selections", async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    const entry = makeEntry({
      id: 'cursor:inherited_skill:claude:review',
      name: 'review',
      provider: 'cursor',
      kind: 'inherited_skill',
      insertText: '/review ',
      invocationKey: '/review',
      enableRef: { kind: 'none' },
      sourceLabel: '~/.claude/skills',
    });
    mockList.mockResolvedValue({
      success: true,
      data: { entries: [entry], stale: false, rebuilding: false },
    });
    mockResolveSelection.mockResolvedValue({
      success: true,
      data: { insertText: '/review-1 ', invocationKey: '/review-1' },
    });
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      model: 'cursor-default',
    });
    const before = useHomeComposerStore.getState().pluginSelections;
    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
    });
    const insert = jest.fn();
    await act(async () => {
      await probe.current?.runInventoryCommand(entry, insert);
    });
    expect(insert).toHaveBeenCalledWith('/review-1 ');
    // Nothing was enabled, so the draft's selections are untouched.
    expect(useHomeComposerStore.getState().pluginSelections).toBe(before);
  });

  it('reloads the inventory on demand, so a menu opening sees entries added on disk', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      model: 'cursor-default',
    });
    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
    });
    expect(mockList).toHaveBeenCalledTimes(1);

    // The composer menu opened: Home asks for the cache again, which lets
    // the backend re-check the inherited Cursor folders.
    await act(async () => {
      await probe.current?.reloadInventory();
    });

    expect(mockList).toHaveBeenCalledTimes(2);
    expect(mockList).toHaveBeenLastCalledWith({ providerType: 'cursor' });
  });

  it('does not insert a pending inventory command after switching to Cursor', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      model: 'claude-sonnet-4-5',
    });
    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
    });
    let resolveSelection: (value: unknown) => void = () => {
      throw new Error('Not pending');
    };
    mockResolveSelection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve;
        }),
    );
    const insert = jest.fn();
    const pending = probe.current?.runInventoryCommand(
      makeEntry({ name: 'pending' }),
      insert,
    );
    await act(async () => {
      useHomeComposerStore.getState().setModel('cursor-default');
      resolveSelection({ success: true, data: { insertText: '/pending ' } });
      await pending;
    });
    expect(insert).not.toHaveBeenCalled();
    expect(
      useHomeComposerStore.getState().pluginSelections?.skillRefs ?? [],
    ).toEqual([]);
  });

  it('keeps each pending command bound to its own insertion callback', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      model: 'claude-sonnet-4-5',
    });
    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
    });
    let resolveSelection: (value: unknown) => void = () => {
      throw new Error('Not pending');
    };
    mockResolveSelection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSelection = resolve;
        }),
    );
    const firstInsert = jest.fn();
    const secondInsert = jest.fn();
    const first = probe.current?.runInventoryCommand(
      makeEntry({ name: 'first' }),
      firstInsert,
    );
    const second = probe.current?.runInventoryCommand(
      makeEntry({ name: 'second' }),
      secondInsert,
    );
    expect(await second).toBe('resolve-failed');
    await act(async () => {
      resolveSelection({ success: true, data: { insertText: '/first ' } });
      await first;
    });
    expect(firstInsert).toHaveBeenCalledWith('/first ');
    expect(secondInsert).not.toHaveBeenCalled();
  });

  it.each(['claude', 'codex'] as const)(
    'keeps indexed %s skills usable while a new target is discovering',
    async (provider) => {
      const enabled = makeEntry({ name: 'enabled', provider });
      const available = makeEntry({ name: 'available', provider });
      mockList.mockResolvedValue({
        success: true,
        data: {
          entries: [enabled, available],
          stale: false,
          rebuilding: false,
        },
      });
      useProjectsStore.setState({ projects: [makeProject('proj-a')] });
      useHomeComposerStore.setState({
        workspaceId: 'proj-a',
        model: provider === 'codex' ? 'gpt-6-sol' : 'claude-sonnet-4-5',
        discoveryLoading: true,
        pluginSelections: {
          collectionIds: [],
          pluginRefs: [],
          mcpServerRefs: [],
          skillRefs: [{ sourceId: 'src-1', skillName: 'enabled' }],
        },
      });
      const probe: HookProbe = { current: null };
      await act(async () => {
        root.render(<HookHarness probe={probe} />);
        await Promise.resolve();
      });
      expect(probe.current?.isRefreshing).toBe(true);
      expect(probe.current?.commands.map((command) => command.name)).toEqual([
        'enabled',
        'available',
      ]);
      act(() => {
        useHomeComposerStore.setState({
          discoveryLoading: false,
          discovery: {
            slashCommands: [
              { name: 'enabled', description: 'Provider result' },
            ],
            mcpServers: [],
            discoveredAt: new Date().toISOString(),
          },
        });
      });
      expect(probe.current?.commands).toEqual([
        { name: 'enabled', description: 'Provider result' },
        expect.objectContaining({ name: 'available', section: 'available' }),
      ]);
    },
  );

  it('Task F2 carry-forward fix: merges available rows for the EFFECTIVE (settings-default) provider on an untouched draft', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useChatStore.setState({
      modelDefaults: {
        chatProvider: 'claude',
        chatModelByProvider: {
          claude: { model: 'claude-sonnet-4-5', thinkingLevel: 'medium' },
          codex: null,
          ollama: null,
        },
        worktreeProvider: 'codex',
        worktreeModelByProvider: {
          claude: null,
          codex: { model: 'gpt-6-sol', thinkingLevel: 'high' },
          ollama: null,
        },
      },
    });
    useHomeComposerStore.setState({ workspaceId: 'proj-a', model: undefined });

    const codexEntry = makeEntry({ name: 'codex-only', provider: 'codex' });
    const claudeEntry = makeEntry({ name: 'claude-only', provider: 'claude' });
    mockList.mockImplementation(() =>
      Promise.resolve({
        success: true,
        data: {
          entries: [codexEntry, claudeEntry],
          stale: false,
          rebuilding: false,
        },
      }),
    );

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(probe.current?.isCodex).toBe(true);
    expect(mockList).toHaveBeenCalledWith({
      providerType: 'codex',
    });
    const names = probe.current?.commands.map((cmd) => cmd.name) ?? [];
    expect(names).toContain('codex-only');
    expect(names).not.toContain('claude-only');
  });

  it('keeps workspace-default managed skills and plugins in the available list', async () => {
    const managedSkill = makeEntry({
      name: 'managed-skill',
      enableRef: {
        kind: 'skill',
        sourceId: 'canopy',
        skillName: 'managed-skill',
      },
    });
    const managedPlugin = makeEntry({
      name: 'managed-plugin-command',
      kind: 'plugin_command',
      enableRef: {
        kind: 'plugin',
        marketplaceId: 'canopy-chat-plugins',
        pluginName: 'managed-plugin',
      },
    });
    useProjectsStore.setState({
      projects: [
        makeProject('proj-a', {
          defaultPluginSelections: {
            collectionIds: [],
            skillRefs: [{ sourceId: 'canopy', skillName: 'managed-skill' }],
            pluginRefs: [
              {
                marketplaceId: 'canopy-chat-plugins',
                pluginName: 'managed-plugin',
              },
            ],
          },
        }),
      ],
    });
    useHomeComposerStore.getState().selectWorkspace('proj-a');
    mockList.mockImplementation(() =>
      Promise.resolve({
        success: true,
        data: {
          entries: [managedSkill, managedPlugin],
          stale: false,
          rebuilding: false,
        },
      }),
    );

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(probe.current?.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'managed-skill',
          section: 'available',
        }),
        expect.objectContaining({
          name: 'managed-plugin-command',
          section: 'available',
        }),
      ]),
    );
  });

  it('F2 review carry-forward: drops "available to enable" rows from the merged list in pipeline mode but keeps discovered rows', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useHomeComposerStore.setState({
      workspaceId: 'proj-a',
      mode: 'pipeline',
      discovery: {
        slashCommands: [
          {
            name: 'discovered-cmd',
            description: 'already available',
            section: 'discovered',
          },
        ],
        mcpServers: [],
        discoveredAt: new Date().toISOString(),
      },
    });

    const availableEntry = makeEntry({ name: 'available-cmd' });
    mockList.mockImplementation(() =>
      Promise.resolve({
        success: true,
        data: {
          entries: [availableEntry],
          stale: false,
          rebuilding: false,
        },
      }),
    );

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
      await Promise.resolve();
    });

    const names = probe.current?.commands.map((cmd) => cmd.name) ?? [];
    expect(names).toContain('discovered-cmd');
    expect(names).not.toContain('available-cmd');
  });

  it('runInventoryCommand enables the selection (via setPluginSelections) and inserts the resolved text on success', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useHomeComposerStore.getState().selectWorkspace('proj-a');

    mockResolveSelection.mockResolvedValue({
      success: true,
      data: { insertText: '/resolved-command ', invocationKey: '/resolved' },
    });

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
    });

    const entry = makeEntry({
      name: 'say-hi',
      enableRef: { kind: 'skill', sourceId: 'src-1', skillName: 'say-hi' },
    });
    const insertResolvedText = jest.fn();

    await act(async () => {
      const status = await probe.current?.runInventoryCommand(
        entry,
        insertResolvedText,
      );
      expect(status).toBe('inserted');
    });

    expect(insertResolvedText).toHaveBeenCalledWith('/resolved-command ');
    expect(useHomeComposerStore.getState().pluginSelections?.skillRefs).toEqual(
      [{ sourceId: 'src-1', skillName: 'say-hi' }],
    );
    // Task F1 blend: enabling via the inventory flow must track the delta as
    // a manual override the same way the plugins-modal save handler does.
    expect(
      useHomeComposerStore.getState().manualPluginSelections.skillRefs,
    ).toEqual([{ sourceId: 'src-1', skillName: 'say-hi' }]);
  });

  it('runInventoryCommand surfaces the shared enable-error copy via setSendError and never inserts on a resolve failure', async () => {
    useProjectsStore.setState({ projects: [makeProject('proj-a')] });
    useHomeComposerStore.getState().selectWorkspace('proj-a');

    mockResolveSelection.mockResolvedValue({ success: false });

    const probe: HookProbe = { current: null };
    await act(async () => {
      root.render(<HookHarness probe={probe} />);
      await Promise.resolve();
    });

    const entry = makeEntry({ name: 'stale-row' });
    const insertResolvedText = jest.fn();

    await act(async () => {
      const status = await probe.current?.runInventoryCommand(
        entry,
        insertResolvedText,
      );
      expect(status).toBe('resolve-failed');
    });

    expect(insertResolvedText).not.toHaveBeenCalled();
    expect(useHomeComposerStore.getState().sendError).toBe(
      'Could not enable that item. Try again or use the Plugins picker.',
    );
  });
});
