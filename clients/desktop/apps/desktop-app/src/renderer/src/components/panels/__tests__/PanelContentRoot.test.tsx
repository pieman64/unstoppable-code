/**
 * @jest-environment jsdom
 *
 * PanelContentRoot — the no-remount portal-target handoff. These tests drive
 * the REAL panel layout store plus real shared grid hosts (adoption mode) and
 * assert the load-bearing contract: a panel's content container is one stable
 * DOM node that survives every move — tab switches, cross-group moves, and
 * cross-layout extract/adopt (the pull-out/merge-back store path) — and is
 * destroyed only when the panel id vanishes from every layout.
 */
import { act, useCallback, type JSX } from 'react';
import type * as ReactNamespace from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PanelGridHost } from '@canopy/ui-shared/components/panels';
import type { PanelIntentCallbacks } from '@canopy/ui-shared/panels';
import {
  acquirePanelContentElement,
  PanelContentRoot,
  resetPanelContentContainersForTests,
} from '../PanelContentRoot';
import {
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelGridController,
  usePanelLayoutStore,
  usePanelLayoutViewModel,
} from '@/stores/panelLayoutStore';
import { usePanelWindowsStore } from '@/stores/panelWindowsStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { ensureDefaultWorktreeLayout } from '@/lib/panels/default-layout';
import { DEFAULT_PANEL_HOST_STATE } from '@/lib/panels/panel-host-context';

// Light per-panel content stubs (the real registry mounts Slate/xterm/native
// surfaces); each stub exposes the isActive/isVisible flow as attributes.
jest.mock('@/lib/panels/registry', () => {
  const react = jest.requireActual<typeof ReactNamespace>('react');
  return {
    renderPanelContent: (props: {
      panelId: string;
      kind: string;
      isActive: boolean;
      isVisible: boolean;
    }): unknown =>
      react.createElement('div', {
        'data-testid': `stub-content-${props.panelId}`,
        'data-active': String(props.isActive),
        'data-visible': String(props.isVisible),
      }),
    getPanelDefinition: (kind: string): unknown => ({
      kind,
      title: kind,
      icon: null,
      canPopOut: kind !== 'browser',
      isWindowBound: kind === 'browser',
      render: (): null => null,
    }),
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const KEY = makeWorktreePanelKey('project-1', 'worktree-1');
const AUX_ID = 'aux-test-1';
const AUX_KEY = makeAuxPanelLayoutKey(KEY, AUX_ID);

// The default layout's chat group is seeded with the worktree's active chat
// tab (instance-bound, deterministic `panel-chat-<tabId>` id) — see
// default-layout.ts. These tests hydrate one chat tab ('main') so the chat
// panel exists with a known id.
const CHAT_PANEL_ID = 'panel-chat-main';

function makeChatTab(): ChatTab {
  return {
    id: 'main',
    title: 'Chat',
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    model: 'claude-sonnet-4-5-20250514',
    providerType: 'claude',
  };
}

function seedChatState(): void {
  useChatStore.setState({
    selectedWorktree: { projectId: 'project-1', worktreeId: 'worktree-1' },
    worktreeChats: { [KEY]: { activeTabId: 'main', tabs: [makeChatTab()] } },
  });
}

const NOOP_CALLBACKS: PanelIntentCallbacks = {
  onSelectTab: jest.fn(),
  onCloseTab: jest.fn(),
  onCloseGroup: jest.fn(),
  onSplitGroup: jest.fn(),
  onMaximizeGroup: jest.fn(),
  onFocusGroup: jest.fn(),
  onMovePanel: jest.fn(),
};

/**
 * WorktreePart-shaped harness: the main grid host in adoption mode, an
 * optional aux grid host bound to the aux layout key (standing in for
 * AuxPanelWindow's grid, same adoption getter, without the OS child-window
 * plumbing), and the content root that owns every panel's content subtree.
 */
function Harness({ withAux }: { withAux: boolean }): JSX.Element {
  const viewModel = usePanelLayoutViewModel(KEY);
  const controller = usePanelGridController(KEY);
  const auxViewModel = usePanelLayoutViewModel(withAux ? AUX_KEY : null);
  const auxController = usePanelGridController(withAux ? AUX_KEY : null);

  const getPanelContentElement = useCallback(
    (panelId: string): HTMLElement | null =>
      acquirePanelContentElement(KEY, panelId),
    [],
  );

  return (
    <>
      {viewModel !== null && controller !== null && (
        <PanelGridHost
          layout={viewModel}
          gridController={controller}
          callbacks={NOOP_CALLBACKS}
          renderPanelContent={(): null => null}
          getPanelContentElement={getPanelContentElement}
        />
      )}
      {auxViewModel !== null && auxController !== null && (
        <div data-testid="aux-host">
          <PanelGridHost
            layout={auxViewModel}
            gridController={auxController}
            callbacks={NOOP_CALLBACKS}
            renderPanelContent={(): null => null}
            getPanelContentElement={getPanelContentElement}
            windowLabel="aux"
          />
        </div>
      )}
      <PanelContentRoot
        worktreeKey={KEY}
        hostState={DEFAULT_PANEL_HOST_STATE}
      />
    </>
  );
}

function containerFor(panelId: string): HTMLElement {
  const element = document.querySelector(
    `[data-panel-content-host="${panelId}"]`,
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error(`No content container for ${panelId}`);
  }
  return element;
}

function stubFor(panelId: string): HTMLElement {
  const element = document.querySelector(
    `[data-testid="stub-content-${panelId}"]`,
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error(`No stub content for ${panelId}`);
  }
  return element;
}

/** Registers a live aux-window record so PanelContentRoot mounts aux content. */
function registerAuxRecord(): void {
  usePanelWindowsStore.setState({
    auxWindows: {
      [AUX_ID]: {
        auxWindowId: AUX_ID,
        worktreeKey: KEY,
        layoutKey: AUX_KEY,
        sourceGroupId: 'group-terminal',
        childWindow: window,
        status: 'open',
        focusOnOpen: false,
      },
    },
  });
}

describe('PanelContentRoot', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    seedChatState();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    usePanelWindowsStore.setState({ auxWindows: {} });
    useChatStore.setState({ selectedWorktree: null, worktreeChats: {} });
    const store = usePanelLayoutStore.getState();
    for (const key of Object.keys(store.layouts)) {
      store.disposeLayout(key);
    }
    resetPanelContentContainersForTests();
    jest.clearAllMocks();
  });

  function renderHarness(withAux = false): void {
    act(() => {
      root.render(<Harness withAux={withAux} />);
    });
  }

  test('portals each tab into its stable container with correct isActive/isVisible', () => {
    ensureDefaultWorktreeLayout(KEY);
    renderHarness();

    // All three default panels render into adopted containers inside the
    // main grid's group bodies.
    for (const panelId of [CHAT_PANEL_ID, 'panel-terminal', 'panel-activity']) {
      const host = containerFor(panelId);
      expect(host.isConnected).toBe(true);
      expect(host.closest('[data-testid^="panel-group-body-"]')).not.toBeNull();
      expect(host.contains(stubFor(panelId))).toBe(true);
    }

    // Chat is the default active group: its tab is active AND visible. The
    // terminal starts as the collapsed bottom drawer, so its content stays
    // mounted but is not active or visible until expanded.
    expect(stubFor(CHAT_PANEL_ID).getAttribute('data-active')).toBe('true');
    expect(stubFor(CHAT_PANEL_ID).getAttribute('data-visible')).toBe('true');
    expect(stubFor('panel-terminal').getAttribute('data-active')).toBe('false');
    expect(stubFor('panel-terminal').getAttribute('data-visible')).toBe(
      'false',
    );

    // Focus flows: expanding/focusing the terminal group flips the active
    // panel and makes it visible.
    act(() => {
      usePanelLayoutStore.getState().expandGroup(KEY, 'group-terminal');
    });
    expect(stubFor(CHAT_PANEL_ID).getAttribute('data-active')).toBe('false');
    expect(stubFor('panel-terminal').getAttribute('data-active')).toBe('true');
    expect(stubFor('panel-terminal').getAttribute('data-visible')).toBe('true');

    // A stacked non-active tab is neither active nor visible; the active tab
    // of the stack is.
    act(() => {
      usePanelLayoutStore.getState().addTab(KEY, 'group-chat', 'file-diff', {
        panelId: 'panel-files',
        instance: { fileTabId: 'file-files' },
      });
    });
    expect(stubFor(CHAT_PANEL_ID).getAttribute('data-visible')).toBe('false');
    expect(stubFor('panel-files').getAttribute('data-visible')).toBe('true');

    // Maximize hides every other group's content (isVisible false).
    act(() => {
      usePanelLayoutStore.getState().maximizeGroup(KEY, 'group-chat', true);
    });
    expect(stubFor('panel-files').getAttribute('data-visible')).toBe('true');
    expect(stubFor('panel-terminal').getAttribute('data-visible')).toBe(
      'false',
    );
    expect(stubFor('panel-activity').getAttribute('data-visible')).toBe(
      'false',
    );
  });

  test('collapsing a group marks its content invisible even though it stays the active tab', () => {
    ensureDefaultWorktreeLayout(KEY);
    renderHarness();

    // The default layout seeds the activity rail collapsed (CAN-2836), so
    // expand it first to reach this test's subject: an expanded group whose
    // tab is active-and-visible within its own group (never the layout's
    // active group in the default layout, but visible since nothing is
    // maximized).
    act(() => {
      usePanelLayoutStore.getState().expandGroup(KEY, 'group-activity');
    });
    expect(stubFor('panel-activity').getAttribute('data-visible')).toBe('true');

    act(() => {
      const collapsed = usePanelLayoutStore
        .getState()
        .collapseGroup(KEY, 'group-activity');
      expect(collapsed).toBe(true);
    });

    // Collapsed groups render an icon-only bar instead of a body; the
    // content behind it must stop being "visible" so xterm/etc. do not keep
    // running behind `display: none`.
    expect(stubFor('panel-activity').getAttribute('data-visible')).toBe(
      'false',
    );

    act(() => {
      usePanelLayoutStore.getState().expandGroup(KEY, 'group-activity');
    });
    expect(stubFor('panel-activity').getAttribute('data-visible')).toBe('true');
  });

  test('container and content DOM identity survive viewModel changes and cross-group moves', () => {
    ensureDefaultWorktreeLayout(KEY);
    renderHarness();

    const terminalContainer = containerFor('panel-terminal');
    const terminalStub = stubFor('panel-terminal');
    // DOM-side marker: a remount/recreate would lose the attribute.
    terminalContainer.setAttribute('data-identity-marker', 'survives');
    terminalStub.setAttribute('data-identity-marker', 'survives');

    // Pure view-model change (tab select in another group): identity holds.
    act(() => {
      usePanelLayoutStore.getState().focusGroup(KEY, 'group-activity');
    });
    expect(containerFor('panel-terminal')).toBe(terminalContainer);

    // Topology change: move the terminal panel into the chat group (center
    // dock closes the emptied terminal group). Same container node, same
    // content node, now parented under the chat group's body.
    act(() => {
      usePanelLayoutStore
        .getState()
        .movePanel(KEY, 'panel-terminal', 'group-chat', 'center');
    });

    const movedContainer = containerFor('panel-terminal');
    expect(movedContainer).toBe(terminalContainer);
    expect(movedContainer.getAttribute('data-identity-marker')).toBe(
      'survives',
    );
    expect(stubFor('panel-terminal')).toBe(terminalStub);
    expect(
      movedContainer.closest('[data-testid="panel-group-body-group-chat"]'),
    ).not.toBeNull();

    // Edge split: move it back out to a fresh group on the right edge.
    act(() => {
      usePanelLayoutStore
        .getState()
        .movePanel(KEY, 'panel-terminal', 'group-chat', 'right');
    });
    expect(containerFor('panel-terminal')).toBe(terminalContainer);
    expect(stubFor('panel-terminal')).toBe(terminalStub);
  });

  test('extract to an aux layout and adopt back preserve the content DOM node', () => {
    ensureDefaultWorktreeLayout(KEY);
    renderHarness(true);

    const terminalContainer = containerFor('panel-terminal');
    const terminalStub = stubFor('panel-terminal');
    terminalContainer.setAttribute('data-identity-marker', 'pull-out');
    terminalStub.setAttribute('data-identity-marker', 'pull-out');

    // Pull-out: the store moves the group into a brand-new aux layout and
    // the aux window record mounts the aux grid + aux content portals.
    act(() => {
      const moved = usePanelLayoutStore
        .getState()
        .extractGroupToLayout(KEY, 'group-terminal', AUX_KEY);
      expect(moved).toBe(true);
      registerAuxRecord();
    });

    const pulledContainer = containerFor('panel-terminal');
    expect(pulledContainer).toBe(terminalContainer);
    expect(pulledContainer.getAttribute('data-identity-marker')).toBe(
      'pull-out',
    );
    expect(stubFor('panel-terminal')).toBe(terminalStub);
    // Adopted by the AUX grid's group body now.
    expect(pulledContainer.closest('[data-testid="aux-host"]')).not.toBeNull();

    // Merge-back: tabs adopt into the worktree layout's MRU group; the aux
    // layout is disposed and the record dropped.
    act(() => {
      const adopted = usePanelLayoutStore
        .getState()
        .adoptLayoutTabs(AUX_KEY, KEY);
      expect(adopted).toBe(true);
      usePanelWindowsStore.setState({ auxWindows: {} });
    });

    const mergedContainer = containerFor('panel-terminal');
    expect(mergedContainer).toBe(terminalContainer);
    expect(mergedContainer.getAttribute('data-identity-marker')).toBe(
      'pull-out',
    );
    expect(stubFor('panel-terminal')).toBe(terminalStub);
    expect(mergedContainer.closest('[data-testid="aux-host"]')).toBeNull();
    expect(
      mergedContainer.closest('[data-testid^="panel-group-body-"]'),
    ).not.toBeNull();
  });

  test('destroys a container only when its panel vanishes from every layout', () => {
    ensureDefaultWorktreeLayout(KEY);
    renderHarness();

    const terminalContainer = containerFor('panel-terminal');

    // Repeated acquire returns the same element (lazy get-or-create).
    expect(acquirePanelContentElement(KEY, 'panel-terminal')).toBe(
      terminalContainer,
    );

    // Closing the tab removes the panel from its (only) layout: the sweep
    // destroys the container and detaches it.
    act(() => {
      usePanelLayoutStore
        .getState()
        .closeTab(KEY, 'group-terminal', 'panel-terminal');
    });
    expect(terminalContainer.isConnected).toBe(false);
    expect(
      document.querySelector('[data-panel-content-host="panel-terminal"]'),
    ).toBeNull();
    // A fresh acquire creates a NEW container (the old one is gone for good).
    expect(acquirePanelContentElement(KEY, 'panel-terminal')).not.toBe(
      terminalContainer,
    );

    // Other panels' containers were untouched by the sweep.
    expect(containerFor(CHAT_PANEL_ID).isConnected).toBe(true);
  });

  test('containers are scoped per worktree, so identical default panel ids do not collide', () => {
    const otherKey = makeWorktreePanelKey('project-2', 'worktree-2');
    const mine = acquirePanelContentElement(KEY, 'panel-chat');
    const other = acquirePanelContentElement(otherKey, 'panel-chat');
    expect(mine).not.toBe(other);
  });
});
