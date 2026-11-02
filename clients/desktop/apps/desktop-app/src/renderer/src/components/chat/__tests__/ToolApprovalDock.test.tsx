/**
 * @jest-environment jsdom
 */
import { act, createElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { STATUS_ANNOUNCEMENT_DELAY_MS } from '@canopy/ui-shared/components';
import { ToolApprovalDock } from '../ToolApprovalDock';
import { canApprovalTakeFocus } from '../approval-focus-policy';

const mockUseCurrentUiStateReporter = jest.fn();

jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (key: string, value: unknown): void => {
    mockUseCurrentUiStateReporter(key, value);
  },
}));

interface MockChatState {
  pendingApprovals: Record<string, ApprovalRequestEvent>;
  respondToApproval: (requestId: string) => Promise<void>;
}

// `ToolApprovalDock` is wrapped in `React.memo`, and re-rendering it from a
// real chat surface is driven entirely by zustand's own subscription (a
// store update re-renders the subscribed component instance directly,
// bypassing memo's prop-based bailout — memo only skips a render triggered
// by the *parent* re-rendering with unchanged props). A plain mocked
// `useChatStore` that just calls `selector(staticObject)` has no such
// subscription, so simulating "the store changed" by calling `root.render`
// again with identical props hits memo's bailout and never re-executes the
// selector. Backing the mock with a real zustand store sidesteps that: a
// `store.setState(...)` call notifies real subscribers the same way the
// production store does.
let store: UseBoundStore<StoreApi<MockChatState>>;

const respondToApprovalMock = jest.fn((requestId: string): Promise<void> => {
  store.setState((s) => {
    const next = { ...s.pendingApprovals };
    delete next[requestId];
    return { pendingApprovals: next };
  });
  return Promise.resolve();
});

jest.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: MockChatState) => unknown): unknown =>
    store(selector),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function makePending(
  requestId: string,
  overrides?: Partial<ApprovalRequestEvent>,
): ApprovalRequestEvent {
  return {
    requestId,
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    chatId: 'chat-1',
    provider: 'claude',
    title: `Run command ${requestId}`,
    details: { kind: 'command', command: `echo ${requestId}` },
    suggestedTarget: { kind: 'command', pattern: `echo ${requestId}*` },
    ...overrides,
  };
}

function click(el: Element | null | undefined): void {
  el?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  );
}

describe('ToolApprovalDock', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    respondToApprovalMock.mockClear();
    mockUseCurrentUiStateReporter.mockClear();
    store = create<MockChatState>(
      (): MockChatState => ({
        pendingApprovals: {},
        respondToApproval: respondToApprovalMock,
      }),
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function renderDock(
    chatId = 'chat-1',
    projectId = 'project-1',
    worktreeId = 'worktree-1',
  ): void {
    act(() => {
      root.render(
        createElement(ToolApprovalDock, { projectId, worktreeId, chatId }),
      );
    });
  }

  function seedPending(
    pendingApprovals: Record<string, ApprovalRequestEvent>,
  ): void {
    store.setState({ pendingApprovals });
  }

  it('renders nothing when there are no pending approvals for the chat', () => {
    renderDock();
    expect(
      container.querySelector('[data-testid="tool-approval-dock"]'),
    ).toBeNull();
  });

  it('filters approvals by project, worktree, and chat identity', () => {
    seedPending({
      'other-project': makePending('other-project', {
        projectId: 'project-2',
      }),
      'other-worktree': makePending('other-worktree', {
        worktreeId: 'worktree-2',
      }),
      matching: makePending('matching'),
    });
    renderDock();

    expect(container.querySelector('code')?.textContent).toBe('echo matching');
    expect(
      container.querySelector('[data-testid="tool-approval-count"]'),
    ).toBeNull();
  });

  it('records the dock chrome and blocks the command it asks about', () => {
    seedPending({
      'req-1': makePending('req-1'),
      'req-2': makePending('req-2'),
    });
    renderDock();

    expect(
      container
        .querySelector('[data-testid="tool-approval-dock"]')
        ?.className.split(' '),
    ).toEqual(['mb-1.5']);
    expect(
      container
        .querySelector('[data-testid="tool-approval-count"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="tool-approval-content-preview"]')
        ?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).not.toBeNull();
  });

  it('N=1: renders the card without a count indicator or nav buttons', () => {
    seedPending({ 'req-1': makePending('req-1') });
    renderDock();

    expect(
      container.querySelector('[data-testid="tool-approval-dock"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="tool-approval-card"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="tool-approval-count"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="tool-approval-nav-prev"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="tool-approval-nav-next"]'),
    ).toBeNull();
    expect(mockUseCurrentUiStateReporter).toHaveBeenLastCalledWith(
      'chat.toolApprovalDock',
      {
        visible: true,
        pendingCount: 1,
        selectedIndex: 0,
        provider: 'claude',
        requestKind: 'command',
        subagent: false,
      },
    );
  });

  it('N=3: shows "1 of 3", disables ← at the start, and → advances to the next approval', () => {
    seedPending({
      'req-1': makePending('req-1'),
      'req-2': makePending('req-2'),
      'req-3': makePending('req-3'),
    });
    renderDock();

    expect(
      container.querySelector('[data-testid="tool-approval-count"]')
        ?.textContent,
    ).toBe('Approval 1 of 3');
    expect(
      container.querySelector('[data-testid="tool-approval-card"]'),
    ).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('echo req-1');

    const prevButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-approval-nav-prev"]',
    );
    const nextButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="tool-approval-nav-next"]',
    );
    expect(prevButton?.disabled).toBe(true);
    expect(nextButton?.disabled).toBe(false);

    act(() => {
      click(nextButton);
    });

    expect(
      container.querySelector('[data-testid="tool-approval-count"]')
        ?.textContent,
    ).toBe('Approval 2 of 3');
    expect(container.querySelector('code')?.textContent).toBe('echo req-2');
  });

  it('resolving the currently-viewed approval advances gracefully to the next one', () => {
    seedPending({
      'req-1': makePending('req-1'),
      'req-2': makePending('req-2'),
      'req-3': makePending('req-3'),
    });
    renderDock();

    // Advance to the middle approval (index 1) first.
    act(() => {
      click(container.querySelector('[data-testid="tool-approval-nav-next"]'));
    });
    expect(container.querySelector('code')?.textContent).toBe('echo req-2');

    // Allow once resolves the currently-viewed approval (req-2), removing it
    // from the store. The list shifts up beneath the same index, so the dock
    // should land on req-3 (what was previously "next").
    act(() => {
      click(container.querySelector('[data-testid="tool-approval-allow"]'));
    });

    expect(
      container.querySelector('[data-testid="tool-approval-count"]')
        ?.textContent,
    ).toBe('Approval 2 of 2');
    expect(container.querySelector('code')?.textContent).toBe('echo req-3');
  });

  it('resolving the last approval moves the dock to the new last approval', () => {
    seedPending({
      'req-1': makePending('req-1'),
      'req-2': makePending('req-2'),
    });
    renderDock();

    act(() => {
      click(container.querySelector('[data-testid="tool-approval-nav-next"]'));
    });
    expect(container.querySelector('code')?.textContent).toBe('echo req-2');

    act(() => {
      click(container.querySelector('[data-testid="tool-approval-allow"]'));
    });

    // Only req-1 remains — the dock drops back to the single-approval,
    // no-nav presentation.
    expect(
      container.querySelector('[data-testid="tool-approval-count"]'),
    ).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('echo req-1');
  });

  it('resolving the only remaining approval unmounts the dock', () => {
    seedPending({ 'req-1': makePending('req-1') });
    renderDock();

    act(() => {
      click(container.querySelector('[data-testid="tool-approval-allow"]'));
    });

    expect(
      container.querySelector('[data-testid="tool-approval-dock"]'),
    ).toBeNull();
  });

  it('renders the subagent attribution badge for a subagent-originated pending', () => {
    seedPending({
      'req-1': makePending('req-1', { subagentId: 'sub-thread-1' }),
    });
    renderDock();

    expect(
      container.querySelector('[data-testid="tool-approval-subagent-badge"]'),
    ).not.toBeNull();
  });

  // CAN-3083: widening the approval mode makes main resolve a standing card
  // as approved, and the store drops the pending entry with no click. The dock
  // must follow that removal without ever answering the prompt itself — a
  // re-answer would be faking a decision the user never made.
  //
  // `autoResolve` reproduces exactly what `handleApprovalAutoResolved` does to
  // the store: delete the entry. It deliberately does not go through
  // `respondToApproval`.
  // jsdom's `window` is non-configurable, so stub the preload bridge on it
  // rather than replacing the global.
  function stubApprovalsRespond(): jest.Mock {
    const respond = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { approvals: { respond } },
    });
    return respond;
  }

  function autoResolve(requestId: string): void {
    act(() => {
      store.setState((state) => {
        const next = { ...state.pendingApprovals };
        delete next[requestId];
        return { pendingApprovals: next };
      });
    });
  }

  it('N=3: an auto-resolved approval leaves "1 of 2" and never answers the prompt', () => {
    const respond = stubApprovalsRespond();
    seedPending({
      'req-1': makePending('req-1'),
      'req-2': makePending('req-2'),
      'req-3': makePending('req-3'),
    });
    renderDock();
    expect(
      container.querySelector('[data-testid="tool-approval-count"]')
        ?.textContent,
    ).toBe('Approval 1 of 3');

    autoResolve('req-2');

    expect(
      container.querySelector('[data-testid="tool-approval-count"]')
        ?.textContent,
    ).toBe('Approval 1 of 2');
    expect(container.querySelector('code')?.textContent).toBe('echo req-1');
    expect(respondToApprovalMock).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('auto-resolving the only pending unmounts the dock without a click', () => {
    const respond = stubApprovalsRespond();
    seedPending({ 'req-1': makePending('req-1') });
    renderDock();
    expect(
      container.querySelector('[data-testid="tool-approval-dock"]'),
    ).not.toBeNull();

    autoResolve('req-1');

    expect(
      container.querySelector('[data-testid="tool-approval-dock"]'),
    ).toBeNull();
    expect(respondToApprovalMock).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it('resets to the first approval when the active chat changes', () => {
    seedPending({
      'req-1': makePending('req-1'),
      'req-2': makePending('req-2'),
      'chat-2-req': makePending('chat-2-req', { chatId: 'chat-2' }),
    });
    renderDock('chat-1');

    act(() => {
      click(container.querySelector('[data-testid="tool-approval-nav-next"]'));
    });
    expect(container.querySelector('code')?.textContent).toBe('echo req-2');

    renderDock('chat-2');

    expect(
      container.querySelector('[data-testid="tool-approval-count"]'),
    ).toBeNull();
    expect(container.querySelector('code')?.textContent).toBe(
      'echo chat-2-req',
    );
  });
  describe('keyboard focus (CAN-4997)', () => {
    let composerRoot: HTMLDivElement;
    let composerField: HTMLTextAreaElement;
    let outsideButton: HTMLButtonElement;
    const focusComposer = jest.fn((): void => {
      composerField.focus();
    });
    // The composer's real guard, over a stand-in composer.
    const canTakeFocus = (): boolean =>
      canApprovalTakeFocus({
        activeElement: document.activeElement,
        body: document.body,
        composerRoot,
        composerDraftText: composerField.value,
        composing: false,
        modalOpen: false,
      });

    beforeEach(() => {
      focusComposer.mockClear();
      composerRoot = document.createElement('div');
      composerField = document.createElement('textarea');
      composerRoot.append(composerField);
      outsideButton = document.createElement('button');
      document.body.append(composerRoot, outsideButton);
    });

    afterEach(() => {
      composerRoot.remove();
      outsideButton.remove();
    });

    function renderFocusDock(chatId = 'chat-1'): void {
      act(() => {
        root.render(
          createElement(ToolApprovalDock, {
            projectId: 'project-1',
            worktreeId: 'worktree-1',
            chatId,
            canTakeFocus,
            focusComposer,
          }),
        );
      });
    }

    function seed(...requestIds: string[]): void {
      act(() => {
        seedPending(
          Object.fromEntries(requestIds.map((id) => [id, makePending(id)])),
        );
      });
    }

    function displayed(): string | null | undefined {
      return container.querySelector('code')?.textContent;
    }

    function focusedTestId(): string | undefined {
      return (document.activeElement as HTMLElement | null)?.dataset.testid;
    }

    function allow(): void {
      act(() => {
        click(container.querySelector('[data-testid="tool-approval-allow"]'));
      });
    }

    it('takes focus from the body or an empty composer on arrival', () => {
      renderFocusDock();
      seed('req-1');
      expect(focusedTestId()).toBe('tool-approval-allow');

      act(() => {
        seedPending({});
      });
      act(() => composerField.focus());
      seed('req-2');
      expect(focusedTestId()).toBe('tool-approval-allow');
    });

    it('leaves a draft, another control, and an open chat alone', () => {
      renderFocusDock();
      composerField.value = 'wip';
      act(() => composerField.focus());
      seed('req-1');
      expect(document.activeElement).toBe(composerField);
      expect(composerField.value).toBe('wip');

      act(() => {
        seedPending({});
      });
      act(() => outsideButton.focus());
      seed('req-2');
      expect(document.activeElement).toBe(outsideButton);

      // Entering a chat with approvals leaves focus to the composer's own
      // startup focus.
      act(() => outsideButton.blur());
      act(() => {
        seedPending({
          'chat-2-req': makePending('chat-2-req', { chatId: 'chat-2' }),
        });
      });
      renderFocusDock('chat-2');
      expect(document.activeElement).toBe(document.body);
    });

    it('hands focus card to card through three approvals, then to the composer', () => {
      renderFocusDock();
      act(() => composerField.focus());
      seed('req-1', 'req-2', 'req-3');
      expect(displayed()).toBe('echo req-1');
      expect(focusedTestId()).toBe('tool-approval-allow');

      allow();
      expect(displayed()).toBe('echo req-2');
      expect(focusedTestId()).toBe('tool-approval-allow');

      act(() => {
        click(container.querySelector('[data-testid="tool-approval-deny"]'));
      });
      expect(displayed()).toBe('echo req-3');
      expect(focusedTestId()).toBe('tool-approval-allow');

      allow();
      expect(
        container.querySelector('[data-testid="tool-approval-card"]'),
      ).toBeNull();
      expect(focusComposer).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(composerField);
    });

    it('hands focus on from the reason field', () => {
      renderFocusDock();
      seed('req-1', 'req-2');
      act(() => {
        click(
          container.querySelector(
            '[data-testid="tool-approval-reason-toggle"]',
          ),
        );
      });
      expect(focusedTestId()).toBe('tool-approval-reason');
      act(() => {
        click(container.querySelector('[data-testid="tool-approval-deny"]'));
      });
      expect(displayed()).toBe('echo req-2');
      expect(focusedTestId()).toBe('tool-approval-allow');
    });

    it('selects the successor of a middle card and the predecessor of the last', () => {
      renderFocusDock();
      seed('req-1', 'req-2', 'req-3');
      act(() => {
        click(
          container.querySelector('[data-testid="tool-approval-nav-next"]'),
        );
      });
      allow();
      expect(displayed()).toBe('echo req-3');
      expect(focusedTestId()).toBe('tool-approval-allow');
      allow();
      expect(displayed()).toBe('echo req-1');
      expect(focusedTestId()).toBe('tool-approval-allow');
    });

    it('keeps the displayed request when another one is removed', () => {
      renderFocusDock();
      seed('req-1', 'req-2', 'req-3');
      act(() => {
        click(
          container.querySelector('[data-testid="tool-approval-nav-next"]'),
        );
      });
      expect(displayed()).toBe('echo req-2');
      act(() => {
        store.setState((state) => {
          const next = { ...state.pendingApprovals };
          delete next['req-1'];
          return { pendingApprovals: next };
        });
      });
      expect(displayed()).toBe('echo req-2');
      expect(
        container.querySelector('[data-testid="tool-approval-count"]')
          ?.textContent,
      ).toBe('Approval 1 of 2');
    });

    it('moves focus on external removal only when the card owned it', () => {
      renderFocusDock();
      seed('req-1', 'req-2', 'req-3');
      expect(focusedTestId()).toBe('tool-approval-allow');
      act(() => {
        store.setState({
          pendingApprovals: {
            'req-2': makePending('req-2'),
            'req-3': makePending('req-3'),
          },
        });
      });
      expect(displayed()).toBe('echo req-2');
      expect(focusedTestId()).toBe('tool-approval-allow');

      act(() => outsideButton.focus());
      act(() => {
        store.setState({ pendingApprovals: { 'req-3': makePending('req-3') } });
      });
      expect(displayed()).toBe('echo req-3');
      expect(document.activeElement).toBe(outsideButton);
    });

    it('preserves focus moved elsewhere while the response is in flight', async () => {
      let finish: () => void = () => undefined;
      respondToApprovalMock.mockImplementationOnce(
        (requestId: string): Promise<void> =>
          new Promise<void>((resolve) => {
            finish = (): void => {
              store.setState({ pendingApprovals: {} });
              resolve();
            };
            void requestId;
          }),
      );
      renderFocusDock();
      seed('req-1');
      allow();
      act(() => outsideButton.focus());
      await act(async () => {
        finish();
        await Promise.resolve();
      });
      expect(document.activeElement).toBe(outsideButton);
      expect(focusComposer).not.toHaveBeenCalled();
    });

    it('does not reclaim focus that left for elsewhere and then fell to the body', () => {
      renderFocusDock();
      seed('req-1');
      expect(focusedTestId()).toBe('tool-approval-allow');
      act(() => outsideButton.focus());
      act(() => outsideButton.blur());
      act(() => {
        store.setState({ pendingApprovals: {} });
      });
      expect(focusComposer).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(document.body);
    });

    it('keeps focus on a navigation button, and lands on the card when it disables', () => {
      renderFocusDock();
      seed('req-1', 'req-2', 'req-3');
      const next = container.querySelector<HTMLButtonElement>(
        '[data-testid="tool-approval-nav-next"]',
      );
      act(() => next?.focus());
      act(() => {
        click(next);
      });
      expect(displayed()).toBe('echo req-2');
      expect(document.activeElement).toBe(next);

      act(() => {
        click(next);
      });
      expect(displayed()).toBe('echo req-3');
      expect(focusedTestId()).toBe('tool-approval-allow');
    });

    it('repairs disabled navigation focus when the displayed middle request is removed', () => {
      renderFocusDock();
      seed('req-1', 'req-2', 'req-3');
      const next = container.querySelector<HTMLButtonElement>(
        '[data-testid="tool-approval-nav-next"]',
      );
      act(() => {
        next?.focus();
        click(next);
      });
      expect(displayed()).toBe('echo req-2');
      expect(document.activeElement).toBe(next);

      autoResolve('req-2');

      expect(displayed()).toBe('echo req-3');
      expect(next?.disabled).toBe(true);
      expect(focusedTestId()).toBe('tool-approval-allow');
    });

    it('repairs focus when a count change removes the focused navigation button', () => {
      renderFocusDock();
      seed('req-1', 'req-2');
      const next = container.querySelector<HTMLButtonElement>(
        '[data-testid="tool-approval-nav-next"]',
      );
      act(() => next?.focus());
      autoResolve('req-2');
      expect(displayed()).toBe('echo req-1');
      expect(focusedTestId()).toBe('tool-approval-allow');
    });

    it('hands off to an arrival batched with the final response instead of the composer', async () => {
      let finish: () => void = () => undefined;
      respondToApprovalMock.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = (): void => {
              store.setState({
                pendingApprovals: { 'req-2': makePending('req-2') },
              });
              resolve();
            };
          }),
      );
      renderFocusDock();
      seed('req-1');
      allow();
      expect(displayed()).toBe('echo req-1');
      await act(async () => {
        finish();
        await Promise.resolve();
      });
      expect(displayed()).toBe('echo req-2');
      expect(focusedTestId()).toBe('tool-approval-allow');
      expect(focusComposer).not.toHaveBeenCalled();
    });

    it('does not restore the composer after its host unmounts', () => {
      renderFocusDock();
      seed('req-1');
      expect(focusedTestId()).toBe('tool-approval-allow');
      act(() => root.render(null));
      expect(focusComposer).not.toHaveBeenCalled();
    });

    it('does not hand focus across a chat switch', () => {
      seedPending({
        'req-1': makePending('req-1'),
        'chat-2-req': makePending('chat-2-req', { chatId: 'chat-2' }),
      });
      renderFocusDock();
      const chatOneAllow = container.querySelector<HTMLButtonElement>(
        '[data-testid="tool-approval-allow"]',
      );
      act(() => chatOneAllow?.focus());
      renderFocusDock('chat-2');
      expect(displayed()).toBe('echo chat-2-req');
      expect(focusComposer).not.toHaveBeenCalled();
      expect(focusedTestId()).not.toBe('tool-approval-allow');
    });
  });

  describe('arrival announcements (CAN-4997)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    function region(): HTMLElement | null {
      return container.querySelector('[data-testid="tool-approval-announcer"]');
    }

    function heard(): string | null | undefined {
      act(() => jest.advanceTimersByTime(STATUS_ANNOUNCEMENT_DELAY_MS));
      return region()?.textContent;
    }

    function finishAnnouncement(): void {
      act(() => jest.advanceTimersByTime(4_000));
    }

    it('keeps an empty, replay-blocked polite region mounted without approvals', () => {
      renderDock();
      expect(region()?.getAttribute('role')).toBe('status');
      expect(region()?.getAttribute('aria-live')).toBe('polite');
      expect(region()?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
        true,
      );
      expect(region()?.textContent).toBe('');
    });

    it('announces each arrival in turn, including ones behind the displayed card', () => {
      renderDock();
      act(() => {
        seedPending({
          'req-1': makePending('req-1'),
          'req-2': makePending('req-2'),
        });
      });
      expect(heard()).toBe('Approval needed: Run command req-1. echo req-1');
      finishAnnouncement();
      expect(heard()).toBe('Approval needed: Run command req-2. echo req-2');
      finishAnnouncement();
      act(() => jest.advanceTimersByTime(10_000));
      expect(region()?.textContent).toBe('');

      act(() => {
        click(
          container.querySelector('[data-testid="tool-approval-nav-next"]'),
        );
      });
      expect(heard()).toBe('');
    });

    it('announces identical requests separately', () => {
      renderDock();
      act(() => {
        seedPending({
          'req-1': makePending('req-1', { title: 'Run command' }),
          'req-2': makePending('req-2', {
            title: 'Run command',
            details: { kind: 'command', command: 'echo req-1' },
          }),
        });
      });
      expect(heard()).toBe('Approval needed: Run command. echo req-1');
      finishAnnouncement();
      expect(heard()).toBe('Approval needed: Run command. echo req-1');
    });

    it('reannounces the same request id and text on a different chat activation', () => {
      seedPending({
        shared: makePending('shared', { title: 'Same approval' }),
      });
      renderDock();
      expect(heard()).toContain('Same approval');
      act(() => jest.advanceTimersByTime(2_000));
      act(() => {
        seedPending({
          shared: makePending('shared', {
            chatId: 'chat-2',
            title: 'Same approval',
          }),
        });
      });
      renderDock('chat-2');
      act(() => jest.advanceTimersByTime(0));
      expect(region()?.textContent).toBe('');
      expect(heard()).toContain('Same approval');
      // The new activation owns a full delivery interval, independent of the old timer.
      act(() => jest.advanceTimersByTime(2_100));
      expect(region()?.textContent).toContain('Same approval');
    });

    it('does not repeat a removed and redelivered request during the same activation', () => {
      renderDock();
      act(() => seedPending({ shared: makePending('shared') }));
      expect(heard()).toContain('shared');
      act(() => seedPending({}));
      expect(heard()).toBe('');
      act(() => seedPending({ shared: makePending('shared') }));
      expect(heard()).toBe('');
    });

    it('delivers each initial arrival once under Strict Mode and cancels on unmount', () => {
      seedPending({
        'req-1': makePending('req-1'),
        'req-2': makePending('req-2'),
      });
      act(() =>
        root.render(
          createElement(
            StrictMode,
            null,
            createElement(ToolApprovalDock, {
              projectId: 'project-1',
              worktreeId: 'worktree-1',
              chatId: 'chat-1',
            }),
          ),
        ),
      );
      expect(heard()).toContain('req-1');
      finishAnnouncement();
      expect(heard()).toContain('req-2');
      finishAnnouncement();
      expect(heard()).toBe('');
      act(() => root.render(null));
      expect(jest.getTimerCount()).toBe(0);
    });

    it('drops queued announcements for resolved requests and for another chat', () => {
      renderDock();
      act(() => {
        seedPending({
          'req-1': makePending('req-1'),
          'req-2': makePending('req-2'),
          'req-3': makePending('req-3'),
        });
      });
      expect(heard()).toBe('Approval needed: Run command req-1. echo req-1');
      act(() => {
        store.setState({
          pendingApprovals: {
            'req-1': makePending('req-1'),
            'req-3': makePending('req-3'),
            'chat-2-req': makePending('chat-2-req', { chatId: 'chat-2' }),
          },
        });
      });
      finishAnnouncement();
      expect(heard()).toBe('Approval needed: Run command req-3. echo req-3');

      renderDock('chat-2');
      expect(heard()).toBe(
        'Approval needed: Run command chat-2-req. echo chat-2-req',
      );
    });
  });
});
