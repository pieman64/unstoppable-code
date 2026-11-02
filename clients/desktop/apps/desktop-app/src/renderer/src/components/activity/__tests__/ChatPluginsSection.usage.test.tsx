/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import {
  chatStoreRenderView,
  useChatStore,
  type ChatTab,
} from '@/stores/chatStore';
import type { ChatMessage } from '@/stores/chat/types';
import { createEmptyTab } from '@/stores/chat/tab-utils';
import { useGlobalPluginDefaultsStore } from '@/stores/globalPluginDefaultsStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { resetChatShareDataForTests } from '@/hooks/useChatShareData';
import { useShareRequestStore } from '@/stores/shareRequestStore';
import {
  ChatPluginsSection,
  useChatPluginsHasContent,
} from '../ChatPluginsSection';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const ENTRIES: InvocableInventoryEntry[] = [
  {
    id: 'claude-notes',
    provider: 'claude',
    kind: 'skill',
    name: 'release-notes',
    displayName: '/release-notes',
    description: 'Writes release notes',
    insertText: '/release-notes ',
    invocationKey: '/release-notes',
    enableRef: {
      kind: 'skill',
      sourceId: 'custom:app',
      skillName: 'release-notes',
    },
  },
  {
    id: 'claude-external',
    provider: 'claude',
    kind: 'skill',
    name: 'external',
    displayName: '/external',
    description: '',
    insertText: '/external ',
    invocationKey: '/external',
    enableRef: {
      kind: 'skill',
      sourceId: 'github:acme/skills',
      skillName: 'external',
    },
  },
  {
    id: 'claude-review',
    provider: 'claude',
    kind: 'plugin_command',
    name: 'review',
    displayName: '/release-tools:review',
    description: '',
    insertText: '/release-tools:review ',
    invocationKey: '/release-tools:review',
    enableRef: {
      kind: 'plugin',
      marketplaceId: 'acme-market',
      pluginName: 'release-tools',
    },
  },
];

function userMessage(id: string, text: string): ChatMessage {
  return { id, role: 'user', blocks: [{ type: 'text', text }] } as ChatMessage;
}

function setChats(
  tabs: Array<Partial<ChatTab> & { id: string }>,
  activeTabId: string,
): void {
  useChatStore.setState({
    worktreeDefaultPlugins: {},
    worktreeChats: {
      'project/worktree': {
        activeTabId,
        tabs: tabs.map((tab) => ({ ...createEmptyTab({}), ...tab })),
      },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
  });
}

describe('ChatPluginsSection: Used in this chat', () => {
  let container: HTMLElement;
  let root: Root;
  let hasContent = false;
  let unregisterHost: () => void;
  let detachedFrame: HTMLIFrameElement | undefined;
  const listInventory = jest.fn();
  const loadSkills: jest.MockedFunction<typeof window.skills.loadSkills> =
    jest.fn();
  const loadMarketplaces: jest.MockedFunction<
    typeof window.plugins.loadMarketplacesCacheOnly
  > = jest.fn();
  const listShared = jest.fn();

  function Probe(): null {
    hasContent = useChatPluginsHasContent('project', 'worktree');
    return null;
  }

  async function render(): Promise<void> {
    act(() => {
      root.render(
        <>
          <Probe />
          <ChatPluginsSection projectId="project" worktreeId="worktree" />
        </>,
      );
    });
    await flush();
  }

  const usedRows = (): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="chat-used-invocable-row"]',
      ),
    );
  const rowFor = (name: string): HTMLElement | undefined =>
    usedRows().find((row) => row.textContent?.includes(name));

  beforeEach(() => {
    resetChatShareDataForTests();
    listInventory.mockReset().mockResolvedValue({
      success: true,
      data: { entries: ENTRIES, stale: false, rebuilding: false },
    });
    loadSkills.mockReset().mockResolvedValue({
      success: true,
      data: [
        {
          name: 'release-notes',
          sourceId: 'custom:app',
          description: '',
          source: 'custom',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          updateAvailable: false,
          custom: true,
          remote: {
            remoteId: 'remote-1',
            contentHash: 'hash',
            shareScope: 'team',
            sharedAt: '2026-01-01T00:00:00.000Z',
            ownerName: 'Growth',
          },
        },
        {
          name: 'external',
          sourceId: 'github:acme/skills',
          description: '',
          source: 'github',
          installedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          updateAvailable: false,
        },
      ],
    });
    loadMarketplaces.mockReset().mockResolvedValue({
      success: true,
      data: {
        version: 2,
        lastRefreshed: '2026-01-01T00:00:00.000Z',
        marketplaces: [
          {
            id: 'acme-market',
            name: 'Acme',
            sourceType: 'github',
            sourceUrl: 'https://github.com/acme/plugins',
            installLocation: '',
            pluginCount: 1,
            providerStatus: {
              claude: {
                provider: 'claude',
                state: 'valid',
                accepted: true,
                pluginCount: 1,
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
              codex: {
                provider: 'codex',
                state: 'invalid',
                accepted: false,
                pluginCount: 0,
                lastCheckedAt: '2026-01-01T00:00:00.000Z',
              },
            },
            validProviders: ['claude'],
            plugins: [
              {
                name: 'release-tools',
                displayName: 'Release tools',
                marketplaceId: 'acme-market',
                sourcePath: 'plugins/release-tools',
                providerSupport: { claude: 'native', codex: 'none' },
                facets: {
                  claude: {
                    provider: 'claude',
                    mode: 'native',
                    name: 'release-tools',
                    installLocation: '/plugins/release-tools',
                    sourcePath: 'plugins/release-tools',
                  },
                },
              },
            ],
          },
        ],
      },
    });
    listShared
      .mockReset()
      .mockResolvedValue({ success: true, data: { data: [] } });
    Object.assign(window, {
      invocableInventory: {
        list: listInventory,
        onChanged: (): (() => void) => (): void => {},
      },
      skills: { loadSkills },
      plugins: { loadMarketplacesCacheOnly: loadMarketplaces, listShared },
      api: {
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({
          hasApiKey: true,
          capabilities: [],
          account: { id: 'me' },
        }),
      },
    });
    useProjectsStore.setState({
      projects: [
        {
          type: 'single-repo',
          id: 'project',
          name: 'Project',
          repoPath: '/workspace',
          color: '#000000',
          collapsed: false,
          order: 0,
          worktrees: [],
        },
      ],
    });
    useGlobalPluginDefaultsStore.setState({
      hydrated: true,
      selections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
    });
    useShareRequestStore.setState({ hostCount: 0, request: null });
    unregisterHost = useShareRequestStore.getState().registerHost();
    hasContent = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    detachedFrame?.remove();
    detachedFrame = undefined;
    unregisterHost();
    resetChatShareDataForTests();
  });

  it('lists every used skill and command, shareable or not, in first-use order', async () => {
    setChats(
      [
        {
          id: 'chat',
          messages: [
            userMessage(
              'm1',
              'Run /release-tools:review then /external and /release-notes',
            ),
          ],
        },
      ],
      'chat',
    );
    await render();

    expect(container.textContent).toContain('Used in this chat');
    expect(usedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('/release-tools:review'),
      expect.stringContaining('/external'),
      expect.stringContaining('/release-notes'),
    ]);
    expect(hasContent).toBe(true);

    // Plugin-owned: names its plugin and shares the whole plugin.
    const pluginRow = rowFor('/release-tools:review');
    expect(
      pluginRow?.querySelector('[data-testid="chat-used-invocable-plugin"]')
        ?.textContent,
    ).toBe('From Release tools');
    const pluginShare = pluginRow?.querySelector<HTMLButtonElement>(
      '[data-testid="chat-used-invocable-share"]',
    );
    expect(pluginShare?.getAttribute('aria-label')).toBe('Share Release tools');
    act(() => pluginShare?.click());
    expect(useShareRequestStore.getState().request).toMatchObject({
      target: {
        kind: 'plugin',
        marketplaceId: 'acme-market',
        pluginName: 'release-tools',
      },
      source: 'activity_panel',
    });
    expect(useShareRequestStore.getState().request?.ownerDocument).toBe(
      document,
    );

    // Unshareable: the row stays, without a Share action.
    const externalRow = rowFor('/external');
    expect(externalRow).toBeDefined();
    expect(
      externalRow?.querySelector('[data-testid="chat-used-invocable-share"]'),
    ).toBeNull();

    // Standalone and already shared: audience label plus its own Share.
    const skillRow = rowFor('/release-notes');
    expect(
      skillRow
        ?.querySelector('[data-testid="chat-used-invocable-name"]')
        ?.parentElement?.getAttribute('title'),
    ).toBe('Writes release notes');
    expect(
      skillRow?.querySelector('[data-testid="chat-used-invocable-audience"]')
        ?.textContent,
    ).toBe('Team: Growth');
    act(() =>
      skillRow
        ?.querySelector<HTMLButtonElement>(
          '[data-testid="chat-used-invocable-share"]',
        )
        ?.click(),
    );
    expect(useShareRequestStore.getState().request?.target).toEqual({
      kind: 'skill',
      sourceId: 'custom:app',
      name: 'release-notes',
    });
  });

  it('has no content and loads no share data for a chat that used nothing', async () => {
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', 'No skills here.')] }],
      'chat',
    );
    await render();

    expect(usedRows()).toEqual([]);
    expect(container.textContent).not.toContain('Used in this chat');
    expect(hasContent).toBe(false);
    expect(loadSkills).not.toHaveBeenCalled();
    expect(listShared).not.toHaveBeenCalled();
  });

  it('separates the invocation and action from optional attribution and audience', async () => {
    setChats(
      [
        {
          id: 'chat',
          messages: [
            userMessage('m1', '/release-tools:review /release-notes /external'),
          ],
        },
      ],
      'chat',
    );
    await render();
    const pluginRow = rowFor('/release-tools:review');
    const metadata = pluginRow?.querySelector(
      '[data-testid="chat-used-invocable-metadata"]',
    );
    expect(metadata).not.toBeNull();
    expect(metadata?.textContent).toBe('From Release tools');
    expect(metadata?.querySelector('button')).toBeNull();
    expect(
      pluginRow?.querySelector('[data-testid="chat-used-invocable-name"]')
        ?.textContent,
    ).toBe('/release-tools:review');
    expect(
      rowFor('/release-notes')?.querySelector(
        '[data-testid="chat-used-invocable-metadata"]',
      )?.textContent,
    ).toBe('Team: Growth');
    expect(
      rowFor('/external')?.querySelector(
        '[data-testid="chat-used-invocable-metadata"]',
      ),
    ).toBeNull();
  });

  it.each([
    ['organization', null, 'Organization'],
    ['public', null, 'Public'],
    ['team', 'Growth', 'Team: Growth'],
    ['team', null, 'Team'],
    ['team', '   ', 'Team'],
  ] as const)(
    'renders the existing %s audience wording in metadata',
    async (
      audience: 'organization' | 'public' | 'team',
      teamName: string | null,
      label: string,
    ): Promise<void> => {
      const response = await loadSkills();
      if (!response.data) throw new Error('Missing fixture skills');
      const skill = response.data[0];
      if (!skill?.remote) throw new Error('Missing fixture remote');
      const shareScope: NonNullable<typeof skill.remote.shareScope> =
        audience === 'public' ? 'private' : audience;
      const skillWithAudience = {
        ...skill,
        remote: {
          ...skill.remote,
          shareScope,
          ownerName: teamName ?? undefined,
          ...(audience === 'public'
            ? { publicLink: 'https://example.test/skills/public-fixture' }
            : {}),
        },
      };
      loadSkills.mockResolvedValue({
        ...response,
        data: [skillWithAudience, ...response.data.slice(1)],
      });
      setChats(
        [{ id: 'chat', messages: [userMessage('m1', '/release-notes')] }],
        'chat',
      );
      await render();
      const metadata = rowFor('/release-notes')?.querySelector(
        '[data-testid="chat-used-invocable-metadata"]',
      );
      const text = metadata?.querySelector('[data-share-audience]');
      expect(text?.textContent).toBe(label);
      expect(text?.getAttribute('title')).toBe(label);
      expect(text?.getAttribute('data-share-audience')).toBe(audience);
      expect(
        metadata?.querySelector('[data-testid="chat-used-invocable-plugin"]'),
      ).toBeNull();
    },
  );

  it('shows both plugin attribution and audience and retains complete long strings', async () => {
    const name =
      'Release tools for engineering readiness and deployment coordination';
    const teamName =
      'Release engineering and deployment readiness across all product teams';
    const marketplace = await loadMarketplaces();
    if (!marketplace.data) throw new Error('Missing fixture marketplaces');
    marketplace.data.marketplaces[0].plugins[0].displayName = name;
    loadMarketplaces.mockResolvedValue(marketplace);
    const shared: SharedPluginSummary = {
      externalId: 'plugin-share',
      name,
      description: null,
      refKey: 'claude_plugin:github:acme/plugins:release-tools',
      ref: {
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'acme/plugins' },
        plugin_name: 'release-tools',
      },
      marketplaceOrigin: 'acme-market',
      owner: {
        type: 'team',
        id: 'team',
        name: teamName,
        organization: { id: 'org', name: 'Organization' },
      },
      createdBy: { id: 'me', name: 'Me' },
      shareScope: 'team',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    listShared.mockResolvedValue({ success: true, data: { data: [shared] } });
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-tools:review')] }],
      'chat',
    );
    await render();
    const row = rowFor('/release-tools:review');
    const metadata = row?.querySelector(
      '[data-testid="chat-used-invocable-metadata"]',
    );
    expect(
      metadata
        ?.querySelector('[data-testid="chat-used-invocable-plugin"]')
        ?.getAttribute('title'),
    ).toBe(`From ${name}`);
    expect(
      metadata?.querySelector('[data-share-audience]')?.getAttribute('title'),
    ).toBe(`Team: ${teamName}`);
    expect(row?.querySelector('button')?.getAttribute('aria-label')).toBe(
      `Share ${name}`,
    );
    const invocation = row?.querySelector(
      '[data-testid="chat-used-invocable-name"]',
    );
    expect(invocation?.getAttribute('title')).toBe('/release-tools:review');
    expect(invocation?.parentElement?.getAttribute('title')).toBeNull();
    expect(
      Array.from(row?.querySelectorAll('[data-testid]') ?? []).map((element) =>
        element.getAttribute('data-testid'),
      ),
    ).toEqual([
      'chat-used-invocable-name',
      'chat-used-invocable-share',
      'chat-used-invocable-metadata',
      'chat-used-invocable-plugin',
      'chat-used-invocable-audience',
    ]);
    listShared.mockResolvedValue({ success: true, data: { data: [] } });
    act(() => {
      window.dispatchEvent(new Event('canopy:shared-plugins-changed'));
    });
    await flush();
    expect(
      row?.querySelector('[data-testid="chat-used-invocable-audience"]'),
    ).toBeNull();
    expect(metadata?.textContent).toBe(`From ${name}`);
  });

  it('adds audience when metadata settles and removes the empty line after sign-out', async () => {
    let resolveAccount:
      | ((value: {
          hasApiKey: boolean;
          capabilities: string[];
          account: { id: string };
        }) => void)
      | undefined;
    const pendingAccount = new Promise<{
      hasApiKey: boolean;
      capabilities: string[];
      account: { id: string };
    }>((resolve) => {
      resolveAccount = resolve;
    });
    window.api.loadCanopyCloudAccount = jest
      .fn()
      .mockReturnValue(pendingAccount);
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-notes')] }],
      'chat',
    );
    await render();
    expect(
      rowFor('/release-notes')?.querySelector(
        '[data-testid="chat-used-invocable-metadata"]',
      ),
    ).toBeNull();
    expect(rowFor('/release-notes')?.querySelector('button')).not.toBeNull();
    act(() =>
      resolveAccount?.({
        hasApiKey: true,
        capabilities: [],
        account: { id: 'me' },
      }),
    );
    await flush();
    expect(
      rowFor('/release-notes')?.querySelector(
        '[data-testid="chat-used-invocable-metadata"]',
      )?.textContent,
    ).toBe('Team: Growth');
    const response = await loadSkills();
    if (!response.data) throw new Error('Missing fixture skills');
    delete response.data[0].remote;
    loadSkills.mockResolvedValue(response);
    window.api.loadCanopyCloudAccount = jest
      .fn()
      .mockResolvedValue({ hasApiKey: false, capabilities: [], account: null });
    act(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    await flush();
    expect(
      rowFor('/release-notes')?.querySelector(
        '[data-testid="chat-used-invocable-metadata"]',
      ),
    ).toBeNull();
    expect(rowFor('/release-notes')?.querySelector('button')).not.toBeNull();
  });

  it('omits standalone metadata when confirmed unshared', async () => {
    const response = await loadSkills();
    if (!response.data) throw new Error('Missing fixture skills');
    delete response.data[0].remote;
    loadSkills.mockResolvedValue(response);
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-notes')] }],
      'chat',
    );
    await render();
    expect(
      rowFor('/release-notes')?.querySelector(
        '[data-testid="chat-used-invocable-metadata"]',
      ),
    ).toBeNull();
  });

  it('removes standalone metadata when a skill update confirms it is no longer shared', async () => {
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-notes')] }],
      'chat',
    );
    await render();
    const row = rowFor('/release-notes');
    const action = row?.querySelector('button');
    expect(
      row?.querySelector('[data-testid="chat-used-invocable-metadata"]')
        ?.textContent,
    ).toBe('Team: Growth');
    const response = await loadSkills();
    if (!response.data) throw new Error('Missing fixture skills');
    delete response.data[0].remote;
    loadSkills.mockResolvedValue(response);
    act(() => {
      window.dispatchEvent(new Event('canopy:skills-changed'));
    });
    await flush();
    expect(
      row?.querySelector('[data-testid="chat-used-invocable-metadata"]'),
    ).toBeNull();
    expect(row?.querySelector('button')).toBe(action);
  });

  it('drops the previous creator audience immediately on account replacement', async () => {
    const shared: SharedPluginSummary = {
      externalId: 'plugin-share',
      name: 'Release tools',
      description: null,
      refKey: 'claude_plugin:github:acme/plugins:release-tools',
      ref: {
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'acme/plugins' },
        plugin_name: 'release-tools',
      },
      marketplaceOrigin: 'acme-market',
      owner: { type: 'organization', id: 'org', name: 'Organization' },
      createdBy: { id: 'me', name: 'Me' },
      shareScope: 'organization',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    listShared.mockResolvedValue({ success: true, data: { data: [shared] } });
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-tools:review')] }],
      'chat',
    );
    await render();
    const row = rowFor('/release-tools:review');
    const action = row?.querySelector('button');
    expect(
      row?.querySelector('[data-testid="chat-used-invocable-audience"]')
        ?.textContent,
    ).toBe('Organization');
    window.api.loadCanopyCloudAccount = jest.fn().mockResolvedValue({
      hasApiKey: true,
      capabilities: [],
      account: { id: 'someone-else' },
    });
    act(() => {
      window.dispatchEvent(new Event('canopy:cloud-account-changed'));
    });
    expect(
      row?.querySelector('[data-testid="chat-used-invocable-audience"]'),
    ).toBeNull();
    await flush();
    // The resource is still visible to the new account, but its creator is
    // different. Its old audience must not return after the load settles.
    expect(
      row?.querySelector('[data-testid="chat-used-invocable-metadata"]')
        ?.textContent,
    ).toBe('From Release tools');
    expect(row?.querySelector('button')).toBe(action);
  });

  it('dispatches from the owning document when rendered in a detached window', async () => {
    act(() => root.unmount());
    container.remove();
    detachedFrame = document.createElement('iframe');
    document.body.appendChild(detachedFrame);
    const ownerDocument = detachedFrame.contentDocument;
    if (!ownerDocument) throw new Error('Missing detached document');
    container = ownerDocument.createElement('div');
    ownerDocument.body.appendChild(container);
    root = createRoot(container);
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-tools:review')] }],
      'chat',
    );
    await render();
    const action = rowFor('/release-tools:review')?.querySelector('button');
    expect(action?.getAttribute('aria-label')).toBe('Share Release tools');
    act(() => action?.click());
    expect(useShareRequestStore.getState().request).toMatchObject({
      target: {
        kind: 'plugin',
        marketplaceId: 'acme-market',
        pluginName: 'release-tools',
      },
      source: 'activity_panel',
    });
    expect(useShareRequestStore.getState().request?.ownerDocument).toBe(
      ownerDocument,
    );
  });

  it('does not invent an audience for a curated shared plugin', async () => {
    const response = await loadMarketplaces();
    if (!response.data) throw new Error('Missing fixture marketplaces');
    response.data.marketplaces[0].id = 'curated/cloud';
    loadMarketplaces.mockResolvedValue(response);
    listInventory.mockResolvedValue({
      success: true,
      data: {
        entries: ENTRIES.map((entry) =>
          entry.enableRef.kind === 'plugin'
            ? {
                ...entry,
                enableRef: {
                  ...entry.enableRef,
                  marketplaceId: 'curated/cloud',
                },
              }
            : entry,
        ),
        stale: false,
        rebuilding: false,
      },
    });
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-tools:review')] }],
      'chat',
    );
    await render();
    const row = rowFor('/release-tools:review');
    expect(
      row?.querySelector('[data-testid="chat-used-invocable-metadata"]')
        ?.textContent,
    ).toBe('From Release tools');
    expect(
      row?.querySelector('[data-testid="chat-used-invocable-audience"]'),
    ).toBeNull();
    expect(row?.querySelector('button')).not.toBeNull();
  });

  it.each([
    'rejected audience',
    'signed out',
    'unresolved plugin',
    'ineligible plugin',
  ] as const)(
    'preserves attribution and share eligibility with %s',
    async (state) => {
      if (state === 'rejected audience')
        listShared.mockRejectedValue(new Error('Offline'));
      if (state === 'signed out')
        window.api.loadCanopyCloudAccount = jest.fn().mockResolvedValue({
          hasApiKey: false,
          capabilities: [],
          account: null,
        });
      if (state === 'unresolved plugin')
        loadMarketplaces.mockRejectedValue(new Error('Offline'));
      if (state === 'ineligible plugin')
        loadMarketplaces.mockResolvedValue({
          success: true,
          data: {
            version: 2,
            lastRefreshed: '2026-01-01T00:00:00.000Z',
            marketplaces: [],
          },
        });
      setChats(
        [
          {
            id: 'chat',
            messages: [userMessage('m1', '/release-tools:review')],
          },
        ],
        'chat',
      );
      await render();
      const row = rowFor('/release-tools:review');
      expect(
        row?.querySelector('[data-testid="chat-used-invocable-metadata"]')
          ?.textContent,
      ).toBe(
        state.endsWith('plugin') ? 'From release-tools' : 'From Release tools',
      );
      expect(
        row?.querySelector('[data-testid="chat-used-invocable-audience"]'),
      ).toBeNull();
      expect(Boolean(row?.querySelector('button'))).toBe(
        !state.endsWith('plugin'),
      );
    },
  );

  it('keeps the last settled rows while streaming and recomputes when it ends', async () => {
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-notes')] }],
      'chat',
    );
    await render();
    expect(usedRows()).toHaveLength(1);

    const streamed = [
      userMessage('m1', '/release-notes'),
      userMessage('m2', '/external'),
    ];
    act(() =>
      setChats(
        [{ id: 'chat', status: 'streaming', messages: streamed }],
        'chat',
      ),
    );
    await flush();
    expect(usedRows()).toHaveLength(1);

    act(() =>
      setChats([{ id: 'chat', status: 'idle', messages: streamed }], 'chat'),
    );
    await flush();
    expect(usedRows()).toHaveLength(2);
  });

  it("never shows another chat's rows after a switch, even mid-stream", async () => {
    const tabs = [
      { id: 'chat', messages: [userMessage('m1', '/release-notes')] },
      {
        id: 'other',
        status: 'streaming' as const,
        messages: [userMessage('m2', '/external')],
      },
    ];
    setChats(tabs, 'chat');
    await render();
    expect(usedRows()).toHaveLength(1);

    act(() => setChats(tabs, 'other'));
    await flush();
    // The streaming chat has no settled answer yet; nothing is carried over.
    expect(usedRows()).toEqual([]);
    expect(hasContent).toBe(false);

    act(() =>
      setChats([tabs[0], { ...tabs[1], status: 'idle' as const }], 'other'),
    );
    await flush();
    expect(usedRows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('/external'),
    ]);
  });

  it('renders, without throwing, while React still shows a chat the store already removed', async () => {
    setChats(
      [
        { id: 'chat', messages: [userMessage('m1', '/release-notes')] },
        { id: 'next', messages: [] },
      ],
      'chat',
    );
    await render();
    expect(hasContent).toBe(true);

    // A streamed commit removes the active chat; React keeps the previous
    // snapshot until the next frame, which never comes in this test.
    const never = (): number => 0;
    chatStoreRenderView.deferNotifications(
      {
        requestFrame: never,
        cancelFrame: () => undefined,
        setTimer: never,
        clearTimer: () => undefined,
        isHidden: () => false,
      },
      () => setChats([{ id: 'next', messages: [] }], 'next'),
    );
    // An unrelated update (closing a file tab) re-renders the panel first.
    expect(() =>
      act(() => {
        root.render(
          <div>
            <Probe />
            <ChatPluginsSection projectId="project" worktreeId="worktree" />
          </div>,
        );
      }),
    ).not.toThrow();

    act(() => chatStoreRenderView.flush());
    await flush();
    expect(hasContent).toBe(false);
  });

  it('offers no Share in a window without a share host', async () => {
    unregisterHost();
    setChats(
      [{ id: 'chat', messages: [userMessage('m1', '/release-notes')] }],
      'chat',
    );
    await render();
    expect(usedRows()).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="chat-used-invocable-share"]'),
    ).toBeNull();
  });

  it('drops retained results when switching away and back while both chats stream', async () => {
    const tabs = [
      { id: 'chat', messages: [userMessage('m1', '/release-notes')] },
      { id: 'other', status: 'streaming' as const, messages: [] },
    ];
    setChats(tabs, 'chat');
    await render();
    expect(usedRows()).toHaveLength(1);
    const streamingTabs = [
      { ...tabs[0], status: 'streaming' as const },
      tabs[1],
    ];
    act(() => setChats(streamingTabs, 'other'));
    await flush();
    act(() => setChats(streamingTabs, 'chat'));
    await flush();
    expect(usedRows()).toHaveLength(0);
  });
});
