/**
 * @jest-environment jsdom
 */
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StandaloneChatsSidebarSection } from '../StandaloneChatsSidebarSection';
import { SidebarScrollArea } from '../sidebar/SidebarScrollArea';
import {
  CHATS_CONTENT_SELECTOR,
  CHATS_HEADER_SELECTOR,
} from '../sidebar/chats-header-reveal';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const testIds = {
  root: 'standalone-list',
  folderToggle: 'folder-toggle',
};

const state = {
  workspaces: [{ name: 'Hidden Workspace' }],
  standaloneChats: [
    {
      localId: 'sc-a',
      title: 'Newest Chat',
      modelLabel: 'Claude Sonnet',
      providerType: 'claude' as const,
    },
    {
      localId: 'sc-b',
      title: 'Middle Chat',
      providerType: 'codex' as const,
    },
    { localId: 'sc-c', title: 'Oldest Chat' },
    { localId: 'sc-archived', title: 'Archived chat', archived: true },
  ],
};

function setCoarsePointer(matches: boolean): void {
  window.matchMedia = jest.fn().mockImplementation(
    (query: string): MediaQueryList =>
      ({
        matches: query === '(pointer: coarse)' && matches,
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(),
      }) as MediaQueryList,
  );
}

describe('StandaloneChatsSidebarSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setCoarsePointer(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  async function render(
    props: Partial<ComponentProps<typeof StandaloneChatsSidebarSection>> = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        <StandaloneChatsSidebarSection
          snapshot={state}
          selectedStandaloneChatId={null}
          onSelectChat={() => {}}
          testIds={testIds}
          {...props}
        />,
      );
      await Promise.resolve();
    });
  }

  it('renders whole Work Entry groups in Cowork folders with selected sub-chat retained', async () => {
    const workspace = {
      localId: 'cowork',
      name: 'Research',
      type: 'cowork' as const,
      itemGroups: [
        {
          id: 'grp-work',
          name: 'Release',
          color: 'neutral' as const,
          collapsed: true,
          memberIds: ['entry-a'],
        },
      ],
    };
    await render({
      workspace,
      snapshot: {
        workspaces: [workspace],
        standaloneChats: [
          {
            localId: 'a',
            projectLocalId: 'cowork',
            workEntryId: 'entry-a',
            title: 'First',
          },
          {
            localId: 'a-child',
            projectLocalId: 'cowork',
            workEntryId: 'entry-a',
            title: 'Selected',
          },
          {
            localId: 'b',
            projectLocalId: 'cowork',
            workEntryId: 'entry-b',
            title: 'Other',
          },
        ],
      },
      selectedStandaloneChatId: 'a-child',
    });
    expect(container.textContent).toContain('Release');
    expect(
      container.querySelectorAll('[data-sidebar-item-group-id="grp-work"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-standalone-chat-id="entry-a"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-item-group-create"]'),
    ).toBeNull();
  });

  describe('group and upstream Chats integration', () => {
    const workspace = {
      localId: 'cowork-default',
      name: 'Chats',
      type: 'cowork' as const,
      itemGroups: [
        {
          id: 'grp-work',
          name: 'Release',
          color: 'neutral' as const,
          collapsed: false,
          memberIds: ['entry-a', 'entry-b'],
        },
      ],
    };
    const snapshot = {
      workspaces: [workspace],
      standaloneChats: [
        {
          localId: 'a',
          projectLocalId: workspace.localId,
          workEntryId: 'entry-a',
          workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
          title: 'First',
        },
        {
          localId: 'b',
          projectLocalId: workspace.localId,
          workEntryId: 'entry-b',
          workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
          title: 'Other',
        },
      ],
    };
    it('keeps only the selected grouped entry when the Chats section collapses', async () => {
      await render({
        workspace,
        snapshot,
        headerPresentation: 'section',
        selectedStandaloneChatId: 'a',
        collapsed: true,
      });
      expect(
        container.querySelector('[data-standalone-chat-id="entry-a"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-standalone-chat-id="entry-b"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-sidebar-item-group-id]'),
      ).toBeNull();
    });
    it('keeps group actions and viewer notification choices in the same row menu', async () => {
      const onOpen = jest.fn();
      const onSelect = jest.fn();
      await render({
        workspace,
        snapshot,
        headerPresentation: 'section',
        itemGroupCommands: {
          create: jest.fn(),
          update: jest.fn(),
          ungroup: jest.fn(),
          moveItem: jest.fn(),
          moveGroup: jest.fn(),
        },
        workEntryNotifications: {
          getState: () => ({ status: 'ready', override: null }),
          onOpen,
          onSelect,
        },
      });
      const more = container.querySelector<HTMLButtonElement>(
        '[data-testid="portal-chats-work-entry-entry-a-menu"]',
      );
      expect(more).not.toBeNull();
      await act(async () => {
        more?.click();
        await Promise.resolve();
      });
      expect(onOpen).toHaveBeenCalledWith(workspace.localId, 'entry-a');
      expect(
        Array.from(document.body.querySelectorAll('[role="menuitem"]')).some(
          (item) => item.textContent === 'Group',
        ),
      ).toBe(true);
      const mute = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ),
      ).find((choice) => choice.textContent === 'Mute');
      expect(mute).toBeDefined();
      act(() => mute?.click());
      expect(onSelect).toHaveBeenCalledWith(
        workspace.localId,
        'entry-a',
        'mute',
      );
    });
  });

  // Desktop's Chats header carries a trailing cluster — settings and a "+"
  // that creates the first chat. The portal rendered a bare toggle, so the
  // same section offered different affordances per platform. The cluster is
  // rendered HERE rather than injected as a slot, so both hosts get the same
  // chrome and can only differ in which handlers they supply.
  describe('section header label', () => {
    async function sectionLabel(
      workspaceName: string,
    ): Promise<Element | null> {
      await render({
        headerPresentation: 'section',
        workspace: { name: workspaceName, type: 'cowork' },
        testIds: { ...testIds, sectionToggle: 'chats-toggle' },
      });
      return (
        container.querySelector('[data-testid="chats-toggle"] span') ?? null
      );
    }

    it('shows a renamed catch-all project name in the section header', async () => {
      const label = await sectionLabel('Acme secret project');
      expect(label?.textContent).toBe('Acme secret project');
    });

    it('labels the default project header Chats', async () => {
      const label = await sectionLabel('Default');
      expect(label?.textContent).toBe('Chats');
    });
  });

  describe('section header actions', () => {
    it('renders no cluster when the host supplies no handlers', async () => {
      await render({ headerPresentation: 'section' });
      expect(
        container.querySelector('[data-testid="chats-settings"]'),
      ).toBeNull();
      expect(container.querySelector('[data-testid="chats-new"]')).toBeNull();
    });

    it('renders settings and new-chat when handlers are supplied', async () => {
      const onOpenSettings = jest.fn();
      const onCreateChat = jest.fn();
      await render({
        headerPresentation: 'section',
        onOpenSettings,
        onCreateChat,
        testIds: {
          ...testIds,
          sectionSettings: 'chats-settings',
          sectionCreateChat: 'chats-new',
        },
      });

      const settings = container.querySelector<HTMLButtonElement>(
        '[data-testid="chats-settings"]',
      );
      const create = container.querySelector<HTMLButtonElement>(
        '[data-testid="chats-new"]',
      );
      expect(settings).not.toBeNull();
      expect(create).not.toBeNull();

      await act(async () => {
        settings?.click();
        create?.click();
        await Promise.resolve();
      });
      expect(onOpenSettings).toHaveBeenCalledTimes(1);
      expect(onCreateChat).toHaveBeenCalledTimes(1);
    });

    it('reveals the new-chat "+" on hover, like the Projects header', async () => {
      await render({
        headerPresentation: 'section',
        onCreateChat: jest.fn(),
        testIds: { ...testIds, sectionCreateChat: 'chats-new' },
      });
      const create = container.querySelector<HTMLButtonElement>(
        '[data-testid="chats-new"]',
      );
      expect(create).not.toBeNull();
      expect(create?.closest('[class~="opacity-0"]')).not.toBeNull();
    });

    it('inks the header buttons like the header label and chevron', async () => {
      await render({
        headerPresentation: 'section',
        onOpenSettings: jest.fn(),
        onCreateChat: jest.fn(),
        testIds: {
          ...testIds,
          sectionSettings: 'chats-settings',
          sectionCreateChat: 'chats-new',
        },
      });
      for (const id of ['chats-settings', 'chats-new']) {
        const button = container.querySelector<HTMLButtonElement>(
          `[data-testid="${id}"]`,
        );
        expect(button?.classList.contains('fg-quaternary')).toBe(true);
        expect(button?.classList.contains('fg-tertiary')).toBe(false);
      }
    });

    it('draws the More button as the same rail button as its siblings', async () => {
      // Two 24px hover squares sit side by side in this header; a hand-rolled
      // More with its own 4px corner beside the rail buttons' 8px read as two
      // controls from different families.
      await render({
        headerPresentation: 'section',
        onOpenSettings: jest.fn(),
        renderHeaderMenuItems: () => null,
        testIds: {
          ...testIds,
          sectionSettings: 'chats-settings',
          sectionMenu: 'chats-more',
        },
      });
      const settings = container.querySelector<HTMLButtonElement>(
        '[data-testid="chats-settings"]',
      );
      const more = container.querySelector<HTMLButtonElement>(
        '[data-testid="chats-more"]',
      );
      expect(more).not.toBeNull();
      expect(more?.classList.contains('rounded-md')).toBe(true);
      expect(more?.classList.contains('rounded')).toBe(false);
      for (const shape of ['h-6', 'w-6', 'rounded-md', 'hover:bg-subtle']) {
        expect(more?.classList.contains(shape)).toBe(
          settings?.classList.contains(shape),
        );
      }
    });

    it('keeps the empty-section create control visible across a host collapse', async () => {
      const props = {
        snapshot: { ...state, standaloneChats: [] },
        workspace: { name: 'Default', type: 'cowork' as const },
        headerPresentation: 'section' as const,
        onCreateChat: jest.fn(),
        testIds: { ...testIds, sectionCreateChat: 'chats-new' },
      };
      await render({ ...props, collapsed: false });
      await render({ ...props, collapsed: true });
      const create = container.querySelector('[data-testid="chats-new"]');
      expect(create).not.toBeNull();
      expect(create?.closest('[class~="pointer-fine:invisible"]')).toBeNull();
    });

    it('keeps the cluster reachable while the section is collapsed', async () => {
      // Desktop's "+" is the only entry point to this bucket on a fresh
      // install, so it must not disappear with the rows.
      await render({
        headerPresentation: 'section',
        collapsed: true,
        onCreateChat: jest.fn(),
        testIds: { ...testIds, sectionCreateChat: 'chats-new' },
      });
      expect(
        container.querySelector('[data-testid="chats-new"]'),
      ).not.toBeNull();
    });
  });

  // The rail's sticky machinery is selector-driven, not component-driven:
  // `chats-header-reveal.ts` and the scroll sync find their subjects by these
  // marks. Slice 1 moved the selectors into shared scope so both hosts could
  // address the same surfaces; emitting the marks here is the other half of
  // that contract, and what lets the shared surface inherit desktop's sticky
  // behavior rather than reimplementing it.
  describe('sticky rail marks', () => {
    it('marks the section header and its row wrapper', async () => {
      await render({ headerPresentation: 'section' });
      const header = container.querySelector(CHATS_HEADER_SELECTOR);
      const content = container.querySelector(CHATS_CONTENT_SELECTOR);
      expect(header).not.toBeNull();
      expect(content).not.toBeNull();
      // The reveal measures one against the other, so the rows must not be
      // nested inside the header.
      expect(header?.contains(content ?? null)).toBe(false);
    });

    it('carries the desktop mask class, not just the data mark', async () => {
      // The class is not decorative: desktop's globals.css has an active
      // mask rule for it. Asserting only the data attribute would leave this
      // suite green if the class were dropped.
      await render({ headerPresentation: 'section' });
      expect(
        container
          .querySelector(CHATS_CONTENT_SELECTOR)
          ?.classList.contains('sidebar-chats-scroll-mask'),
      ).toBe(true);
    });

    it('does not let an ordinary cowork folder claim the Chats marks', async () => {
      // The default `folder` presentation renders ordinary cowork
      // workspaces. It emits no Chats header, so emitting the mask would
      // leave the rail's sync — which takes the FIRST match of each and
      // pairs them — treating a folder as the unique Chats section whenever
      // the real one is absent, which it is when it has no chats.
      await render({ headerPresentation: 'folder' });
      expect(container.querySelector(CHATS_HEADER_SELECTOR)).toBeNull();
      expect(container.querySelector(CHATS_CONTENT_SELECTOR)).toBeNull();
      expect(container.querySelector('.sidebar-chats-scroll-mask')).toBeNull();
    });

    it('keeps the header mark when the section is collapsed', async () => {
      // The header is exactly what stays on screen through a collapse, so the
      // sync must still be able to find it.
      await render({ headerPresentation: 'section', collapsed: true });
      expect(container.querySelector(CHATS_HEADER_SELECTOR)).not.toBeNull();
      expect(container.querySelector(CHATS_CONTENT_SELECTOR)).toBeNull();
    });
  });

  it('does not render a model label on cowork rows (CAN-2515)', async () => {
    // The fixture's `sc-a` supplies `modelLabel: 'Claude Sonnet'`. The desktop
    // work-entry row shows a title plus an agent-response preview and never the
    // model, so supplying it must not put it on screen.
    await render();

    expect(container.textContent).toContain('Newest Chat');
    expect(container.textContent).not.toContain('Claude Sonnet');
  });

  it('uses the first cowork project name with a Default fallback', async () => {
    await render();
    expect(container.textContent).toContain('Default');

    await render({
      snapshot: {
        ...state,
        workspaces: [
          ...state.workspaces,
          { name: 'My Cowork', type: 'cowork' },
          { name: 'Other Cowork', type: 'cowork' },
        ],
      },
    });
    expect(container.textContent).toContain('My Cowork');
    expect(container.textContent).not.toContain('Other Cowork');
    expect(container.textContent).not.toContain('Default');
  });

  // REG-2819. The primary election picks who owns unparented chats, which is a
  // placement question. A cloud workspace classifies as `cowork` but is
  // tree-shaped and holds no standalone chats, so it must be skipped — keyed to
  // `type` it would win on order and hand this section the wrong name.
  it('skips a tree-layout cloud project when electing the primary', async () => {
    await render({
      snapshot: {
        ...state,
        workspaces: [
          ...state.workspaces,
          {
            localId: 'cloud',
            name: 'Cloud',
            type: 'cowork',
            layout: 'tree',
            order: 0,
          },
          { localId: 'desktop', name: 'My Cowork', type: 'cowork', order: 1 },
        ],
      },
    });
    expect(container.textContent).toContain('My Cowork');
    expect(container.textContent).not.toContain('Cloud');
  });

  it('renders active chats flat in projection order with provider icons', async () => {
    await render();
    const text = container.textContent ?? '';
    expect(text.indexOf('Newest Chat')).toBeLessThan(
      text.indexOf('Middle Chat'),
    );
    expect(text.indexOf('Middle Chat')).toBeLessThan(
      text.indexOf('Oldest Chat'),
    );
    expect(text).not.toContain('Archived chat');
    expect(text).not.toContain('Today');
    expect(
      container.querySelectorAll(
        'span[class~="h-5"][class~="fg-tertiary"] > svg',
      ),
    ).toHaveLength(2);
  });

  // Desktop labels a Chats row with its Work Entry title (the rename, else
  // the primary chat's generated description, else its title), so the same
  // chat must not read "2+2" on the portal and "Basic arithmetic" on desktop
  // (CAN-3108). A chat with no projected entry keeps its own title.
  it('labels a row with its Work Entry title when one is projected', async () => {
    await render({
      snapshot: {
        workspaces: state.workspaces,
        standaloneChats: [
          {
            localId: 'sc-entry',
            title: '2+2',
            workEntryTitle: 'Basic arithmetic calculation',
          },
          { localId: 'sc-flat', title: 'Legacy chat' },
        ],
      },
    });
    const entryRow = container.querySelector(
      '[data-standalone-chat-id="sc-entry"]',
    );
    expect(entryRow?.textContent).toBe('Basic arithmetic calculation');
    expect(
      container.querySelector('[data-standalone-chat-id="sc-flat"]')
        ?.textContent,
    ).toBe('Legacy chat');
  });

  it('marks the selected row', async () => {
    await render({ selectedStandaloneChatId: 'sc-b' });

    const selected = container.querySelector(
      '[data-standalone-chat-id="sc-b"]',
    );
    expect(
      selected?.closest('[data-selected]')?.getAttribute('data-selected'),
    ).toBe('true');
  });

  it('applies host chat row test ids', async () => {
    await render({
      testIds: {
        ...testIds,
        chatRow: (chatLocalId) => `host-chat-${chatLocalId}`,
      },
    });
    expect(
      container.querySelector('[data-testid="host-chat-sc-b"]'),
    ).not.toBeNull();
  });

  it('maps row clicks to the selection callback', async () => {
    const onSelectChat = jest.fn();
    await render({ selectedStandaloneChatId: null, onSelectChat });

    const row = container.querySelector('[data-standalone-chat-id="sc-b"]');
    act(() => {
      if (!(row instanceof HTMLElement)) throw new Error('row not found');
      row.click();
    });
    expect(onSelectChat).toHaveBeenCalledWith('sc-b');
  });

  // ---- D1: cowork header parity + persisted collapse ----------------------

  it('renders the cowork header at sidebar text scale, like tree project headers', async () => {
    await render();
    // Tree workspace headers pass textScale="sidebar" (text-s font-normal);
    // the cowork header used the page scale (text-m font-semibold), which is
    // why "Default"/"Personal" rendered larger than its neighbours on web.
    expect(container.querySelector('.text-m.font-semibold')).toBeNull();
    expect(container.querySelector('.text-s.font-normal')).not.toBeNull();
  });

  it('seeds the folder from the host collapse state and reports toggles', async () => {
    const onCollapsedChange = jest.fn();
    await render({ collapsed: true, onCollapsedChange });
    // Collapsed on mount ⇒ no chat rows.
    expect(
      container.querySelector('[data-standalone-chat-id="sc-a"]'),
    ).toBeNull();
    const toggle = container.querySelector('[data-testid="folder-toggle"]');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      if (!(toggle instanceof HTMLElement)) throw new Error('toggle not found');
      toggle.click();
    });
    // The host persists; the section only reports.
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it('follows a later host collapse change', async () => {
    await render({ collapsed: false });
    expect(
      container.querySelector('[data-standalone-chat-id="sc-a"]'),
    ).not.toBeNull();
    await render({ collapsed: true });
    expect(
      container.querySelector('[data-standalone-chat-id="sc-a"]'),
    ).toBeNull();
  });

  it('collapses the folder locally', async () => {
    await render({ selectedStandaloneChatId: null });

    const toggle = container.querySelector('[data-testid="folder-toggle"]');
    act(() => {
      if (!(toggle instanceof HTMLElement)) throw new Error('toggle not found');
      toggle.click();
    });
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('[data-standalone-chat-id="sc-a"]'),
    ).toBeNull();
  });

  it('hides the fine-pointer chevron at rest and reveals it from the right-edge slot', async () => {
    await render();

    const collapseControls = container.querySelectorAll(
      '[aria-label="Collapse Default"]',
    );
    const chevron = collapseControls.item(1);
    const actionSlot = chevron?.closest('div');
    expect(collapseControls).toHaveLength(2);
    expect(chevron).not.toBeNull();
    expect(actionSlot?.className).toContain('pointer-fine:invisible');
    expect(actionSlot?.className).toContain(
      'pointer-fine:group-hover/sidebar-item:visible',
    );
    expect(actionSlot?.className).toContain(
      'pointer-fine:group-focus-within/sidebar-item:visible',
    );
    expect(actionSlot?.className).toContain('pointer-fine:right-0');
  });

  it('uses the name tap as the coarse-pointer collapse toggle without a chevron', async () => {
    setCoarsePointer(true);
    await render();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="folder-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[aria-label="Collapse Default"]')).toBe(
      toggle,
    );
    expect(container.querySelectorAll('button')).toHaveLength(1);

    act(() => toggle?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(
      container.querySelector('[data-standalone-chat-id="sc-a"]'),
    ).toBeNull();
  });

  it('renders nothing when every chat is archived', async () => {
    await render({
      snapshot: {
        ...state,
        standaloneChats: state.standaloneChats.map((chat) => ({
          ...chat,
          archived: true,
        })),
      },
    });
    expect(container.innerHTML).toBe('');
  });

  it('renders the project header for a chatless cowork project', async () => {
    // CAN-1986: a fresh cowork workspace has no chats yet; its section header
    // must still render so the workspace is visible in the sidebar.
    await render({
      workspace: { localId: 'cw-fresh', name: 'Fresh Cowork', type: 'cowork' },
      snapshot: {
        workspaces: [
          { localId: 'cw-fresh', name: 'Fresh Cowork', type: 'cowork' },
        ],
        standaloneChats: [],
      },
    });

    expect(container.textContent).toContain('Fresh Cowork');
    expect(
      container.querySelector('[data-testid="standalone-list"]'),
    ).not.toBeNull();
  });

  it('selects the project from the header when onSelectWorkspace is wired', async () => {
    // CAN-1986 review finding: the per-workspace header must be able to
    // activate its workspace, not just collapse the section.
    const onSelectWorkspace = jest.fn();
    await render({
      workspace: { localId: 'cw1', name: 'My Cowork', type: 'cowork' },
      snapshot: {
        workspaces: [{ localId: 'cw1', name: 'My Cowork', type: 'cowork' }],
        standaloneChats: [],
      },
      onSelectWorkspace,
    });

    const select = container.querySelector<HTMLButtonElement>(
      '[aria-label="Select My Cowork"]',
    );
    act(() => {
      if (!select) throw new Error('select affordance not found');
      select.click();
    });
    expect(onSelectWorkspace).toHaveBeenCalledTimes(1);
  });

  it('renders orphan chats under only the first displayed cowork project', async () => {
    const coworkSnapshot = {
      workspaces: [
        {
          localId: 'cowork-b',
          name: 'Cowork B',
          type: 'cowork',
          order: 2,
        },
        {
          localId: 'cowork-a',
          name: 'Cowork A',
          type: 'cowork',
          order: 1,
        },
      ],
      standaloneChats: [
        { localId: 'orphan', title: 'Orphan chat' },
        {
          localId: 'chat-a',
          projectLocalId: 'cowork-a',
          title: 'Chat A',
        },
        {
          localId: 'chat-b',
          projectLocalId: 'cowork-b',
          title: 'Chat B',
        },
      ],
    };

    await act(async () => {
      root.render(
        <>
          {coworkSnapshot.workspaces.map((workspace) => (
            <StandaloneChatsSidebarSection
              key={workspace.localId}
              snapshot={coworkSnapshot}
              workspace={workspace}
              selectedStandaloneChatId={null}
              onSelectChat={() => {}}
              testIds={{ root: `workspace-${workspace.localId}` }}
            />
          ))}
        </>,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelectorAll(
        '[data-testid="workspace-cowork-a"] [data-standalone-chat-id="orphan"]',
      ),
    ).toHaveLength(1);
    expect(
      container.querySelector(
        '[data-testid="workspace-cowork-b"] [data-standalone-chat-id="orphan"]',
      ),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-standalone-chat-id="chat-a"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-standalone-chat-id="chat-b"]'),
    ).toHaveLength(1);
  });

  it('applies drawer touch sizing to the folder and rows', async () => {
    await render({ touchTargets: true });
    expect(
      container.querySelector('[data-testid="folder-toggle"]')?.className,
    ).toContain('min-h-11');
    expect(
      container.querySelector('[data-standalone-chat-id="sc-a"]')?.className,
    ).toContain('min-h-11');
  });

  // CAN-3451: the rail-owned header is opaque (`bg-sidebar`) and sticky. With
  // classic scrollbars the thumb reaches past the content's gutter into the
  // header's box, so the header must stack BELOW the scrollbar rail or it
  // paints a notch into the thumb.
  it('stacks the rail-owned sticky header below the sidebar scrollbar rail', async () => {
    const zTier = (element: Element | null | undefined): number => {
      const match = /(?:^|\s)z-(\d+)(?:\s|$)/.exec(element?.className ?? '');
      if (!match) throw new Error('Expected a z-* utility');
      return Number(match[1]);
    };
    await act(async () => {
      root.render(
        <SidebarScrollArea>
          <StandaloneChatsSidebarSection
            snapshot={state}
            selectedStandaloneChatId={null}
            onSelectChat={() => {}}
            testIds={testIds}
            headerPresentation="section"
            stickyHeader
          />
        </SidebarScrollArea>,
      );
      await Promise.resolve();
    });

    const header = container.querySelector(CHATS_HEADER_SELECTOR);
    expect(header?.className).toContain('sticky');
    expect(header?.className).toContain('bg-sidebar');
    expect(
      zTier(container.querySelector('[data-sidebar-scrollbar]')),
    ).toBeGreaterThan(zTier(header));
  });
});

/**
 * CAN-3053 slice 2e: the hoisted Chats section lists Work Entries through the
 * shared `WorkEntryRow`, as desktop's rail does, instead of one flat
 * provider-icon row per chat. The rows carry desktop's working spinner and
 * unread dot, which the flat rows never showed.
 */
describe('StandaloneChatsSidebarSection — Chats Work Entry rows', () => {
  let container: HTMLDivElement;
  let root: Root;

  const chatsWorkspace = {
    localId: 'cowork-default',
    name: 'Chats',
    type: 'cowork' as const,
    layout: 'flat' as const,
  };

  beforeEach(() => {
    setCoarsePointer(false);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.restoreAllMocks();
  });

  async function renderChats(
    standaloneChats: ComponentProps<
      typeof StandaloneChatsSidebarSection
    >['snapshot']['standaloneChats'],
    props: Partial<ComponentProps<typeof StandaloneChatsSidebarSection>> = {},
    workspace: ComponentProps<
      typeof StandaloneChatsSidebarSection
    >['workspace'] = chatsWorkspace,
  ): Promise<void> {
    await act(async () => {
      root.render(
        <StandaloneChatsSidebarSection
          snapshot={{ workspaces: [chatsWorkspace], standaloneChats }}
          workspace={workspace}
          headerPresentation="section"
          selectedStandaloneChatId={null}
          onSelectChat={() => {}}
          {...props}
        />,
      );
      await Promise.resolve();
    });
  }

  /** The row standing for `entryId`; throws when the section lists none. */
  function row(entryId: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-standalone-chat-id="${entryId}"]`,
    );
    if (!element) throw new Error(`No Chats row for ${entryId}`);
    return element;
  }

  function rowEntryIds(): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-standalone-chat-id]'),
    ).map((element) => element.getAttribute('data-standalone-chat-id') ?? '');
  }

  describe('empty section (CAN-3550)', () => {
    const emptyTestIds = { sectionEmpty: 'chats-empty' };
    const empty = (): HTMLElement | null =>
      container.querySelector('[data-testid="chats-empty"]');

    it('lists None found, the row an empty Projects list shows', async () => {
      await renderChats([], {
        listsNoneFoundWhenEmpty: true,
        testIds: emptyTestIds,
      });
      expect(empty()?.textContent).toBe('None found');
      expect(
        container.querySelector('[data-testid="chats-empty-label"]')
          ?.textContent,
      ).toBe('None found');
      // Inside the rows block the rail measures, and not a chat row: the
      // stuck header must not offer a way back to it.
      const content = container.querySelector(CHATS_CONTENT_SELECTOR);
      expect(content?.contains(empty())).toBe(true);
      expect(content?.querySelector('[data-sidebar-chat-row]')).toBeNull();
      // A block holding only this row does not announce itself as a list.
      expect(content?.getAttribute('role')).toBe('presentation');
    });

    it('lists a host-supplied line in place of None found', async () => {
      await renderChats([], {
        listsNoneFoundWhenEmpty: true,
        emptyLabel: 'Your chats show up here',
        testIds: emptyTestIds,
      });
      expect(empty()?.textContent).toBe('Your chats show up here');
      expect(
        container.querySelector('[data-testid="chats-empty-label"]')
          ?.textContent,
      ).toBe('Your chats show up here');
      expect(container.textContent).not.toContain('None found');
      // Still the None-found geometry: inside the measured rows block, no
      // chat row, and the block does not announce itself as a list.
      const content = container.querySelector(CHATS_CONTENT_SELECTOR);
      expect(content?.contains(empty())).toBe(true);
      expect(content?.getAttribute('role')).toBe('presentation');
    });

    it('ignores emptyLabel unless the section lists the None-found row', async () => {
      await renderChats([], {
        listsNoneFoundWhenEmpty: false,
        emptyLabel: 'Your chats show up here',
        testIds: emptyTestIds,
      });
      expect(empty()).toBeNull();
    });

    it('counts archived chats as nothing to list', async () => {
      await renderChats(
        [{ localId: 'archived', title: 'Archived', archived: true }],
        { listsNoneFoundWhenEmpty: true, testIds: emptyTestIds },
      );
      expect(empty()?.textContent).toBe('None found');
    });

    it('keeps the "+" at rest while the section lists nothing', async () => {
      // An empty Chats section otherwise reads as having no way to start a
      // chat; DESIGN.md: hover must not reveal required functionality.
      const restsVisible = (): boolean =>
        container
          .querySelector('[data-testid="chats-new"]')
          ?.closest('[class~="opacity-0"]') === null;
      await renderChats([], {
        onCreateChat: jest.fn(),
        testIds: { sectionCreateChat: 'chats-new' },
      });
      expect(restsVisible()).toBe(true);
      await renderChats([{ localId: 'chat', title: 'A chat' }], {
        onCreateChat: jest.fn(),
        testIds: { sectionCreateChat: 'chats-new' },
      });
      expect(restsVisible()).toBe(false);
      // A host drawing its own rows says whether they are empty.
      await renderChats([], {
        renderRows: () => null,
        rowsEmpty: false,
        onCreateChat: jest.fn(),
        testIds: { sectionCreateChat: 'chats-new' },
      });
      expect(restsVisible()).toBe(false);
      await renderChats([], {
        renderRows: () => null,
        rowsEmpty: true,
        onCreateChat: jest.fn(),
        testIds: { sectionCreateChat: 'chats-new' },
      });
      expect(restsVisible()).toBe(true);
    });

    it('lists nothing unless the host asks for the row', async () => {
      await renderChats([], { testIds: emptyTestIds });
      expect(empty()).toBeNull();
      expect(container.textContent).not.toContain('None found');
    });

    it('drops the row once a chat is listed', async () => {
      await renderChats(
        [
          {
            localId: 'chat',
            title: 'A chat',
            lastMessageAt: '2026-09-01T00:00:00.000Z',
          },
        ],
        { listsNoneFoundWhenEmpty: true, testIds: emptyTestIds },
      );
      expect(rowEntryIds()).toHaveLength(1);
      expect(empty()).toBeNull();
    });

    it('puts the row away with the collapsed section', async () => {
      await renderChats([], {
        listsNoneFoundWhenEmpty: true,
        collapsed: true,
        testIds: emptyTestIds,
      });
      expect(empty()).toBeNull();
    });

    it('leaves the emptiness rule to a host that renders its own rows', async () => {
      await renderChats([], {
        listsNoneFoundWhenEmpty: true,
        renderRows: () => <div data-testid="host-rows" />,
        testIds: emptyTestIds,
      });
      expect(
        container.querySelector('[data-testid="host-rows"]'),
      ).not.toBeNull();
      expect(empty()).toBeNull();
    });
  });

  it('shows the working spinner on the row of a chat with a turn in flight', async () => {
    await renderChats([
      {
        localId: 'chat-busy',
        projectLocalId: 'cowork-default',
        title: 'Busy',
        hasActiveChat: true,
      },
      { localId: 'chat-idle', projectLocalId: 'cowork-default', title: 'Idle' },
    ]);
    expect(
      row('chat-busy').querySelector(
        '[data-testid="portal-chats-work-entry-chat-busy-thinking"]',
      ),
    ).not.toBeNull();
    expect(row('chat-busy').querySelector('[aria-label="Working"]')).not.toBe(
      null,
    );
    expect(row('chat-idle').querySelector('[aria-label="Working"]')).toBe(null);
  });

  it('shows the unread dot on the row of a chat with unviewed output', async () => {
    await renderChats([
      {
        localId: 'chat-new',
        projectLocalId: 'cowork-default',
        title: 'Replied',
        hasUnread: true,
      },
      { localId: 'chat-read', projectLocalId: 'cowork-default', title: 'Read' },
    ]);
    expect(
      row('chat-new').querySelector(
        '[data-testid="portal-chats-work-entry-chat-new-unread"]',
      ),
    ).not.toBeNull();
    expect(
      row('chat-read').querySelector('[aria-label="Unread messages"]'),
    ).toBeNull();
  });

  it('keeps the dot off the chat the reader has open', async () => {
    await renderChats(
      [
        {
          localId: 'chat-open',
          projectLocalId: 'cowork-default',
          title: 'Open',
          hasUnread: true,
        },
      ],
      { selectedStandaloneChatId: 'chat-open' },
    );
    expect(
      row('chat-open').querySelector('[aria-label="Unread messages"]'),
    ).toBeNull();
    expect(row('chat-open').hasAttribute('data-sidebar-selected-item')).toBe(
      true,
    );
  });

  describe('notification choices (CAN-3615)', () => {
    const entryChat = {
      localId: 'chat-first',
      projectLocalId: 'cowork-default',
      title: 'First chat',
      workEntryId: 'entry-a',
      workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
      workEntryTitle: 'Research task',
    };

    it('offers no menu when the host cannot identify the entry space', async () => {
      await renderChats([entryChat], {
        workEntryNotifications: {
          getState: () => undefined,
          onOpen: jest.fn(),
          onSelect: jest.fn(),
        },
      });
      expect(row('entry-a').querySelector('[aria-label="More"]')).toBeNull();
    });

    it('refreshes on open and saves a choice for the entry', async () => {
      const onOpen = jest.fn();
      const onSelect = jest.fn();
      await renderChats([entryChat], {
        workEntryNotifications: {
          getState: () => ({
            status: 'ready',
            override: null,
          }),
          onOpen,
          onSelect,
        },
      });
      const more = row('entry-a').querySelector<HTMLButtonElement>(
        '[aria-label="More actions"]',
      );
      expect(more).not.toBeNull();
      expect(onOpen).not.toHaveBeenCalled();
      await act(async () => {
        more?.click();
        await Promise.resolve();
      });
      expect(onOpen).toHaveBeenCalledWith('cowork-default', 'entry-a');
      const choices = Array.from(
        document.body.querySelectorAll<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ),
      );
      expect(choices.map((choice) => choice.textContent)).toEqual([
        'All activity',
        'Needs my attention',
        'Mute',
      ]);
      expect(choices[0]?.getAttribute('aria-checked')).toBe('true');
      act(() => choices[2]?.click());
      expect(onSelect).toHaveBeenCalledWith(
        'cowork-default',
        'entry-a',
        'mute',
      );
    });

    it('refreshes once per open even when the host rebuilds its handlers', async () => {
      // Hosts rebuild the handlers whenever their store changes, and the
      // refresh itself changes the store. Re-running it on every new handler
      // identity loops for as long as the menu stays open.
      const onOpen = jest.fn();
      const handlers = (): ComponentProps<
        typeof StandaloneChatsSidebarSection
      >['workEntryNotifications'] => ({
        getState: () => ({ status: 'ready', override: null }),
        // A fresh callback each time, as a host's memoized handlers are.
        onOpen: (workspaceLocalId, workEntryId): void => {
          onOpen(workspaceLocalId, workEntryId);
        },
        onSelect: jest.fn(),
      });
      await renderChats([entryChat], { workEntryNotifications: handlers() });
      const more = row('entry-a').querySelector<HTMLButtonElement>(
        '[aria-label="More actions"]',
      );
      await act(async () => {
        more?.click();
        await Promise.resolve();
      });
      expect(onOpen).toHaveBeenCalledTimes(1);
      await renderChats([entryChat], { workEntryNotifications: handlers() });
      await renderChats([entryChat], { workEntryNotifications: handlers() });
      expect(
        document.body.querySelectorAll('[role="menuitemradio"]'),
      ).toHaveLength(3);
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });

  it('drops the leading provider icon and shows the done check', async () => {
    await renderChats([
      {
        localId: 'chat-done',
        projectLocalId: 'cowork-default',
        title: 'Finished',
        providerType: 'claude',
        workEntryId: 'entry-done',
        workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
        workEntryStatus: 'done',
        hasActiveChat: true,
        hasUnread: true,
      },
    ]);
    const done = row('entry-done');
    expect(done.getAttribute('data-entry-status')).toBe('done');
    expect(done.querySelector('[aria-label="Done"]')).not.toBeNull();
    // Done outranks the live status, as it does on desktop.
    expect(done.querySelector('[aria-label="Working"]')).toBeNull();
    expect(done.querySelector('[aria-label="Unread messages"]')).toBeNull();
    expect(container.querySelector('svg[class~="opacity-60"]')).toBeNull();
  });

  it('lists one row per Work Entry, labelled and opened as desktop does', async () => {
    const onSelectChat = jest.fn();
    await renderChats(
      [
        {
          localId: 'chat-first',
          projectLocalId: 'cowork-default',
          title: 'First chat',
          workEntryId: 'entry-a',
          workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
          workEntryTitle: 'Research task',
          lastMessageAt: '2026-09-01T10:00:00.000Z',
        },
        {
          localId: 'chat-second',
          projectLocalId: 'cowork-default',
          title: 'Second chat',
          workEntryId: 'entry-a',
          workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
          workEntryTitle: 'Research task',
          lastMessageAt: '2026-09-01T11:00:00.000Z',
          hasActiveChat: true,
        },
      ],
      { onSelectChat },
    );
    expect(rowEntryIds()).toEqual(['entry-a']);
    const entry = row('entry-a');
    expect(entry.textContent).toBe('Research task');
    expect(entry.querySelector('[aria-label="Working"]')).not.toBeNull();
    act(() => entry.click());
    // The entry opens its most recently active chat.
    expect(onSelectChat).toHaveBeenCalledWith('chat-second');
  });

  it('marks an entry selected while any of its chats is open, and keeps that chat on reopen', async () => {
    const onSelectChat = jest.fn();
    await renderChats(
      [
        {
          localId: 'chat-old',
          projectLocalId: 'cowork-default',
          title: 'Old',
          workEntryId: 'entry-a',
          workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-09-01T10:00:00.000Z',
        },
        {
          localId: 'chat-new',
          projectLocalId: 'cowork-default',
          title: 'New',
          workEntryId: 'entry-a',
          workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
          lastMessageAt: '2026-09-01T11:00:00.000Z',
        },
      ],
      { onSelectChat, selectedStandaloneChatId: 'chat-old' },
    );
    const entry = row('entry-a');
    expect(entry.className).toContain('bg-muted');
    expect(entry.closest('[data-selected]')).not.toBeNull();
    act(() => entry.click());
    expect(onSelectChat).toHaveBeenCalledWith('chat-old');
  });

  it.each<{ mode?: 'manual' }>([{ mode: 'manual' }, {}])(
    'orders desktop entries manually, including legacy absence: $mode',
    async ({ mode }) => {
      await renderChats(
        [
          {
            localId: 'c1',
            projectLocalId: 'cowork-default',
            title: 'Second slot',
            workEntryId: 'e1',
            workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
            workEntryOrder: 1,
            lastMessageAt: '2026-09-01T12:00:00.000Z',
          },
          {
            localId: 'c0',
            projectLocalId: 'cowork-default',
            title: 'First slot',
            workEntryId: 'e0',
            workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
            workEntryOrder: 0,
            lastMessageAt: '2026-09-01T09:00:00.000Z',
          },
          {
            localId: 'cp',
            projectLocalId: 'cowork-default',
            title: 'Pinned',
            workEntryId: 'ep',
            workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
            workEntryOrder: 2,
            workEntryPinned: true,
          },
        ],
        {},
        { ...chatsWorkspace, itemSortMode: mode },
      );
      expect(rowEntryIds()).toEqual(['ep', 'e0', 'e1']);
    },
  );

  it.each<{ itemSortMode?: 'last-updated'; backend?: 'cloud' }>([
    { itemSortMode: 'last-updated' },
    { backend: 'cloud' },
  ])(
    'orders entries by recency for explicit or cloud-default modes: %j',
    async (mode) => {
      await renderChats(
        [
          {
            localId: 'c1',
            projectLocalId: 'cowork-default',
            title: 'Older',
            workEntryId: 'e1',
            workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
            workEntryOrder: 0,
            lastMessageAt: '2026-09-01T09:00:00.000Z',
          },
          {
            localId: 'c0',
            projectLocalId: 'cowork-default',
            title: 'Newer',
            workEntryId: 'e0',
            workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
            workEntryOrder: 1,
            lastMessageAt: '2026-09-01T12:00:00.000Z',
          },
        ],
        {},
        { ...chatsWorkspace, ...mode },
      );
      expect(rowEntryIds()).toEqual(['e0', 'e1']);
    },
  );

  it('offers no row actions, since the portal cannot run them', async () => {
    await renderChats([
      { localId: 'chat-a', projectLocalId: 'cowork-default', title: 'A' },
    ]);
    const entry = row('chat-a');
    expect(entry.querySelector('button')).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="portal-chats-work-entry-chat-a-menu"]',
      ),
    ).toBeNull();
  });

  it('caps the section by entries and counts entries behind Show all', async () => {
    await renderChats(
      Array.from({ length: 7 }, (_unused, index) => ({
        localId: `chat-${index}`,
        projectLocalId: 'cowork-default',
        title: `Chat ${index}`,
        workEntryId: `entry-${Math.floor(index / 2)}`,
        workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
      })),
      {
        maxEntries: 2,
        testIds: { sectionShowAll: 'show-all' },
      },
    );
    expect(rowEntryIds()).toEqual(['entry-0', 'entry-1']);
    const showAll = container.querySelector<HTMLButtonElement>(
      '[data-testid="show-all"]',
    );
    expect(showAll?.getAttribute('aria-label')).toBe('Show all 4 chats');
    act(() => showAll?.click());
    expect(rowEntryIds()).toEqual(['entry-0', 'entry-1', 'entry-2', 'entry-3']);
  });

  it('offers Show all when only a kept empty group is beyond the Chats cap', async () => {
    await renderChats(
      [{ localId: 'chat-a', projectLocalId: 'cowork-default', title: 'A' }],
      { maxEntries: 1, testIds: { sectionShowAll: 'show-all' } },
      {
        ...chatsWorkspace,
        itemGroups: [
          {
            id: 'grp-empty',
            name: 'Kept',
            color: 'neutral',
            collapsed: false,
            memberIds: [],
            keepWhenEmpty: true,
          },
        ],
      },
    );
    expect(
      container.querySelector('[data-sidebar-item-group-id="grp-empty"]'),
    ).toBeNull();
    const showAll = container.querySelector<HTMLButtonElement>(
      '[data-testid="show-all"]',
    );
    expect(showAll).not.toBeNull();
    act(() => showAll?.click());
    expect(
      container.querySelector('[data-sidebar-item-group-id="grp-empty"]'),
    ).not.toBeNull();
  });

  it('keeps the rows touch-sized in the drawer', async () => {
    await renderChats(
      [{ localId: 'chat-a', projectLocalId: 'cowork-default', title: 'A' }],
      { touchTargets: true },
    );
    expect(row('chat-a').className).toContain('min-h-11');
    expect(row('chat-a').className).not.toContain(' h-8');
  });

  it('keeps host row ids and the chats-row mark on the row frame', async () => {
    await renderChats(
      [
        {
          localId: 'chat-a',
          projectLocalId: 'cowork-default',
          title: 'A',
          workEntryId: 'entry-a',
          workEntryLastMessageAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      { testIds: { chatRow: (id) => `host-chat-${id}` } },
    );
    const frame = container.querySelector('[data-testid="host-chat-chat-a"]');
    expect(frame?.contains(row('entry-a'))).toBe(true);
    expect(frame?.hasAttribute('data-sidebar-chat-row')).toBe(true);
  });

  // A collapsed project keeps exactly its selected row under its header
  // (desktop's ProjectSection and cowork rows). The Chats section dropped
  // every row on a collapse, so the open chat vanished from the rail.
  describe('collapsed', () => {
    const chats = Array.from({ length: 7 }, (_unused, index) => ({
      localId: `chat-${index}`,
      projectLocalId: 'cowork-default',
      title: `Chat ${index}`,
      workEntryId: `entry-${index}`,
      workEntryLastMessageAt: `2026-01-0${7 - index}T00:00:00.000Z`,
    }));

    it('keeps only the selected chat, even one behind Show all', async () => {
      await renderChats(chats, {
        collapsed: true,
        maxEntries: 2,
        selectedStandaloneChatId: 'chat-5',
        testIds: { sectionShowAll: 'show-all' },
      });
      expect(rowEntryIds()).toEqual(['entry-5']);
      expect(row('entry-5').closest('[data-selected]')).not.toBeNull();
      expect(container.querySelector('[data-testid="show-all"]')).toBeNull();
      // Still the rail's Chats block, so it masks and pins like the list.
      const content = container.querySelector(CHATS_CONTENT_SELECTOR);
      expect(content?.contains(row('entry-5'))).toBe(true);
    });

    it('renders no rows block when nothing in Chats is selected', async () => {
      await renderChats(chats, {
        collapsed: true,
        selectedStandaloneChatId: 'elsewhere',
      });
      expect(rowEntryIds()).toEqual([]);
      expect(container.querySelector(CHATS_CONTENT_SELECTOR)).toBeNull();
    });

    it('restores the full list on expand', async () => {
      await renderChats(chats, {
        collapsed: true,
        maxEntries: 3,
        selectedStandaloneChatId: 'chat-1',
      });
      expect(rowEntryIds()).toEqual(['entry-1']);
      await renderChats(chats, {
        collapsed: false,
        maxEntries: 3,
        selectedStandaloneChatId: 'chat-1',
      });
      expect(rowEntryIds()).toEqual(['entry-0', 'entry-1', 'entry-2']);
    });

    it('asks host rows for their collapsed form only when they hold the selection', async () => {
      const renderRows = jest.fn(
        ({ collapsed }: { readonly collapsed: boolean }) => (
          <div data-testid="host-rows" data-collapsed={String(collapsed)} />
        ),
      );
      await renderChats([], {
        collapsed: true,
        renderRows,
        hasSelectedRow: false,
      });
      expect(container.querySelector('[data-testid="host-rows"]')).toBeNull();
      expect(container.querySelector(CHATS_CONTENT_SELECTOR)).toBeNull();

      await renderChats([], {
        collapsed: true,
        renderRows,
        hasSelectedRow: true,
      });
      expect(
        container
          .querySelector('[data-testid="host-rows"]')
          ?.getAttribute('data-collapsed'),
      ).toBe('true');

      await renderChats([], {
        collapsed: false,
        renderRows,
        hasSelectedRow: true,
      });
      expect(
        container
          .querySelector('[data-testid="host-rows"]')
          ?.getAttribute('data-collapsed'),
      ).toBe('false');
    });

    // Scrolled past the section, a collapsed header is stuck over its one
    // kept row exactly as an expanded header is stuck over its list, and must
    // act the same: a click goes back to Chats rather than expanding them.
    describe('while the header is stuck', () => {
      function withBottom(element: Element | null, bottom: number): void {
        if (!(element instanceof HTMLElement)) {
          throw new Error('missing element');
        }
        element.getBoundingClientRect = (): DOMRect =>
          new DOMRect(0, bottom - 28, 200, 28);
      }

      async function renderStuckCollapsed(contentBottom: number): Promise<{
        toggle: HTMLButtonElement;
        onCollapsedChange: jest.Mock;
        scrollTo: jest.Mock;
      }> {
        const onCollapsedChange = jest.fn();
        // The container stands in for the rail's scrolling viewport.
        container.setAttribute('data-sidebar-viewport', '');
        const scrollTo = jest.fn();
        container.scrollTo = scrollTo;
        await renderChats(chats, {
          collapsed: true,
          onCollapsedChange,
          stickyHeader: true,
          selectedStandaloneChatId: 'chat-5',
          testIds: { sectionToggle: 'chats-toggle' },
        });
        const header = container.querySelector(CHATS_HEADER_SELECTOR);
        withBottom(header, 80);
        withBottom(
          container.querySelector(CHATS_CONTENT_SELECTOR),
          contentBottom,
        );
        await act(async () => {
          header?.setAttribute('data-sidebar-chats-stuck', 'true');
          // MutationObserver callbacks are delivered as microtasks.
          await Promise.resolve();
        });
        const toggle = container.querySelector<HTMLButtonElement>(
          '[data-testid="chats-toggle"]',
        );
        if (!toggle) throw new Error('missing Chats toggle');
        return { toggle, onCollapsedChange, scrollTo };
      }

      it('announces the way back, as the expanded header does', async () => {
        const { toggle } = await renderStuckCollapsed(40);
        expect(toggle.getAttribute('aria-expanded')).toBeNull();
        expect(toggle.getAttribute('aria-label')).toBe('Back to Chats');
        expect(
          container
            .querySelector('[data-testid="sidebar-chats-chevron"]')
            ?.getAttribute('class'),
        ).toContain('rotate-180');
      });

      it('scrolls back to Chats instead of expanding', async () => {
        const { toggle, onCollapsedChange, scrollTo } =
          await renderStuckCollapsed(40);
        act(() => toggle.click());
        expect(scrollTo).toHaveBeenCalledWith(
          expect.objectContaining({ top: 0 }),
        );
        expect(onCollapsedChange).not.toHaveBeenCalled();
        expect(rowEntryIds()).toEqual(['entry-5']);
      });

      it('expands once the kept row is back in view', async () => {
        const { toggle, onCollapsedChange, scrollTo } =
          await renderStuckCollapsed(120);
        act(() => toggle.click());
        expect(scrollTo).not.toHaveBeenCalled();
        expect(onCollapsedChange).toHaveBeenCalledWith(false);
      });
    });
  });
});
