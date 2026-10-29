/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorktreeUpdatedFeedItem } from '@canopy/protocol';
import { SettingsOperationError } from '@canopy/protocol/settings';
import { FeedItemCard } from '../team-feed-cards';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';

const baseActor = { userId: '42', displayName: 'Grace Hopper' };

function makeWorktreeUpdatedItem(): WorktreeUpdatedFeedItem {
  return {
    id: 'worktree_updated:1',
    type: 'worktree_updated',
    occurredAt: new Date().toISOString(),
    actor: baseActor,
    worktreeId: 'wt-1',
    branchName: 'qrtp/can-393',
    summary:
      'Refined the feed card\nAdds markdown rendering.\n- Bold title\n- Collapsible body',
  };
}

describe('FeedItemCard worktree summary overflow toggle', () => {
  let container: HTMLElement;
  let root: Root;
  let scrollHeightDescriptor: PropertyDescriptor | undefined;
  let clientHeightDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'scrollHeight',
    );
    clientHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientHeight',
    );
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    restoreMetric('scrollHeight', scrollHeightDescriptor);
    restoreMetric('clientHeight', clientHeightDescriptor);
    jest.clearAllMocks();
  });

  function restoreMetric(
    name: 'scrollHeight' | 'clientHeight',
    descriptor: PropertyDescriptor | undefined,
  ): void {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, name);
    }
  }

  function mockSummaryBodyMetrics({
    scrollHeight,
    clientHeight,
  }: {
    scrollHeight: number;
    clientHeight: number;
  }): void {
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return hasWorktreeSummaryBodyClass(this) ? scrollHeight : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return hasWorktreeSummaryBodyClass(this) ? clientHeight : 0;
      },
    });
  }

  function hasWorktreeSummaryBodyClass(node: HTMLElement): boolean {
    return (
      typeof node.className === 'string' &&
      node.className.includes('prose') &&
      node.className.includes('line-clamp-3')
    );
  }

  async function renderCard(): Promise<void> {
    await act(async () => {
      root.render(
        <TestSettingsHost>
          <FeedItemCard item={makeWorktreeUpdatedItem()} orgId="org-1" />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
  }

  function findButton(label: string): HTMLButtonElement | null {
    return (
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === label,
      ) ?? null
    );
  }

  it('shows the expansion toggle only when the clamped summary body overflows', async () => {
    mockSummaryBodyMetrics({ scrollHeight: 120, clientHeight: 60 });

    await renderCard();

    const showMoreButton = findButton('Show more');
    expect(showMoreButton).not.toBeNull();

    await act(async () => {
      showMoreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(findButton('Show less')).not.toBeNull();
    expect(container.querySelector('.line-clamp-3')).toBeNull();
  });

  it('omits the expansion toggle when the clamped summary body fits', async () => {
    mockSummaryBodyMetrics({ scrollHeight: 60, clientHeight: 60 });

    await renderCard();

    expect(findButton('Show more')).toBeNull();
    expect(findButton('Show less')).toBeNull();
  });
});

describe('FeedItemCard worktree summary history timeline', () => {
  let container: HTMLElement;
  let root: Root;
  let fetchMock: jest.Mock<Promise<unknown>, [unknown]>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = jest.fn<Promise<unknown>, [unknown]>();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  /** The `organization.feed.summaryHistory` result the fake client answers. */
  function jsonResponse(body: unknown): unknown {
    return body;
  }

  async function renderCard(): Promise<void> {
    const client = createFakeSettingsClient({
      'organization.feed.summaryHistory': (input) => fetchMock(input),
    });
    const { host } = createTestSettingsHost({ client });
    await act(async () => {
      root.render(
        <TestSettingsHost host={host}>
          <FeedItemCard item={makeWorktreeUpdatedItem()} orgId="org-1" />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
  }

  function historyToggle(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="feed-summary-history-toggle"]',
    );
  }

  async function clickHistoryToggle(): Promise<void> {
    await act(async () => {
      historyToggle()?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('renders the history toggle for a card that has a summary', async () => {
    await renderCard();
    expect(historyToggle()).not.toBeNull();
    expect(historyToggle()?.textContent).toContain('History');
    // History is lazy: no request until the viewer expands it.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches and renders the snapshot timeline on first expand', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        entries: [
          {
            id: 'snap-2',
            summary: 'Second pass\nRefined the diff view.',
            generatedAt: new Date().toISOString(),
          },
          {
            id: 'snap-1',
            summary: 'First pass\nInitial scaffolding.',
            generatedAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      }),
    );

    await renderCard();
    await clickHistoryToggle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      itemId: 'worktree_updated:1',
    });

    const rows = container.querySelectorAll(
      '[data-testid="feed-summary-history-entry"]',
    );
    expect(rows).toHaveLength(2);
    expect(container.textContent).toContain('Second pass');
    expect(container.textContent).toContain('First pass');

    // Collapsing then re-expanding must not refetch.
    await clickHistoryToggle();
    await clickHistoryToggle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when the timeline has no entries', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ entries: [], nextCursor: null }),
    );

    await renderCard();
    await clickHistoryToggle();

    expect(container.textContent).toContain('No earlier versions.');
  });

  it('shows an error state when the history request fails', async () => {
    fetchMock.mockRejectedValue(
      new SettingsOperationError({
        code: 'failed',
        status: 500,
        message: 'boom',
      }),
    );

    await renderCard();
    await clickHistoryToggle();

    expect(container.textContent).toContain("Couldn't load history.");
  });

  function loadMoreButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      '[data-testid="feed-summary-history-load-more"]',
    );
  }

  async function clickLoadMore(): Promise<void> {
    await act(async () => {
      loadMoreButton()?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('pages through the timeline with "Load more", appending and forwarding the cursor', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            {
              id: 'snap-5',
              summary: 'Page one\nNewest snapshot.',
              generatedAt: new Date().toISOString(),
            },
          ],
          nextCursor: 'c1',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            {
              id: 'snap-4',
              summary: 'Page two\nOlder snapshot.',
              generatedAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        }),
      );

    await renderCard();
    await clickHistoryToggle();

    // First page rendered with a "Load more" affordance.
    expect(
      container.querySelectorAll('[data-testid="feed-summary-history-entry"]'),
    ).toHaveLength(1);
    expect(loadMoreButton()).not.toBeNull();

    await clickLoadMore();

    // Second call forwards the cursor from the first response.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith({
      organizationId: 'org-1',
      itemId: 'worktree_updated:1',
      cursor: 'c1',
    });

    // Entries are appended (both pages visible, newest-first order preserved).
    const rows = container.querySelectorAll(
      '[data-testid="feed-summary-history-entry"]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Page one');
    expect(rows[1]?.textContent).toContain('Page two');

    // Button disappears once the timeline is exhausted.
    expect(loadMoreButton()).toBeNull();
  });

  it('omits the "Load more" button when the first page has no next cursor', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        entries: [
          {
            id: 'snap-1',
            summary: 'Only page\nSingle snapshot.',
            generatedAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
      }),
    );

    await renderCard();
    await clickHistoryToggle();

    expect(
      container.querySelectorAll('[data-testid="feed-summary-history-entry"]'),
    ).toHaveLength(1);
    expect(loadMoreButton()).toBeNull();
  });

  it('clears a stale paging error when the panel is collapsed and reopened', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          entries: [
            {
              id: 'snap-5',
              summary: 'Page one\nNewest snapshot.',
              generatedAt: new Date().toISOString(),
            },
          ],
          nextCursor: 'c1',
        }),
      )
      .mockRejectedValueOnce(new Error('network down'));

    await renderCard();
    await clickHistoryToggle();

    // Paging fails: the retryable banner appears and entries stay intact.
    await clickLoadMore();
    expect(container.textContent).toContain("Couldn't load more. Try again.");
    expect(
      container.querySelectorAll('[data-testid="feed-summary-history-entry"]'),
    ).toHaveLength(1);

    // Collapsing and reopening must not resurface the stale error banner, and
    // must not refetch (the timeline was already loaded).
    await clickHistoryToggle();
    await clickHistoryToggle();
    expect(container.textContent).not.toContain(
      "Couldn't load more. Try again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      container.querySelectorAll('[data-testid="feed-summary-history-entry"]'),
    ).toHaveLength(1);
  });
});
