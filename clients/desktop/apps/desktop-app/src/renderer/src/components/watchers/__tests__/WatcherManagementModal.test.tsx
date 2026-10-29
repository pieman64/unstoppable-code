/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { AppAdvisorWatcherSummary } from '@canopy/desktop-shared/types';
import { useAppAdvisorWatchersStore } from '@/stores/appAdvisorWatchersStore';
import { WatcherManagementModal } from '../WatcherManagementModal';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

describe('WatcherManagementModal session-replay privacy', () => {
  it('records the portaled card and its scrim', () => {
    act(() => {
      root.render(
        <WatcherManagementModal
          title="Pipeline watchers"
          emptyMessage="No active watchers for this pipeline."
          watchers={[]}
          onClose={jest.fn()}
        />,
      );
    });

    const backdrop = document.body.querySelector(
      ':scope > [data-testid="watcher-management-modal-backdrop"]',
    );
    const card = backdrop?.querySelector(
      '[data-testid="watcher-management-modal"]',
    );
    expect(card?.getAttribute('role')).toBe('dialog');
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(backdrop?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      false,
    );
    expect(card?.querySelector('h2')?.textContent).toBe('Pipeline watchers');
  });

  it('blocks the follow-up instruction but not the row controls', () => {
    const watcher: AppAdvisorWatcherSummary = {
      id: 'w1',
      trigger: 'worktree_chat_completion',
      status: 'active',
      label: 'Private watcher label',
      target: {
        kind: 'worktree_chat',
        projectId: 'p1',
        worktreeId: 'wt1',
        chatId: 'c1',
        chatTitle: 'Private chat title',
      },
      destination: {
        projectId: 'p1',
        worktreeId: 'wt1',
        chatId: 'c2',
        chatTitle: 'Private destination',
      },
      followUpInstruction: 'Secret follow-up instruction',
      createdAt: '2026-09-01T00:00:00.000Z',
    };
    act(() => {
      root.render(
        <WatcherManagementModal
          title="Chat watchers"
          emptyMessage="No watchers."
          watchers={[watcher]}
          onClose={jest.fn()}
        />,
      );
    });

    const row = document.body.querySelector(
      '[data-testid="watcher-management-row-w1"]',
    );
    const textParent = (text: string): Element | null | undefined =>
      Array.from(row?.querySelectorAll('*') ?? []).find((element) =>
        Array.from(element.childNodes).some(
          (node) =>
            node.nodeType === Node.TEXT_NODE && node.textContent === text,
        ),
      );
    expect(
      textParent('Secret follow-up instruction')?.closest(
        `.${POSTHOG_REPLAY_BLOCK_CLASS}`,
      ),
    ).not.toBeNull();
    expect(
      textParent('Delete')?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });
});

describe('WatcherManagementModal delete confirmation', () => {
  const watcher = (id: string): AppAdvisorWatcherSummary => ({
    id,
    trigger: 'worktree_chat_completion',
    status: 'active',
    label: `Watcher ${id}`,
    target: {
      kind: 'worktree_chat',
      projectId: 'p1',
      worktreeId: 'wt1',
      chatId: 'c1',
    },
    destination: { projectId: 'p1', worktreeId: 'wt1', chatId: 'c2' },
    createdAt: '2026-09-01T00:00:00.000Z',
  });

  it('keeps a newly armed delete when an earlier delete settles later', async () => {
    const original = useAppAdvisorWatchersStore.getState();
    let settleFirst: (result: { ok: true }) => void = () => undefined;
    const deleteWatcher = jest.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          settleFirst = resolve;
        }),
    );
    useAppAdvisorWatchersStore.setState({ deleteWatcher, deleteErrors: {} });
    try {
      act(() => {
        root.render(
          <WatcherManagementModal
            title="Watchers"
            emptyMessage="No watchers."
            watchers={[watcher('watcher-1'), watcher('watcher-2')]}
            onClose={jest.fn()}
          />,
        );
      });
      const click = async (testId: string): Promise<void> => {
        await act(async () => {
          document.body
            .querySelector(`[data-testid="${testId}"]`)
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          await Promise.resolve();
        });
      };
      await click('watcher-management-delete-watcher-1');
      await click('watcher-management-confirm-delete-watcher-1');
      expect(deleteWatcher).toHaveBeenCalledWith('watcher-1', {
        notifySubscriber: false,
      });
      // The user arms the next row while the first delete is still settling.
      await click('watcher-management-delete-watcher-2');
      await act(async () => {
        settleFirst({ ok: true });
        await Promise.resolve();
      });
      expect(
        document.body.querySelector(
          '[data-testid="watcher-management-confirm-delete-watcher-2"]',
        ),
      ).not.toBeNull();
    } finally {
      useAppAdvisorWatchersStore.setState({
        deleteWatcher: original.deleteWatcher,
        deleteErrors: original.deleteErrors,
      });
    }
  });
});
