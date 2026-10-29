/**
 * @jest-environment jsdom
 *
 * The early-access Activity card shows and hides at once:
 *
 * - It is rendered ahead of time, hidden, once the browser is idle, and stays
 *   rendered after it closes, so showing it only reveals it rather than
 *   rendering the whole Activity panel on the click.
 * - It has no motion.
 * - It sits flat in the margin beside the chat's centered column, which
 *   stays put while the margin fits the card and moves left only as far as
 *   it must when it does not, and floats over the chat, elevated, when the
 *   column cannot clear it at all.
 */
import { act, useEffect, type JSX } from 'react';
import type * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  ActivityCardChatLayout,
  ActivityCardToggle,
} from '../ActivityCardControl';
import {
  ACTIVITY_CARD_OPEN_STORAGE_KEY,
  isActivityCardOpen,
  useActivityCardStore,
} from '@/stores/activityCardStore';

const WORKTREE_KEY = 'project/worktree';

const PANEL_ID = 'panel-chat';
let adapterRenders = 0;
let mockEarlyAccess = true;

jest.mock('@/stores/labsExperimentsStore', () => ({
  useLabsExperimentEnabled: (): boolean => mockEarlyAccess,
}));

let mockSelectedWorktree = { projectId: 'project', worktreeId: 'worktree' };

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: unknown) => unknown): unknown =>
    selector({ selectedWorktree: mockSelectedWorktree }),
}));

jest.mock('@/stores/panelLayoutStore', () => ({
  makeWorktreePanelKey: (projectId: string, worktreeId: string): string =>
    `${projectId}/${worktreeId}`,
  usePanelLayoutStore: (selector: (state: unknown) => unknown): unknown =>
    selector({
      layouts: {
        'project/worktree': {
          groups: { 'group-chat': { tabs: [{ panelId: 'panel-chat' }] } },
        },
        'project/other': {
          groups: { 'group-chat': { tabs: [{ panelId: 'panel-chat' }] } },
        },
      },
    }),
}));

jest.mock('@/lib/panels/panel-group-ids', () => ({
  DEFAULT_CHAT_GROUP_ID: 'group-chat',
}));

let adapterMounts = 0;
let adapterUnmounts = 0;

jest.mock('../SharedActivityPanelAdapter', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    SharedActivityPanelAdapter: (): JSX.Element => {
      adapterRenders += 1;
      useEffect(() => {
        adapterMounts += 1;
        return (): void => {
          adapterUnmounts += 1;
        };
      }, []);
      return <div>Activity rows</div>;
    },
  };
});

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

let host: HTMLDivElement;
let root: Root;
let layoutWidth = 1400;
let chatMaxWidth = 768;
const resizeCallbacks: ResizeObserverCallback[] = [];

function resize(): void {
  act(() => {
    for (const callback of resizeCallbacks) {
      callback([], {
        observe: () => undefined,
        unobserve: () => undefined,
        disconnect: () => undefined,
      });
    }
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  adapterRenders = 0;
  adapterMounts = 0;
  adapterUnmounts = 0;
  mockEarlyAccess = true;
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    window.setTimeout(() => callback(performance.now()), 16);
  window.cancelAnimationFrame = (id: number): void => window.clearTimeout(id);
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: (): void => undefined,
    removeListener: (): void => undefined,
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
    dispatchEvent: (): boolean => false,
  });
  useActivityCardStore.setState({ openWorktrees: {} });
  mockSelectedWorktree = { projectId: 'project', worktreeId: 'worktree' };
  layoutWidth = 1400;
  chatMaxWidth = 768;
  resizeCallbacks.length = 0;
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe(): void {}
      disconnect(): void {}
    },
  });
  jest
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement): DOMRect {
      if (this.dataset.testid === 'chat-activity-card-layout') {
        return new DOMRect(0, 0, layoutWidth, 800);
      }
      if (this.getAttribute('aria-hidden') === 'true') {
        return new DOMRect(0, 0, chatMaxWidth, 0);
      }
      return new DOMRect(0, 0, 0, 0);
    });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root.render(
      <ActivityCardChatLayout panelId={PANEL_ID}>
        <div>Transcript</div>
      </ActivityCardChatLayout>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function slot(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-testid="activity-card-slot"]');
}

/** The chat's wrapper inside the layout. */
function chat(): HTMLElement | null {
  return host.querySelector<HTMLElement>(
    '[data-testid="chat-activity-card-layout"] > :nth-child(2)',
  );
}

/** Hidden by the card's own wrapper (or any hidden ancestor). */
function hidden(element: HTMLElement | null): boolean {
  for (let node = element; node; node = node.parentElement) {
    if (node.style.display === 'none' || node.classList.contains('hidden')) {
      return true;
    }
  }
  return false;
}

describe('ActivityCardChatLayout', () => {
  it('renders the card hidden ahead of time, then only reveals it', () => {
    expect(slot()).toBeNull();

    // Idle: the card is rendered, hidden, before anyone asks for it.
    act(() => jest.advanceTimersByTime(250));
    expect(hidden(slot())).toBe(true);
    const rendersBeforeOpen = adapterRenders;
    expect(rendersBeforeOpen).toBeGreaterThan(0);

    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(hidden(slot())).toBe(false);
    act(() => jest.advanceTimersByTime(500));
    expect(adapterRenders).toBe(rendersBeforeOpen);
  });

  it('keeps the card running while hidden, so it misses no updates', () => {
    // Rendered ahead of time, hidden: its effects already run.
    act(() => jest.advanceTimersByTime(250));
    expect(hidden(slot())).toBe(true);
    expect(adapterMounts).toBe(1);

    // Shown, then hidden again: never torn down and set up anew.
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(adapterMounts).toBe(1);
    expect(adapterUnmounts).toBe(0);
  });

  it('shows and hides the card at once, with no motion', () => {
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(hidden(slot())).toBe(false);
    expect(host.innerHTML).not.toMatch(/transition|translate-|duration-/);

    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(hidden(slot())).toBe(true);
  });

  it('sits flat in the chat’s margin without moving its centered column', () => {
    // 1400 leaves 316px each side of the chat's 768px column: room for the
    // 272px card and the chat's 16px padding without touching the column.
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(slot()?.dataset.placement).toBe('beside');
    expect(slot()?.className).toContain('absolute');
    // The chat keeps its full width, so its column stays centered.
    expect(chat()?.style.paddingRight).toBe('0px');
    // Its scrollbar moves out from under the card.
    expect(chat()?.style.getPropertyValue('--chat-scrollbar-inset')).toBe(
      '272px',
    );
    const card = host.querySelector<HTMLElement>(
      '[data-testid="activity-card"]',
    );
    expect(card?.dataset.style).toBe('flat');
    expect(
      host.querySelector('[data-testid="activity-card-surface"]'),
    ).toBeNull();
  });

  it('moves the column left only as far as it must to clear the card', () => {
    // 1150 leaves 191px each side, and the card needs 272px plus the chat's
    // 16px padding: the column must move 97px left, so the chat gives up
    // twice that on its right.
    layoutWidth = 1150;
    resize();
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(slot()?.dataset.placement).toBe('beside');
    expect(chat()?.style.paddingRight).toBe('194px');
    // The scrollbar sits at the card's left edge.
    expect(chat()?.style.getPropertyValue('--chat-scrollbar-inset')).toBe(
      '78px',
    );

    // Narrower still, the chat gives up no more than the card's width.
    layoutWidth = 1050;
    resize();
    expect(slot()?.dataset.placement).toBe('beside');
    expect(chat()?.style.paddingRight).toBe('272px');

    // Hidden, the card gives the chat its width back.
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(chat()?.style.paddingRight).toBe('0px');
    expect(chat()?.style.getPropertyValue('--chat-scrollbar-inset')).toBe(
      '0px',
    );
  });

  it('floats over the chat, elevated, when a column would squeeze the chat', () => {
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(slot()?.dataset.placement).toBe('beside');

    // 1000 - 272 leaves less than the chat's 768px column.
    layoutWidth = 1000;
    resize();
    expect(slot()?.dataset.placement).toBe('over');
    expect(slot()?.className).toContain('absolute');
    const card = host.querySelector<HTMLElement>(
      '[data-testid="activity-card"]',
    );
    expect(card?.dataset.style).toBe('elevated');
    expect(
      host.querySelector('[data-testid="activity-card-surface"]')?.className,
    ).toContain('shadow-xl');

    layoutWidth = 1100;
    resize();
    expect(slot()?.dataset.placement).toBe('beside');
  });

  it('keeps the Activity panel mounted when the card switches placement', () => {
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(slot()?.dataset.placement).toBe('beside');
    const mounts = adapterMounts;
    expect(mounts).toBeGreaterThan(0);

    layoutWidth = 1000;
    resize();
    expect(slot()?.dataset.placement).toBe('over');
    layoutWidth = 1400;
    resize();
    expect(slot()?.dataset.placement).toBe('beside');
    // Remounting reloaded the sections (the MCP count flickered).
    expect(adapterMounts).toBe(mounts);
  });

  it('keeps the rows in place when the card switches placement', () => {
    const geometry = (): string[] =>
      (slot()?.className ?? '')
        .split(' ')
        .filter((name) => /^(w-|py-|pr-)/.test(name));
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(slot()?.dataset.placement).toBe('beside');
    const beside = geometry();

    layoutWidth = 1000;
    resize();
    expect(slot()?.dataset.placement).toBe('over');
    expect(geometry()).toEqual(beside);
    expect(beside).toEqual(['w-68', 'py-2', 'pr-1']);
  });

  it('floats over a layout narrower than the chat column itself', () => {
    // 650px is less than the chat's own 768px column, let alone the column
    // plus the card: the card must float, not take a column.
    layoutWidth = 650;
    resize();
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(slot()?.dataset.placement).toBe('over');
    // Floating, it leaves the chat's width alone.
    expect(chat()?.style.paddingRight).toBe('0px');
  });

  it('stays beside a full-width chat, which has no column to keep', () => {
    // The Chat width setting at full width sets the variables to 100%.
    // (jsdom does not inherit custom properties, so the read is stubbed.)
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    jest
      .spyOn(window, 'getComputedStyle')
      .mockImplementation((element: Element): CSSStyleDeclaration => {
        const style = realGetComputedStyle(element);
        return Object.assign(Object.create(style) as CSSStyleDeclaration, {
          getPropertyValue: (name: string): string =>
            name === '--chat-composer-shell-width'
              ? '100%'
              : style.getPropertyValue(name),
        });
      });
    layoutWidth = 650;
    chatMaxWidth = 650;
    resize();
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(slot()?.dataset.placement).toBe('beside');
    // A full-width chat has no margin, so it gives the card its whole width.
    expect(chat()?.style.paddingRight).toBe('272px');
  });
});

describe('ActivityCardChatLayout without early access', () => {
  /** Counts mounts, so a remount of the chat shows. */
  let chatMounts = 0;
  function Chat(): JSX.Element {
    useEffect(() => {
      chatMounts += 1;
    }, []);
    return <div data-testid="chat">Transcript</div>;
  }
  function renderLayout(enabled: boolean): void {
    act(() => {
      root.render(
        <ActivityCardChatLayout panelId={PANEL_ID} enabled={enabled}>
          <Chat />
        </ActivityCardChatLayout>,
      );
    });
  }

  it('adds no layout and no card', () => {
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    renderLayout(false);
    act(() => jest.advanceTimersByTime(250));
    expect(
      host.querySelector('[data-testid="chat-activity-card-layout"]'),
    ).toBeNull();
    expect(slot()).toBeNull();
    const chat = host.querySelector('[data-testid="chat"]');
    // Every wrapper around the chat is `display: contents`.
    for (
      let element = chat?.parentElement;
      element && element !== host;
      element = element.parentElement
    ) {
      expect(element.className).toBe('contents');
    }
  });

  it('keeps the chat mounted when early access turns on or off', () => {
    chatMounts = 0;
    renderLayout(false);
    expect(chatMounts).toBe(1);
    renderLayout(true);
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(slot()).not.toBeNull();
    renderLayout(false);
    expect(chatMounts).toBe(1);
  });
});

describe('ActivityCardChatLayout per worktree', () => {
  function rerender(): void {
    act(() => {
      root.render(
        <ActivityCardChatLayout panelId={PANEL_ID}>
          <div>Transcript</div>
        </ActivityCardChatLayout>,
      );
    });
  }

  it('remembers each worktree’s choice across switches', () => {
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(hidden(slot())).toBe(false);

    // Another worktree, never toggled, shows no card.
    mockSelectedWorktree = { projectId: 'project', worktreeId: 'other' };
    rerender();
    const other = slot();
    expect(other === null || hidden(other)).toBe(true);

    // Back on the first worktree, its card is still shown.
    mockSelectedWorktree = { projectId: 'project', worktreeId: 'worktree' };
    rerender();
    expect(hidden(slot())).toBe(false);
  });

  it('keeps the choice for the next launch', () => {
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(
      JSON.parse(
        window.localStorage.getItem(ACTIVITY_CARD_OPEN_STORAGE_KEY) ?? '[]',
      ),
    ).toEqual([WORKTREE_KEY]);
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(
      JSON.parse(
        window.localStorage.getItem(ACTIVITY_CARD_OPEN_STORAGE_KEY) ?? '[]',
      ),
    ).toEqual([]);
  });
});

describe('ActivityCardChatLayout in a hidden tab', () => {
  function renderPanel(visible: boolean): void {
    act(() => {
      root.render(
        <ActivityCardChatLayout panelId={PANEL_ID} visible={visible}>
          <div>Transcript</div>
        </ActivityCardChatLayout>,
      );
    });
  }

  it('renders no card, so only the shown tab runs the Activity panel', () => {
    renderPanel(false);
    act(() => jest.advanceTimersByTime(250));
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    act(() => jest.advanceTimersByTime(500));
    expect(slot()).toBeNull();
    expect(adapterRenders).toBe(0);
  });

  it('drops the card when its tab is hidden and shows it again when shown', () => {
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    expect(hidden(slot())).toBe(false);

    renderPanel(false);
    expect(slot()).toBeNull();

    renderPanel(true);
    expect(hidden(slot())).toBe(false);

    // Closed while away: the tab comes back without a card or its space.
    renderPanel(false);
    act(() => useActivityCardStore.getState().toggle(WORKTREE_KEY));
    renderPanel(true);
    const current = slot();
    expect(current === null || hidden(current)).toBe(true);
  });
});

describe('ActivityCardToggle', () => {
  function renderToggle(props: {
    projectId?: string;
    worktreeId?: string;
    groupId?: string;
    activeTabKind?: string | null;
  }): HTMLButtonElement | null {
    act(() => {
      root.render(
        <ActivityCardToggle
          projectId={props.projectId ?? 'project'}
          worktreeId={props.worktreeId ?? 'worktree'}
          groupId={props.groupId ?? 'group-chat'}
          activeTabKind={
            props.activeTabKind === undefined ? 'chat' : props.activeTabKind
          }
        />,
      );
    });
    return host.querySelector<HTMLButtonElement>(
      '[data-testid="worktree-activity-card-toggle"]',
    );
  }

  it('shows only in the selected worktree’s main chat group, with early access', () => {
    const button = renderToggle({});
    expect(button).not.toBeNull();
    // Its name says what a press does.
    expect(button?.getAttribute('aria-label')).toBe('Show activity');
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    act(() => button?.click());
    expect(
      isActivityCardOpen(useActivityCardStore.getState(), WORKTREE_KEY),
    ).toBe(true);
    const pressed = host.querySelector(
      '[data-testid="worktree-activity-card-toggle"]',
    );
    expect(pressed?.getAttribute('aria-expanded')).toBe('true');
    expect(pressed?.getAttribute('aria-label')).toBe('Hide activity');
    // The open state wears the hover look, like the Side Panel toggle.
    expect(pressed?.className).toContain('aria-expanded:bg-subtle');

    expect(renderToggle({ groupId: 'group-extras' })).toBeNull();
    expect(renderToggle({ worktreeId: 'other-worktree' })).toBeNull();
    mockEarlyAccess = false;
    expect(renderToggle({})).toBeNull();
  });

  it('shows only while the group’s shown tab is a chat', () => {
    expect(renderToggle({ activeTabKind: 'chat' })).not.toBeNull();
    // A browser, terminal, or any other tab shown in the main chat group
    // hides it: the card it opens lives inside the chat.
    expect(renderToggle({ activeTabKind: 'browser' })).toBeNull();
    expect(renderToggle({ activeTabKind: 'terminal' })).toBeNull();
    expect(renderToggle({ activeTabKind: null })).toBeNull();
  });
});
