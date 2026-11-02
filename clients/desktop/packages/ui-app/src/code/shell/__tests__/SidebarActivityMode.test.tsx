/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities, CanopyClient } from '@canopy/app-core';
import type { PortalSessionShellState } from '@canopy/protocol/portal';
import {
  CanopyClientProvider,
  sidebarActivityStandaloneChatKey,
  sidebarActivityWorktreeChatKey,
  type SidebarActivityEntry,
} from '@canopy/app-state';
import { SidebarSurface, type SidebarSurfaceProps } from '../SidebarSurface';
import { SidebarActivityModeToggle } from '../SidebarActivityModeToggle';
import {
  withSidebarActivitySpaceMute,
  type SidebarActivityHost,
  type SidebarActivityHostInventory,
} from '../sidebar-activity-host';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const baseCapabilities: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
  workspaceCreation: 'remote-clone',
  workspaceReordering: false,
  worktreeReordering: false,
  workspaceSettings: false,
  worktreeRemoval: 'archive',
};
const activityCapabilities: CanopyCapabilities = {
  ...baseCapabilities,
  sidebarActivityMode: true,
  chatDrafts: true,
};

const shell: Pick<
  PortalSessionShellState,
  'workspaces' | 'worktrees' | 'standaloneChats' | 'chatSummaries'
> = {
  workspaces: [
    { localId: 'ws', name: 'Alpha', type: 'single-repo' },
    { localId: 'cw', name: 'Chats', type: 'cowork' },
  ],
  worktrees: [{ localId: 'wt', workspaceLocalId: 'ws', branch: 'feat/x' }],
  standaloneChats: [],
  chatSummaries: [],
};

function summary(
  chatId: string,
  minute: number,
  role: 'user' | 'assistant' = 'assistant',
): PortalSessionShellState['chatSummaries'][number] {
  return {
    localId: chatId,
    chatId,
    scope: 'worktree',
    workspaceLocalId: 'ws',
    worktreeLocalId: 'wt',
    title: `Title ${chatId}`,
    lastMessageRole: role,
    lastMessageAt: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  };
}

const key = (chatId: string): string =>
  sidebarActivityWorktreeChatKey('ws', 'wt', chatId);

function fakeClient(capabilities: CanopyCapabilities): CanopyClient {
  return {
    capabilities,
    query: jest.fn(),
    command: jest.fn(),
    subscribe: jest.fn(() => () => undefined),
  };
}

function makeInventory(count: number): SidebarActivityHostInventory {
  return {
    inventory: {
      ...shell,
      chatSummaries: [
        summary('unread', 200),
        summary('draft', 199, 'user'),
        ...Array.from({ length: count }, (_, index) =>
          summary(`r${String(index).padStart(3, '0')}`, 100 - index),
        ),
      ],
      standaloneChats: [
        {
          localId: 'cowork',
          projectLocalId: 'cw',
          title: 'Cowork chat',
          lastMessageRole: 'assistant',
          lastMessageAt: new Date(Date.UTC(2026, 0, 1, 2)).toISOString(),
        },
      ],
    },
    unreadKeys: new Set([key('unread')]),
    draftKeys: new Set([key('draft')]),
  };
}

describe('Sidebar Activity mode', () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: CanopyClient;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = fakeClient(activityCapabilities);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function host(
    overrides: Partial<SidebarActivityHost> = {},
  ): SidebarActivityHost {
    return {
      sessionKey: 's1',
      loadInventory: () => Promise.resolve(makeInventory(60)),
      unreadKeys: new Set([key('unread')]),
      activeChatKey: null,
      onOpenChat: jest.fn(),
      ...overrides,
    };
  }

  function render(
    props: Partial<SidebarSurfaceProps> = {},
    extra?: JSX.Element,
  ): void {
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          {extra}
          <SidebarSurface
            variant="rail"
            snapshot={shell}
            selection={null}
            capabilities={activityCapabilities}
            contentState="ready"
            onSelect={() => undefined}
            testIds={{ workspaceList: 'tree-list' }}
            {...props}
          />
        </CanopyClientProvider>,
      );
    });
  }

  async function flush(): Promise<void> {
    for (let index = 0; index < 3; index += 1)
      await act(async () => {
        await Promise.resolve();
      });
  }

  const q = (selector: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(selector);
  const bells = (): HTMLElement[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="sidebar-activity-toggle"]',
      ),
    );
  const rowKeys = (section: string): string[] =>
    Array.from(
      container.querySelectorAll<HTMLElement>(
        `[data-testid="sidebar-activity-section-${section}"] [data-activity-key]`,
      ),
    ).map((row) => row.dataset.activityKey ?? '');

  it('renders no bell and no header for a host alone (desktop places its own)', () => {
    render({ activity: host() });
    expect(bells()).toHaveLength(0);
    expect(q('[data-testid="portal-sidebar-header"]')).toBeNull();
  });

  it('renders one header bell when asked, gated on the capability', () => {
    render({ activity: host(), activityToggleInHeader: true });
    expect(bells()).toHaveLength(1);
    expect(bells()[0]?.getAttribute('aria-label')).toBe('Activity');
    expect(bells()[0]?.getAttribute('aria-pressed')).toBe('false');
    render({
      activity: host(),
      activityToggleInHeader: true,
      capabilities: baseCapabilities,
    });
    expect(bells()).toHaveLength(0);
    expect(q('[data-testid="portal-sidebar-header"]')).toBeNull();
  });

  it('places Search immediately after the context bell and preserves disclosure focus', () => {
    render({
      activity: host(),
      activityToggleInHeader: true,
      activityToggleInContextRow: true,
      contextRowSlot: <button type="button">Personal</button>,
      chatSearch: { candidates: [], onSelectResult: jest.fn() },
      chatSearchPresentation: 'nav-row',
    });
    const header = q('[data-testid="portal-sidebar-context-row"]');
    const search = q('[data-testid="portal-sidebar-chat-search-toggle"]');
    const bell = bells()[0];
    if (!bell) throw new Error('Missing Activity bell');
    expect(search).not.toBeNull();
    expect(header?.contains(search)).toBe(true);
    expect(search?.textContent).toBe('');
    expect(search?.compareDocumentPosition(bell)).toBe(
      Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(
      container.querySelectorAll(
        '[data-testid="portal-sidebar-chat-search-toggle"]',
      ),
    ).toHaveLength(1);
    expect(
      q('[data-testid="portal-sidebar-menu-block"]')?.contains(search),
    ).toBe(false);
    act(() => search?.click());
    const input = q('[data-testid="portal-sidebar-chat-search-input"]');
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
    act(() => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(q('[data-testid="portal-sidebar-chat-search-input"]')).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it('places one bell beside the context switcher and keeps the header fallback', () => {
    render({
      activity: host(),
      activityToggleInHeader: true,
      activityToggleInContextRow: true,
      headerSlot: <span>Brand</span>,
      contextRowSlot: <button type="button">Personal</button>,
    });
    expect(bells()).toHaveLength(1);
    expect(
      q('[data-testid="portal-sidebar-context-row"]')?.contains(
        bells()[0] ?? null,
      ),
    ).toBe(true);
    expect(
      q('[data-testid="portal-sidebar-header"]')?.contains(bells()[0] ?? null),
    ).toBe(false);
    render({
      activity: host(),
      activityToggleInHeader: true,
      activityToggleInContextRow: true,
    });
    expect(bells()).toHaveLength(1);
    expect(
      q('[data-testid="portal-sidebar-header"]')?.contains(bells()[0] ?? null),
    ).toBe(true);
  });

  it('replaces the tree with ordered sections and paginates Unreplied', async () => {
    render({ activity: host(), activityToggleInHeader: true });
    expect(q('[data-testid="tree-list"]')).not.toBeNull();
    act(() => bells()[0]?.click());
    expect(q('[data-testid="sidebar-activity-loading"]')?.textContent).toBe(
      'Loading activity…',
    );
    expect(q('[data-testid="tree-list"]')).toBeNull();
    await flush();
    expect(bells()[0]?.getAttribute('aria-pressed')).toBe('true');
    const sections = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid^="sidebar-activity-section-"]',
      ),
    ).map((section) => section.querySelector('h2')?.textContent);
    expect(sections).toEqual(['Unread', 'Drafts', 'Unreplied']);
    expect(rowKeys('unread')).toEqual([key('unread')]);
    expect(rowKeys('drafts')).toEqual([key('draft')]);
    const unreplied = rowKeys('unreplied');
    expect(unreplied).toHaveLength(50);
    expect(unreplied[0]).toBe(sidebarActivityStandaloneChatKey('cw', 'cowork'));
    const showMore = q('[data-testid="sidebar-activity-show-more"]');
    expect(showMore?.textContent).toBe('Show more (11)');
    expect(showMore?.getAttribute('aria-label')).toBe(
      'Show more unreplied chats (11 remaining)',
    );
    const firstRows = container.querySelectorAll(
      '[data-testid="sidebar-activity-section-unreplied"] li',
    );
    act(() => showMore?.click());
    const after = rowKeys('unreplied');
    expect(after).toHaveLength(61);
    expect(after.slice(0, 50)).toEqual(unreplied);
    // Existing rows stay mounted, not rebuilt.
    const afterRows = container.querySelectorAll(
      '[data-testid="sidebar-activity-section-unreplied"] li',
    );
    expect(afterRows[0]).toBe(firstRows[0]);
    expect(q('[data-testid="sidebar-activity-show-more"]')).toBeNull();
    // Focus lands on the first revealed row, not the document.
    expect(
      document.activeElement
        ?.closest('[data-activity-row-index]')
        ?.getAttribute('data-activity-row-index'),
    ).toBe('50');
    act(() => bells()[0]?.click());
    expect(q('[data-testid="tree-list"]')).not.toBeNull();
    expect(q('[data-testid="sidebar-activity"]')).toBeNull();
  });

  it('shows worktree context and masks titles and branch text', async () => {
    render({ activity: host(), activityToggleInHeader: true });
    act(() => bells()[0]?.click());
    await flush();
    const row = q('[data-testid="sidebar-activity-row-unread"]');
    const title = row?.querySelector('[data-testid="worktree-row-title"]');
    expect(title?.textContent).toBe('Title unread');
    expect(title?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
    const context = Array.from(
      row?.querySelectorAll(`.${REPLAY_MASK_CLASS}`) ?? [],
    ).find((node) => node.textContent === 'feat/x · Alpha');
    expect(context).toBeDefined();
    // The row itself stays interactive and unmasked.
    expect(row?.classList.contains(REPLAY_MASK_CLASS)).toBe(false);
  });

  it('keeps live pipeline status while titles and order remain captured', async () => {
    const activity = host();
    render({ activity, activityToggleInHeader: true });
    act(() => bells()[0]?.click());
    await flush();
    const before = rowKeys('unread');
    render({
      activity,
      activityToggleInHeader: true,
      snapshot: {
        ...shell,
        worktrees: [
          {
            ...shell.worktrees[0],
            pipelineStatus: 'running',
            isRunningRun: true,
            branch: 'changed',
          },
        ],
      },
    });
    expect(rowKeys('unread')).toEqual(before);
    const row = q('[data-testid="sidebar-activity-row-unread"]');
    expect(
      row?.querySelector('[aria-label="Workflow running"]'),
    ).not.toBeNull();
    expect(row?.textContent).toContain('feat/x');
    expect(row?.textContent).not.toContain('changed');
  });

  it('selects only the active chat and opens exactly the clicked chat', async () => {
    const onOpenChat = jest.fn<void, [SidebarActivityEntry]>();
    const activity = host({ activeChatKey: key('r000'), onOpenChat });
    render({ activity, activityToggleInHeader: true });
    act(() => bells()[0]?.click());
    await flush();
    const selected = container.querySelectorAll('[aria-current="true"]');
    expect(selected).toHaveLength(1);
    const target = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-activity-row-r001"]',
    );
    act(() => {
      target?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(onOpenChat).toHaveBeenCalledTimes(1);
    const opened: SidebarActivityEntry = onOpenChat.mock.calls[0][0];
    expect(opened).toMatchObject({ chatId: 'r001', kind: 'worktree-chat' });
  });

  it('hides Drafts without the chatDrafts capability', async () => {
    const noDrafts = { ...activityCapabilities, chatDrafts: false };
    client = fakeClient(noDrafts);
    render({
      activity: host(),
      activityToggleInHeader: true,
      capabilities: noDrafts,
    });
    act(() => bells()[0]?.click());
    await flush();
    expect(q('[data-testid="sidebar-activity-section-drafts"]')).toBeNull();
    // The draft chat is user-last, so with drafts withheld it is in no section.
    expect(container.textContent).not.toContain('Title draft');
  });

  it('shows the empty state', async () => {
    render({
      activity: host({
        loadInventory: () => Promise.resolve({ inventory: shell }),
      }),
      activityToggleInHeader: true,
    });
    act(() => bells()[0]?.click());
    await flush();
    expect(q('[data-testid="sidebar-activity-empty"]')?.textContent).toBe(
      'No activityUnread, draft, and unreplied chats appear here',
    );
  });

  it('shows an error and retries with the same loader', async () => {
    const loadInventory = jest
      .fn<Promise<SidebarActivityHostInventory>, []>()
      .mockRejectedValueOnce(new Error('partial'))
      .mockResolvedValueOnce(makeInventory(1));
    render({ activity: host({ loadInventory }), activityToggleInHeader: true });
    act(() => bells()[0]?.click());
    await flush();
    expect(q('[data-testid="sidebar-activity-error"]')?.textContent).toContain(
      "Couldn't load activity. Try again.",
    );
    act(() => q('[data-testid="sidebar-activity-retry"]')?.click());
    await flush();
    expect(loadInventory).toHaveBeenCalledTimes(2);
    expect(rowKeys('unread')).toEqual([key('unread')]);
  });

  it('clears a dot in place without moving or remounting the row', async () => {
    const activity = host();
    render({ activity, activityToggleInHeader: true });
    act(() => bells()[0]?.click());
    await flush();
    const before = rowKeys('unread');
    const rowBefore = q('[data-testid="sidebar-activity-row-unread"]');
    expect(
      rowBefore?.querySelector('[data-testid="worktree-row-unread"]'),
    ).not.toBeNull();
    render({
      activity: { ...activity, unreadKeys: new Set<string>() },
      activityToggleInHeader: true,
    });
    expect(rowKeys('unread')).toEqual(before);
    const rowAfter = q('[data-testid="sidebar-activity-row-unread"]');
    expect(rowAfter).toBe(rowBefore);
    expect(
      rowAfter?.querySelector('[data-testid="worktree-row-unread"]'),
    ).toBeNull();
  });

  describe('muted spaces (CAN-4378)', () => {
    const muted = { status: 'ready', override: 'mute' } as const;
    const loud = { status: 'ready', override: 'all' } as const;
    const mutedInventory = (): SidebarActivityHostInventory => {
      const loaded = makeInventory(1);
      return {
        ...loaded,
        inventory: {
          ...loaded.inventory,
          standaloneChats: [
            {
              localId: 'cowork',
              projectLocalId: 'cw',
              workEntryId: 'entry',
              title: 'Cowork chat',
              hasUnread: true,
              lastMessageRole: 'assistant',
              lastMessageAt: new Date(Date.UTC(2026, 0, 1, 2)).toISOString(),
            },
          ],
        },
        unreadKeys: new Set([
          key('unread'),
          sidebarActivityStandaloneChatKey('cw', 'cowork'),
        ]),
      };
    };
    const liveUnread = new Set([
      key('unread'),
      sidebarActivityStandaloneChatKey('cw', 'cowork'),
    ]);

    it("keeps a muted space's chats out of Unread", async () => {
      const lookup = jest.fn(() => muted);
      render({
        activity: host({
          loadInventory: () => Promise.resolve(mutedInventory()),
          unreadKeys: liveUnread,
        }),
        activityToggleInHeader: true,
        getWorktreeNotificationSettings: lookup,
      });
      act(() => bells()[0]?.click());
      await flush();
      expect(q('[data-testid="sidebar-activity-section-unread"]')).toBeNull();
      expect(rowKeys('unreplied')).toEqual(
        expect.arrayContaining([
          key('unread'),
          sidebarActivityStandaloneChatKey('cw', 'cowork'),
        ]),
      );
      expect(lookup).toHaveBeenCalledWith('ws', 'wt');
      expect(lookup).toHaveBeenCalledWith('cw', 'entry');
      expect(container.querySelector('[aria-label="Unread messages"]')).toBe(
        null,
      );
      expect(q('[data-testid="worktree-row-unread"]')).toBeNull();
    });

    it('hides a live dot when its space is muted after the build, and restores it on unmute', async () => {
      const activity = host({
        loadInventory: () => Promise.resolve(mutedInventory()),
        unreadKeys: liveUnread,
      });
      render({
        activity,
        activityToggleInHeader: true,
        getWorktreeNotificationSettings: () => loud,
      });
      act(() => bells()[0]?.click());
      await flush();
      const unreadRow = (): HTMLElement | null =>
        q('[data-testid="sidebar-activity-row-unread"]');
      const coworkRow = (): HTMLElement | null =>
        q('[data-testid="sidebar-activity-row-cowork"]');
      expect(
        unreadRow()?.querySelector('[data-testid="worktree-row-unread"]'),
      ).not.toBeNull();
      expect(
        coworkRow()?.querySelector('[aria-label="Unread messages"]'),
      ).not.toBeNull();
      const before = rowKeys('unread');
      render({
        activity,
        activityToggleInHeader: true,
        getWorktreeNotificationSettings: () => muted,
      });
      // The list stays frozen; only the dots follow the choice.
      expect(rowKeys('unread')).toEqual(before);
      expect(
        unreadRow()?.querySelector('[data-testid="worktree-row-unread"]'),
      ).toBeNull();
      expect(
        coworkRow()?.querySelector('[aria-label="Unread messages"]'),
      ).toBeNull();
      render({
        activity,
        activityToggleInHeader: true,
        getWorktreeNotificationSettings: () => loud,
      });
      expect(
        unreadRow()?.querySelector('[data-testid="worktree-row-unread"]'),
      ).not.toBeNull();
    });

    it('masks a build started from a bell outside the surface', async () => {
      const activity = withSidebarActivitySpaceMute(
        host({ loadInventory: () => Promise.resolve(mutedInventory()) }),
        () => true,
      );
      render(
        { activity },
        <SidebarActivityModeToggle
          host={activity}
          capabilities={activityCapabilities}
        />,
      );
      act(() => bells()[0]?.click());
      await flush();
      expect(q('[data-testid="sidebar-activity-section-unread"]')).toBeNull();
      expect(withSidebarActivitySpaceMute(undefined, () => true)).toBe(
        undefined,
      );
      const plain = host();
      expect(withSidebarActivitySpaceMute(plain, undefined)).toBe(plain);
    });
  });

  it('ends Activity when the capability is revoked or the session changes', async () => {
    render({ activity: host(), activityToggleInHeader: true });
    act(() => bells()[0]?.click());
    await flush();
    expect(q('[data-testid="sidebar-activity"]')).not.toBeNull();
    render({
      activity: host({ sessionKey: 's2' }),
      activityToggleInHeader: true,
    });
    await flush();
    expect(q('[data-testid="sidebar-activity"]')).toBeNull();
    expect(q('[data-testid="tree-list"]')).not.toBeNull();
    expect(bells()[0]?.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not revive a frozen inventory when its host disconnects and returns', async () => {
    const activity = host();
    render({ activity, activityToggleInHeader: true });
    act(() => bells()[0]?.click());
    await flush();
    render({ activity: undefined, activityToggleInHeader: true });
    await flush();
    render({ activity, activityToggleInHeader: true });
    await flush();
    expect(q('[data-testid="sidebar-activity"]')).toBeNull();
    expect(bells()[0]?.getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps the search overlay over Activity and makes Activity inert under it', async () => {
    render({
      activity: host(),
      activityToggleInHeader: true,
      chatSearch: { candidates: [], onSelectResult: () => undefined },
    });
    act(() => bells()[0]?.click());
    await flush();
    const input = q('[data-testid="portal-sidebar-chat-search-input"]');
    expect(input).not.toBeNull();
    const setter = Reflect.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    act(() => {
      if (setter && input) Reflect.apply(setter, input, ['zzz']);
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(
      q('[data-testid="portal-sidebar-chat-search-results"]'),
    ).not.toBeNull();
    const activity = q('[data-testid="sidebar-activity"]');
    expect(activity?.closest('[inert]')).not.toBeNull();
  });

  describe('under a host rail’s pinned More row', () => {
    const START = '--sidebar-activity-mask-start';
    const END = '--sidebar-activity-mask-end';
    const VIEWPORT_TOP = 100;
    const LIST_CONTENT_TOP = 200;
    const LEAD_HEIGHT = 44;

    afterEach(() => jest.restoreAllMocks());

    function renderInRail(): HTMLElement {
      act(() => {
        root.render(
          <CanopyClientProvider client={client}>
            <div data-testid="sidebar-scroll-container">
              <div
                data-sidebar-more-lead=""
                style={{ position: 'sticky', top: '1px' }}
              >
                More
              </div>
              <SidebarSurface
                variant="rail"
                snapshot={shell}
                selection={null}
                capabilities={activityCapabilities}
                contentState="ready"
                onSelect={() => undefined}
                scrollOwner="host"
                activity={host()}
                activityToggleInHeader
              />
            </div>
          </CanopyClientProvider>,
        );
      });
      const viewport = q('[data-testid="sidebar-scroll-container"]');
      const lead = q('[data-sidebar-more-lead]');
      if (!viewport || !lead) throw new Error('rail not rendered');
      Object.defineProperty(lead, 'offsetHeight', { value: LEAD_HEIGHT });
      jest
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockImplementation(function (this: HTMLElement): DOMRect {
          const top =
            this === viewport
              ? VIEWPORT_TOP
              : this.dataset.testid === 'sidebar-activity'
                ? VIEWPORT_TOP + LIST_CONTENT_TOP - viewport.scrollTop
                : 0;
          return new DOMRect(0, top, 240, 0);
        });
      return viewport;
    }

    function scrollTo(viewport: HTMLElement, top: number): void {
      viewport.scrollTop = top;
      act(() => {
        viewport.dispatchEvent(new Event('scroll'));
      });
    }

    it('cuts the rows at the More row’s bottom as they scroll beneath it', async () => {
      const viewport = renderInRail();
      act(() => bells()[0]?.click());
      await flush();
      const list = q('[data-testid="sidebar-activity"]');
      expect(list?.style.getPropertyValue(START)).toBe('-12px');
      expect(list?.style.getPropertyValue(END)).toBe('0px');
      scrollTo(viewport, 500);
      // The More row's stuck bottom (1px + 44px) in the list's own space.
      const cut = 500 + 1 + LEAD_HEIGHT - LIST_CONTENT_TOP;
      expect(list?.style.getPropertyValue(START)).toBe(`${cut}px`);
      expect(list?.style.getPropertyValue(END)).toBe(`${cut + 12}px`);
      scrollTo(viewport, 0);
      expect(list?.style.getPropertyValue(START)).toBe('-12px');
    });

    it('leaves the tree alone and stops masking once Activity ends', async () => {
      const viewport = renderInRail();
      const masked = (): Element | null =>
        container.querySelector(`[style*="${START}"]`);
      scrollTo(viewport, 500);
      expect(masked()).toBeNull();
      act(() => bells()[0]?.click());
      await flush();
      scrollTo(viewport, 500);
      expect(masked()).not.toBeNull();
      act(() => bells()[0]?.click());
      scrollTo(viewport, 500);
      expect(masked()).toBeNull();
    });

    it('does not mask a surface without a pinned lead (portal)', async () => {
      render({ activity: host(), activityToggleInHeader: true });
      act(() => bells()[0]?.click());
      await flush();
      const list = q('[data-testid="sidebar-activity"]');
      expect(list).not.toBeNull();
      expect(list?.style.getPropertyValue(START)).toBe('');
    });
  });

  it('a standalone toggle without a host renders nothing', () => {
    act(() => {
      root.render(
        <CanopyClientProvider client={client}>
          <SidebarActivityModeToggle
            host={undefined}
            capabilities={activityCapabilities}
          />
        </CanopyClientProvider>,
      );
    });
    expect(bells()).toHaveLength(0);
  });
});
