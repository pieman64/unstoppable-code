/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ToolApprovalDock } from '../ToolApprovalDock';

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
      click(
        container.querySelector(
          '[data-testid="tool-approval-nav-next"]',
        ) as Element,
      );
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
      click(
        container.querySelector(
          '[data-testid="tool-approval-nav-next"]',
        ) as Element,
      );
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
      click(
        container.querySelector(
          '[data-testid="tool-approval-nav-next"]',
        ) as Element,
      );
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
});
