/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  orgDefaultCoworkWorkspaceId,
  type CoworkWorkEntryMeta,
  type SidebarItem,
} from '@canopy/desktop-shared/types';
import { useCanopyOrgProjectsEnabled } from '@/hooks/useCanopyOrgProjectsEnabled';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useSidebarStore } from '@/stores/sidebarStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { useImportSessionModalStore } from '@/stores/importSessionModalStore';
import {
  CHATS_SECTION_VISIBLE_ENTRIES,
  SidebarChatsSection,
} from '../SidebarChatsSection';
import {
  CHATS_SELECTED_ITEM_FLOW_SELECTOR,
  CHATS_SELECTED_PIN_SELECTOR,
  SELECTED_ITEM_FLOW_SELECTOR,
} from '@canopy/ui-app/sidebar';

jest.mock('@/hooks/useCanopyOrgProjectsEnabled', () => ({
  useCanopyOrgProjectsEnabled: jest.fn((): boolean => true),
}));

jest.mock('@/components/shared/InviteTeammateModal', () => ({
  InviteTeammateModal: (): JSX.Element | null => null,
}));

const ensureOrgDefaultCoworkWorkspace = jest.fn().mockResolvedValue(undefined);
const getOrgDefaultCoworkEligibility = jest.fn().mockResolvedValue('eligible');

function installWindowApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      savePreferences: jest.fn().mockResolvedValue(undefined),
      saveProjects: jest.fn().mockResolvedValue(undefined),
      chatProject: {
        ensureOrgDefaultCoworkWorkspace,
        getOrgDefaultCoworkEligibility,
      },
      workEntries: {
        list: jest.fn().mockResolvedValue({ entries: [] }),
        reorder: jest.fn().mockResolvedValue(undefined),
      },
      standaloneChat: { list: jest.fn().mockResolvedValue({ chats: [] }) },
      chat: { flushScope: jest.fn().mockResolvedValue(undefined) },
      getWorktreeArchiveDisposition: jest
        .fn()
        .mockResolvedValue({ hasArchivableData: false }),
    },
  });
}

/** Named like the real catch-all — the header renders the stored name. */
function makeCoworkProject(id: string, name = 'Chats'): SidebarItem {
  return {
    id,
    type: 'cowork',
    name,
    color: '#654321',
    collapsed: false,
    order: 0,
  };
}

function makeEntries(count: number): CoworkWorkEntryMeta[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `entry-${index + 1}`,
    title: `Chat ${index + 1}`,
    createdAt: `2026-07-0${(index % 9) + 1}T10:00:00.000Z`,
    lastMessageAt: `2026-07-0${(index % 9) + 1}T11:00:00.000Z`,
    status: 'active',
  }));
}

async function renderChats(): Promise<{
  container: HTMLElement;
  root: Root;
}> {
  installWindowApi();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<SidebarChatsSection />);
    await Promise.resolve();
  });
  return { container, root };
}

function unmount(root: Root, container: HTMLElement): void {
  act(() => root.unmount());
  container.remove();
}

function seed(entryCount: number): void {
  useProjectsStore.setState({
    projects: [makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID)],
  });
  useStandaloneChatStore.setState({
    activeChatProjectId: DEFAULT_COWORK_WORKSPACE_ID,
    workEntries: makeEntries(entryCount),
  });
}

/**
 * Every command row in a sidebar menu carries a leading glyph. Ordering rows
 * are radios whose leading rail is the selection check, so they are exempt.
 */
function expectMenuCommandRowsHaveIcons(menu: HTMLElement | null): void {
  expect(menu).not.toBeNull();
  const rows = Array.from(
    menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.querySelector('svg')).not.toBeNull();
  }
}

describe('SidebarChatsSection', () => {
  beforeEach(() => {
    ensureOrgDefaultCoworkWorkspace.mockReset().mockResolvedValue(undefined);
    getOrgDefaultCoworkEligibility.mockReset().mockResolvedValue('eligible');
    jest.mocked(useCanopyOrgProjectsEnabled).mockReturnValue(true);
    const accountEpoch = useWorkspaceContextStore.getState().accountEpoch + 1;
    useWorkspaceContextStore.setState({
      hydrated: true,
      accountEpoch,
      state: { context: { kind: 'personal' }, revision: 0, organizations: [] },
    });
    useSidebarStore.setState({ chatsSectionCollapsed: false });
    useNavigationStore.setState({
      activePage: 'main',
      workspaceSettingsModalOpen: false,
      pendingWorkspaceSettings: undefined,
    });
    useImportSessionModalStore.setState({ target: undefined });
    seed(0);
  });

  it('renders an empty pending org Chats section instead of Personal chats', async (): Promise<void> => {
    seed(3);
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: 'acme' },
        revision: 1,
        organizations: [],
      },
    });
    const { container, root } = await renderChats();
    try {
      expect(
        container.querySelector('[data-testid="sidebar-section-chats"]'),
      ).not.toBeNull();
      expect(
        container.querySelectorAll('[data-standalone-chat-id]'),
      ).toHaveLength(0);
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-section-chats-settings"]',
        )?.disabled,
      ).toBe(true);
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-section-chats-more"]',
        )?.disabled,
      ).toBe(true);
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-section-chats-new-chat"]',
        )?.disabled,
      ).toBe(false);
      // A Chats workspace that does not exist yet has no chats (CAN-3550).
      expect(
        container.querySelector(
          `[data-testid="sidebar-cowork-project-${orgDefaultCoworkWorkspaceId('acme')}-empty"]`,
        )?.textContent,
      ).toBe('None found');
    } finally {
      unmount(root, container);
    }
  });

  it('renders an org Chats placeholder while local eligibility is pending', async (): Promise<void> => {
    let resolveEligibility!: (value: 'eligible') => void;
    getOrgDefaultCoworkEligibility.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveEligibility = resolve;
        }),
    );
    useProjectsStore.setState({ projects: [] });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: 'acme-pending' },
        revision: 1,
        organizations: [],
      },
    });

    const { container, root } = await renderChats();
    try {
      expect(
        container.querySelector('[data-testid="sidebar-section-chats"]'),
      ).not.toBeNull();

      await act(async () => {
        resolveEligibility('eligible');
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });

      expect(
        container.querySelector('[data-testid="sidebar-section-chats"]'),
      ).not.toBeNull();
    } finally {
      unmount(root, container);
    }
  });

  it('removes the pending section after a permanent eligibility rejection', async (): Promise<void> => {
    useProjectsStore.setState({ projects: [] });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: 'acme' },
        revision: 1,
        organizations: [],
      },
    });
    ensureOrgDefaultCoworkWorkspace.mockRejectedValueOnce(
      new Error('not found'),
    );
    getOrgDefaultCoworkEligibility.mockResolvedValue('ineligible');
    const { container, root } = await renderChats();
    try {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(
        container.querySelector('[data-testid="sidebar-section-chats"]'),
      ).toBeNull();
    } finally {
      unmount(root, container);
    }
  });

  it('removes an existing org Chats section when the org is known ineligible', async (): Promise<void> => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = orgDefaultCoworkWorkspaceId(organizationId);
    useProjectsStore.setState({ projects: [makeCoworkProject(workspaceId)] });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId },
        revision: 1,
        organizations: [],
      },
    });
    getOrgDefaultCoworkEligibility.mockResolvedValue('ineligible');

    const { container, root } = await renderChats();
    try {
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
      expect(getOrgDefaultCoworkEligibility).toHaveBeenCalledWith(
        organizationId,
      );
      expect(
        container.querySelector('[data-testid="sidebar-section-chats"]'),
      ).toBeNull();
      expect(ensureOrgDefaultCoworkWorkspace).not.toHaveBeenCalled();
    } finally {
      unmount(root, container);
    }
  });

  it('updates the pending section in place when the real workspace arrives', async (): Promise<void> => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = orgDefaultCoworkWorkspaceId(organizationId);
    useProjectsStore.setState({ projects: [] });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId },
        revision: 1,
        organizations: [],
      },
    });
    const { container, root } = await renderChats();
    try {
      const pendingHeader = container.querySelector(
        '[data-testid="sidebar-section-chats"]',
      );
      expect(pendingHeader).not.toBeNull();
      await act(async () => {
        useProjectsStore.setState({
          projects: [makeCoworkProject(workspaceId)],
        });
        await Promise.resolve();
      });
      expect(
        container.querySelector('[data-testid="sidebar-section-chats"]'),
      ).toBe(pendingHeader);
      expect(
        container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-section-chats-settings"]',
        )?.disabled,
      ).toBe(false);
    } finally {
      unmount(root, container);
    }
  });

  it("shows this organization's Chats, not Personal's or another organization's", async (): Promise<void> => {
    const orgA = '11111111-1111-4111-8111-111111111111';
    const orgB = '22222222-2222-4222-8222-222222222222';
    const orgADefault = orgDefaultCoworkWorkspaceId(orgA);
    useProjectsStore.setState({
      projects: [
        makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID),
        makeCoworkProject(orgADefault),
      ],
    });
    useStandaloneChatStore.setState({
      activeChatProjectId: orgADefault,
      workEntries: makeEntries(2),
    });
    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: orgA },
        revision: 1,
        organizations: [],
      },
    });
    const first = await renderChats();
    try {
      expect(
        first.container.querySelector('[data-testid="sidebar-section-chats"]'),
      ).not.toBeNull();
      expect(
        first.container.querySelectorAll('[data-standalone-chat-id]'),
      ).toHaveLength(2);
    } finally {
      unmount(first.root, first.container);
    }

    useWorkspaceContextStore.setState({
      state: {
        context: { kind: 'organization', organizationId: orgB },
        revision: 2,
        organizations: [],
      },
    });
    const second = await renderChats();
    try {
      expect(
        second.container.querySelector('[data-testid="sidebar-section-chats"]'),
      ).not.toBeNull();
      expect(
        second.container.querySelectorAll('[data-standalone-chat-id]'),
      ).toHaveLength(0);
    } finally {
      unmount(second.root, second.container);
    }
  });

  it.each([
    { name: 'Personal', organization: false, enabled: true, hydrated: true },
    { name: 'flag off', organization: true, enabled: false, hydrated: true },
    { name: 'unhydrated', organization: true, enabled: true, hydrated: false },
  ])(
    'preserves populated chats with $name',
    async ({ organization, enabled, hydrated }): Promise<void> => {
      seed(3);
      jest.mocked(useCanopyOrgProjectsEnabled).mockReturnValue(enabled);
      useWorkspaceContextStore.setState({
        hydrated,
        state: {
          context: organization
            ? { kind: 'organization', organizationId: 'acme' }
            : { kind: 'personal' },
          revision: 1,
          organizations: [],
        },
      });
      const { container, root } = await renderChats();
      try {
        expect(
          container.querySelector('[data-testid="sidebar-section-chats"]'),
        ).not.toBeNull();
        expect(
          container.querySelectorAll('[data-standalone-chat-id]'),
        ).toHaveLength(3);
      } finally {
        unmount(root, container);
      }
    },
  );

  it('renders nothing without a default cowork workspace', async () => {
    useProjectsStore.setState({ projects: [] });
    const { container, root } = await renderChats();
    expect(
      container.querySelector('[data-testid="sidebar-section-chats"]'),
    ).toBeNull();
    unmount(root, container);
  });

  // The rail's scroll sync publishes `data-sidebar-chats-stuck` on the header
  // when every chat row has passed behind it. The header mirrors that mark so
  // the control can stop announcing itself as a disclosure and say what it
  // actually does. Both cases below are about the mirroring being ATTACHED —
  // the click path measures live and is unaffected, so a detached observer
  // fails silently, with assistive technology getting the stale promise.
  async function setStuckMark(
    container: HTMLElement,
    stuck: boolean,
  ): Promise<void> {
    const header = container.querySelector(
      '[data-testid="sidebar-section-chats"]',
    );
    if (!header) throw new Error('chats header not rendered');
    await act(async () => {
      if (stuck) header.setAttribute('data-sidebar-chats-stuck', 'true');
      else header.removeAttribute('data-sidebar-chats-stuck');
      // MutationObserver callbacks are delivered as microtasks.
      await Promise.resolve();
    });
  }

  it('mirrors the stuck mark into the toggle when mounted with the workspace', async () => {
    seed(3);
    const { container, root } = await renderChats();
    const toggle = container.querySelector(
      '[data-testid="sidebar-section-chats-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    await setStuckMark(container, true);
    // Not a disclosure while stuck: it says what it does instead of promising
    // a state change that activation will not make.
    expect(toggle?.getAttribute('aria-expanded')).toBeNull();
    expect(toggle?.getAttribute('aria-label')).toMatch(/^Back to /);

    await setStuckMark(container, false);
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBeNull();
    unmount(root, container);
  });

  it('mirrors the stuck mark after a null -> rendered transition', async () => {
    // `projectsStore` starts at `{ projects: [], isLoading: false }` and
    // `loadProjects({ silent: true })` never flips `isLoading`, so a silent
    // refresh can introduce the default cowork workspace without this
    // component ever unmounting. An observer attached only on first mount
    // would stay detached through exactly that transition.
    useProjectsStore.setState({ projects: [] });
    const { container, root } = await renderChats();
    expect(
      container.querySelector('[data-testid="sidebar-section-chats"]'),
    ).toBeNull();

    await act(async () => {
      seed(3);
      await Promise.resolve();
    });

    const toggle = container.querySelector(
      '[data-testid="sidebar-section-chats-toggle"]',
    );
    expect(toggle).not.toBeNull();
    await setStuckMark(container, true);
    expect(toggle?.getAttribute('aria-label')).toMatch(/^Back to /);
    expect(toggle?.getAttribute('aria-expanded')).toBeNull();
    unmount(root, container);
  });

  it('still offers the "+" while the bucket is empty', async () => {
    // On a fresh install this header is the only entry point to the bucket
    // besides the New task page, so it renders even with nothing in it.
    seed(0);
    const { container, root } = await renderChats();
    expect(
      container.querySelector('[data-testid="sidebar-section-chats"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="sidebar-section-chats-new-chat"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('[data-standalone-chat-id]'),
    ).toHaveLength(0);
    // Personal's empty Chats lists nothing, as its empty Projects does.
    expect(container.textContent).not.toContain('None found');
    unmount(root, container);
  });

  describe('an empty organization Chats (CAN-3550)', () => {
    const organizationId = '11111111-1111-4111-8111-111111111111';
    const workspaceId = orgDefaultCoworkWorkspaceId(organizationId);
    const emptyRow = (container: HTMLElement): HTMLElement | null =>
      container.querySelector(
        `[data-testid="sidebar-cowork-project-${workspaceId}-empty"]`,
      );

    function seedOrganization(
      workspace: Partial<SidebarItem>,
      entries: CoworkWorkEntryMeta[],
    ): void {
      useProjectsStore.setState({
        projects: [
          makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID),
          { ...makeCoworkProject(workspaceId), ...workspace } as SidebarItem,
        ],
      });
      useStandaloneChatStore.setState({
        activeChatProjectId: workspaceId,
        workEntries: entries,
      });
      useWorkspaceContextStore.setState({
        state: {
          context: { kind: 'organization', organizationId },
          revision: 1,
          organizations: [],
        },
      });
    }

    it('lists None found, the row an empty Projects list shows', async () => {
      seedOrganization({ workEntryCount: 0 }, []);
      const { container, root } = await renderChats();
      try {
        expect(emptyRow(container)?.textContent).toBe('None found');
        expect(
          container.querySelector(
            `[data-testid="sidebar-cowork-project-${workspaceId}-empty-label"]`,
          )?.textContent,
        ).toBe('None found');
        // Inside the rows block the rail measures.
        expect(
          container
            .querySelector('[data-testid="sidebar-section-chats-content"]')
            ?.contains(emptyRow(container)),
        ).toBe(true);
      } finally {
        unmount(root, container);
      }
    });

    it('lists it for an entry that has no messages yet', async () => {
      // The "+" makes an empty entry, which stays out of the list.
      seedOrganization({ workEntryCount: 1 }, [
        {
          id: 'entry-empty',
          title: 'New chat',
          createdAt: '2026-07-01T10:00:00.000Z',
          status: 'active',
        },
      ]);
      const { container, root } = await renderChats();
      try {
        expect(
          container.querySelectorAll('[data-standalone-chat-id]'),
        ).toHaveLength(0);
        expect(emptyRow(container)?.textContent).toBe('None found');
      } finally {
        unmount(root, container);
      }
    });

    it('waits for chats that main counts but the list has not loaded', async () => {
      seedOrganization({ workEntryCount: 2 }, []);
      const { container, root } = await renderChats();
      try {
        expect(emptyRow(container)).toBeNull();
        expect(container.textContent).not.toContain('None found');
      } finally {
        unmount(root, container);
      }
    });

    it('drops the row once a chat is listed', async () => {
      seedOrganization({ workEntryCount: 2 }, makeEntries(2));
      const { container, root } = await renderChats();
      try {
        expect(
          container.querySelectorAll('[data-standalone-chat-id]'),
        ).toHaveLength(2);
        expect(emptyRow(container)).toBeNull();
      } finally {
        unmount(root, container);
      }
    });

    it('puts the row away with the collapsed section', async () => {
      seedOrganization({ workEntryCount: 0 }, []);
      useSidebarStore.setState({ chatsSectionCollapsed: true });
      const { container, root } = await renderChats();
      try {
        expect(emptyRow(container)).toBeNull();
      } finally {
        unmount(root, container);
      }
    });
  });

  it('lists the default workspace entries without a workspace header', async () => {
    seed(3);
    const { container, root } = await renderChats();

    expect(container.textContent).toContain('Chats');
    expect(
      container.querySelector(
        `[data-testid="sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}-header"]`,
      ),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-standalone-chat-id]'),
    ).toHaveLength(3);

    unmount(root, container);
  });

  it('caps the list and reveals the rest behind Show all', async () => {
    const total = CHATS_SECTION_VISIBLE_ENTRIES + 4;
    seed(total);
    const { container, root } = await renderChats();

    expect(
      container.querySelectorAll('[data-standalone-chat-id]'),
    ).toHaveLength(CHATS_SECTION_VISIBLE_ENTRIES);

    const showAll = container.querySelector<HTMLButtonElement>(
      `[data-testid="sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}-show-all"]`,
    );
    // Label and count are separate elements now: the count sits in the
    // workspace-row counter's trailing slot rather than inside the label.
    expect(showAll?.textContent).toContain('Show all');
    expect(showAll?.getAttribute('aria-label')).toBe(`Show all ${total} chats`);
    expect(
      container.querySelector(
        `[data-testid="sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}-show-all-count"]`,
      )?.textContent,
    ).toBe(String(total));

    act(() => showAll?.click());
    expect(
      container.querySelectorAll('[data-standalone-chat-id]'),
    ).toHaveLength(total);

    const showLess = container.querySelector<HTMLButtonElement>(
      `[data-testid="sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}-show-all"]`,
    );
    expect(showLess?.textContent).toContain('Show fewer');
    // Chevron flips to the open direction once the rest is on screen.
    expect(
      container
        .querySelector(
          `[data-testid="sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}-show-all-chevron"]`,
        )
        ?.getAttribute('class'),
    ).not.toContain('-rotate-90');
    act(() => showLess?.click());
    expect(
      container.querySelectorAll('[data-standalone-chat-id]'),
    ).toHaveLength(CHATS_SECTION_VISIBLE_ENTRIES);

    unmount(root, container);
  });

  it('offers no Show all while the list fits', async () => {
    seed(CHATS_SECTION_VISIBLE_ENTRIES);
    const { container, root } = await renderChats();
    expect(
      container.querySelector(
        `[data-testid="sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}-show-all"]`,
      ),
    ).toBeNull();
    unmount(root, container);
  });

  it('shows a renamed catch-all name in the header', async () => {
    seed(1);
    useProjectsStore.setState({
      projects: [
        makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID, 'Acme secret project'),
      ],
    });
    const { container, root } = await renderChats();

    const label = Array.from(
      container.querySelectorAll(
        '[data-testid="sidebar-section-chats-toggle"] span',
      ),
    ).find((span) => span.textContent === 'Acme secret project');
    expect(label).toBeDefined();

    unmount(root, container);
  });

  it('shows the default Chats header label', async () => {
    seed(1);
    const { container, root } = await renderChats();

    const toggle = container.querySelector(
      '[data-testid="sidebar-section-chats-toggle"]',
    );
    expect(toggle?.textContent).toContain('Chats');

    unmount(root, container);
  });

  it('collapses from the header toggle and persists the preference', async () => {
    seed(2);
    const { container, root } = await renderChats();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-chats-toggle"]',
    );
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');

    act(() => toggle?.click());
    expect(useSidebarStore.getState().chatsSectionCollapsed).toBe(true);
    expect(window.api.savePreferences).toHaveBeenCalledWith({
      sidebarCoworkSectionCollapsed: true,
    });
    expect(
      container.querySelector('[data-testid="sidebar-section-chats-content"]'),
    ).toBeNull();

    unmount(root, container);
  });

  it('keeps only the selected chat while collapsed, as a collapsed project does', async () => {
    // The selected entry sits past the cap: a collapse must not hide it, and
    // must not bring the rest of the list with it.
    seed(CHATS_SECTION_VISIBLE_ENTRIES + 2);
    // The oldest entry: last by recency, behind Show all.
    const selectedId = 'entry-1';
    useStandaloneChatStore.setState({ activeWorkEntryId: selectedId });
    useNavigationStore.setState({ activePage: 'chat' });
    useSidebarStore.setState({ chatsSectionCollapsed: true });
    const { container, root } = await renderChats();

    const content = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-section-chats-content"]',
    );
    expect(content).not.toBeNull();
    expect(
      Array.from(
        content?.querySelectorAll('[data-standalone-chat-id]') ?? [],
      ).map((row) => row.getAttribute('data-standalone-chat-id')),
    ).toEqual([selectedId]);
    // Still the row the Chats pin measures, so it seats under the header.
    expect(
      Array.from(
        container.querySelectorAll(CHATS_SELECTED_ITEM_FLOW_SELECTOR),
      ).map((row) => row.getAttribute('data-testid')),
    ).toEqual([`sidebar-work-entry-${selectedId}`]);
    expect(
      container.querySelector(
        `[data-testid="sidebar-cowork-project-${DEFAULT_COWORK_WORKSPACE_ID}-show-all"]`,
      ),
    ).toBeNull();

    // Off the chat page nothing in Chats is selected: nothing stays.
    act(() => useNavigationStore.setState({ activePage: 'main' }));
    expect(
      container.querySelector('[data-testid="sidebar-section-chats-content"]'),
    ).toBeNull();

    // Expanding restores the capped list.
    act(() => {
      useNavigationStore.setState({ activePage: 'chat' });
      useSidebarStore.setState({ chatsSectionCollapsed: false });
    });
    const expanded = container.querySelector<HTMLElement>(
      '[data-testid="sidebar-section-chats-content"]',
    );
    expect(
      expanded?.querySelectorAll('[data-standalone-chat-id]').length,
    ).toBeGreaterThan(1);

    unmount(root, container);
  });

  // Scrolled past the section, a collapsed header is stuck over its one kept
  // row exactly as an expanded header is stuck over its list, and must act
  // the same: announce the way back, and take it instead of expanding.
  it.each([
    { name: 'scrolls back to Chats while stuck', contentBottom: 40 },
    { name: 'expands once the kept row is in view', contentBottom: 120 },
  ])(
    'collapsed with the selected chat: $name',
    async ({ contentBottom }): Promise<void> => {
      seed(CHATS_SECTION_VISIBLE_ENTRIES + 2);
      useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-1' });
      useNavigationStore.setState({ activePage: 'chat' });
      useSidebarStore.setState({ chatsSectionCollapsed: true });
      const { container, root } = await renderChats();
      try {
        // The container stands in for the rail's scrolling viewport.
        container.setAttribute('data-sidebar-viewport', '');
        const scrollTo = jest.fn();
        container.scrollTo = scrollTo;
        const withBottom = (element: Element | null, bottom: number): void => {
          if (!(element instanceof HTMLElement)) {
            throw new Error('missing element');
          }
          element.getBoundingClientRect = (): DOMRect =>
            new DOMRect(0, bottom - 28, 200, 28);
        };
        withBottom(
          container.querySelector('[data-testid="sidebar-section-chats"]'),
          80,
        );
        withBottom(
          container.querySelector(
            '[data-testid="sidebar-section-chats-content"]',
          ),
          contentBottom,
        );
        const stuck = contentBottom < 80;
        await setStuckMark(container, stuck);
        const toggle = container.querySelector<HTMLButtonElement>(
          '[data-testid="sidebar-section-chats-toggle"]',
        );
        if (!toggle) throw new Error('missing Chats toggle');
        if (stuck) {
          expect(toggle.getAttribute('aria-expanded')).toBeNull();
          expect(toggle.getAttribute('aria-label')).toBe('Back to Chats');
          expect(
            container
              .querySelector('[data-testid="sidebar-chats-chevron"]')
              ?.getAttribute('class'),
          ).toContain('rotate-180');
        } else {
          expect(toggle.getAttribute('aria-expanded')).toBe('false');
        }

        act(() => toggle.click());
        if (stuck) {
          expect(scrollTo).toHaveBeenCalledWith(
            expect.objectContaining({ top: 0 }),
          );
          expect(useSidebarStore.getState().chatsSectionCollapsed).toBe(true);
        } else {
          expect(scrollTo).not.toHaveBeenCalled();
          expect(useSidebarStore.getState().chatsSectionCollapsed).toBe(false);
        }
      } finally {
        unmount(root, container);
      }
    },
  );

  it('keeps settings, share and import reachable from the header', async () => {
    // The default workspace has no row header any more, so these must live on
    // the section header instead.
    seed(1);
    const { container, root } = await renderChats();

    const settings = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-chats-settings"]',
    );
    act(() => settings?.click());
    expect(useNavigationStore.getState().workspaceSettingsModalOpen).toBe(true);
    expect(useNavigationStore.getState().pendingWorkspaceSettings).toEqual(
      expect.objectContaining({ workspaceId: DEFAULT_COWORK_WORKSPACE_ID }),
    );

    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-chats-more"]',
    );
    act(() => more?.click());
    const importItem = document.querySelector<HTMLElement>(
      '[data-testid="workspace-import-session-menu-item"]',
    );
    expect(
      document.querySelector(
        '[data-testid="workspace-share-template-menu-item"]',
      ),
    ).not.toBeNull();
    act(() => importItem?.click());
    act(() => useCloudConnectGateStore.getState().pending?.proceed());
    expect(useImportSessionModalStore.getState().target).toEqual({
      workspaceId: DEFAULT_COWORK_WORKSPACE_ID,
    });

    unmount(root, container);
  });

  it('gives every command row in the header menu a leading icon', async () => {
    seed(1);
    const { container, root } = await renderChats();

    const more = container.querySelector<HTMLButtonElement>(
      '[data-testid="sidebar-section-chats-more"]',
    );
    act(() => more?.click());

    expectMenuCommandRowsHaveIcons(
      document.querySelector<HTMLElement>(
        '[data-testid="workspace-session-context-menu"]',
      ),
    );

    unmount(root, container);
  });

  it('seats its selected row under the Chats header, not the Projects band', async () => {
    // The Projects-band pin seats a copy under the row's workspace header;
    // these rows have none, and their own header sits above that band. They
    // seat under the sticky Chats header instead, sharing only the rail-foot
    // group with project selections.
    seed(2);
    useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-1' });
    useNavigationStore.setState({ activePage: 'chat' });
    installWindowApi();
    const container = document.createElement('div');
    container.setAttribute('data-testid', 'app-sidebar');
    const bottomGroup = document.createElement('div');
    bottomGroup.setAttribute('data-sidebar-selected-pin-bottom', '');
    bottomGroup.innerHTML =
      '<div data-sidebar-selected-pin-part="header"></div><div data-sidebar-selected-pin-part="row"></div>';
    const sections = document.createElement('div');
    container.append(sections, bottomGroup);
    document.body.appendChild(container);
    const root = createRoot(sections);
    await act(async () => {
      root.render(<SidebarChatsSection />);
      await Promise.resolve();
    });

    expect(
      container.querySelectorAll(SELECTED_ITEM_FLOW_SELECTOR),
    ).toHaveLength(0);
    expect(
      Array.from(
        container.querySelectorAll(CHATS_SELECTED_ITEM_FLOW_SELECTOR),
      ).map((row) => row.getAttribute('data-testid')),
    ).toEqual(['sidebar-work-entry-entry-1']);
    const seat = container.querySelector<HTMLElement>(
      CHATS_SELECTED_PIN_SELECTOR,
    );
    // Revealed by the rail's scroll sync, never at render.
    expect(seat?.hidden).toBe(true);
    // The header's next sibling, so it sticks over exactly the header's range.
    expect(seat?.previousElementSibling?.getAttribute('data-testid')).toBe(
      'sidebar-section-chats',
    );
    expect(
      seat?.querySelector('[data-testid="sidebar-work-entry-entry-1-pin-top"]'),
    ).not.toBeNull();
    expect(
      bottomGroup.querySelector(
        '[data-testid="sidebar-work-entry-entry-1-pin-bottom"]',
      ),
    ).not.toBeNull();
    // No workspace header copy: the Chats header names the rows.
    expect(
      bottomGroup.querySelector('[data-sidebar-selected-pin-part="header"]')
        ?.childElementCount,
    ).toBe(0);

    act(() => root.unmount());
    container.remove();
  });

  it('names the section after the workspace, not the shared constant', async () => {
    // The catch-all may be renamed like any other cowork project. Pinning the
    // header to the constant put this section back out of step with the New
    // task composer and the chat switcher after one rename — the exact
    // disagreement the stored-name migration removes.
    useProjectsStore.setState({
      projects: [
        {
          ...makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID),
          name: 'Scratchpad',
        },
      ],
    });
    const { container, root } = await renderChats();

    expect(
      container.querySelector('[data-testid="sidebar-section-chats"]')
        ?.textContent,
    ).toContain('Scratchpad');
    unmount(root, container);
  });

  it('falls back to the shared label when the stored name is blank', async () => {
    useProjectsStore.setState({
      projects: [
        { ...makeCoworkProject(DEFAULT_COWORK_WORKSPACE_ID), name: '  ' },
      ],
    });
    const { container, root } = await renderChats();

    expect(
      container.querySelector('[data-testid="sidebar-section-chats"]')
        ?.textContent,
    ).toContain('Chats');
    unmount(root, container);
  });
});
