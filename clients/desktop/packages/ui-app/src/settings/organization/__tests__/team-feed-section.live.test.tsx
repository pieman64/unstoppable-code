/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The feed's live stream through the host settings client: live items fold
 * into the list, pausing buffers them behind "N new", a reconnect refetches
 * page 1, and a terminal stream error stops live mode for the manual refresh
 * control. Pagination and permalinks run through the same client.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FeedPageResponse, PrMergedFeedItem } from '@canopy/protocol';
import type { OrganizationMember } from '@canopy/protocol/settings/organization';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { TeamFeedSection } from '../team-feed-section';

const ORG_ID = 'org-1';

function prMerged(id: string, title = `PR ${id}`): PrMergedFeedItem {
  return {
    id: `pr_merged:${id}`,
    type: 'pr_merged',
    occurredAt: '2026-01-01T00:00:00.000Z',
    actor: { userId: 'user-1', displayName: 'Ada' },
    worktreeId: null,
    repoName: 'unstoppabledomains/canopy',
    prNumber: Number(id),
    prUrl: `https://github.com/unstoppabledomains/canopy/pull/${id}`,
    title,
    branchName: null,
    summary: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    totalCostUsd: null,
    totalTokens: null,
    models: [],
    planId: null,
    sharedPlanId: null,
    planTitle: null,
    runUrl: null,
  };
}

const MEMBER: OrganizationMember = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  image: null,
  role: 'MEMBER',
  subTeamIds: [],
};

interface ObserverRecord {
  readonly callback: IntersectionObserverCallback;
  readonly root: Element | Document | null | undefined;
}

const observers: ObserverRecord[] = [];

class RecordingIntersectionObserver {
  constructor(
    callback: IntersectionObserverCallback,
    init?: { root?: Element | Document | null },
  ) {
    observers.push({ callback, root: init?.root });
  }
  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): [] {
    return [];
  }
}

describe('TeamFeedSection live stream', () => {
  let container: HTMLElement;
  let root: Root;
  let feedPage: jest.Mock<Promise<FeedPageResponse>, [unknown]>;
  let client: FakeSettingsClient;

  beforeEach(() => {
    observers.length = 0;
    global.IntersectionObserver =
      RecordingIntersectionObserver as unknown as typeof IntersectionObserver;
    feedPage = jest.fn<Promise<FeedPageResponse>, [unknown]>(() =>
      Promise.resolve({ items: [prMerged('1')], nextCursor: null }),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  async function render(
    options: {
      highlightItemId?: string;
      feedItem?: (input: unknown) => unknown;
      blockClassName?: string;
      members?: OrganizationMember[];
    } = {},
  ): Promise<void> {
    client = createFakeSettingsClient({
      'organization.feed.page': (input) => feedPage(input),
      ...(options.feedItem === undefined
        ? {}
        : { 'organization.feed.item': options.feedItem }),
    });
    const { host } = createTestSettingsHost({
      client,
      ...(options.blockClassName === undefined
        ? {}
        : {
            privacy: {
              blockClassName: options.blockClassName,
              maskClassName: '',
            },
          }),
    });
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <TeamFeedSection
            orgId={ORG_ID}
            organizationName="Acme"
            mobileBrowser={false}
            canManageMembers={false}
            personal
            members={options.members}
            highlightItemId={options.highlightItemId}
          />
        </TestSettingsHost>,
      );
    });
    await flush();
  }

  function itemIds(): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid="feed-item"]'),
    ).map((element) => element.dataset.feedItemId ?? '');
  }

  function byTestId(testId: string): HTMLElement | null {
    return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  async function emitItem(
    item: PrMergedFeedItem,
    sequence: number,
  ): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      client.emit({
        type: 'feed.item',
        organizationId: ORG_ID,
        sequence,
        eventId: `event-${sequence}`,
        item,
      });
    });
  }

  it('subscribes to the organization feed and prepends live items', async () => {
    await render();
    expect(client.subscriptions).toEqual([
      { kind: 'organization-feed', organizationId: ORG_ID },
    ]);
    expect(itemIds()).toEqual(['pr_merged:1']);

    act(() => {
      client.emit({ type: 'state', organizationId: ORG_ID, state: 'open' });
    });
    expect(byTestId('team-feed-live-toggle')?.textContent).toContain('Live');

    await emitItem(prMerged('2'), 1);
    expect(itemIds()).toEqual(['pr_merged:2', 'pr_merged:1']);

    // A replayed event is delivered once.
    await emitItem(prMerged('2'), 1);
    expect(itemIds()).toEqual(['pr_merged:2', 'pr_merged:1']);
  });

  it('buffers live items behind "N new" while paused and catches up on page 1', async () => {
    await render();
    act(() => {
      byTestId('team-feed-live-toggle')?.click();
    });
    await flush();
    expect(byTestId('team-feed-live-toggle')?.textContent).toContain('Paused');
    const callsBefore = feedPage.mock.calls.length;

    await emitItem(prMerged('2'), 1);
    expect(itemIds()).toEqual(['pr_merged:1']);
    expect(byTestId('team-feed-new-items')?.textContent).toContain('1 new');

    feedPage.mockResolvedValueOnce({
      items: [prMerged('2'), prMerged('1')],
      nextCursor: null,
    });
    act(() => {
      byTestId('team-feed-new-items')?.click();
    });
    await flush();
    expect(feedPage.mock.calls.length).toBe(callsBefore + 1);
    expect(feedPage).toHaveBeenLastCalledWith({ organizationId: ORG_ID });
    expect(itemIds()).toEqual(['pr_merged:2', 'pr_merged:1']);
    expect(byTestId('team-feed-new-items')).toBeNull();
  });

  it('refetches page 1 when the stream reconnects', async () => {
    await render();
    expect(feedPage).toHaveBeenCalledTimes(1);

    feedPage.mockResolvedValueOnce({
      items: [prMerged('3'), prMerged('1')],
      nextCursor: null,
    });
    act(() => {
      client.emit({ type: 'reconnected', organizationId: ORG_ID });
    });
    await flush();

    expect(feedPage).toHaveBeenCalledTimes(2);
    // Page 1: no cursor.
    expect(feedPage).toHaveBeenLastCalledWith({ organizationId: ORG_ID });
    expect(itemIds()).toEqual(['pr_merged:3', 'pr_merged:1']);
  });

  it('stops live mode for the manual refresh control on a terminal stream error', async () => {
    await render();
    expect(byTestId('team-feed-live-toggle')).not.toBeNull();

    act(() => {
      client.emit({
        type: 'state',
        organizationId: ORG_ID,
        state: 'disabled',
        error: 'expired',
      });
    });
    await flush();

    expect(byTestId('team-feed-live-toggle')).toBeNull();
    const refresh = byTestId('team-feed-refresh');
    expect(refresh).not.toBeNull();

    // The stream is stopped: later frames are ignored.
    await emitItem(prMerged('9'), 5);
    expect(itemIds()).toEqual(['pr_merged:1']);

    // Manual refresh still reads page 1.
    feedPage.mockResolvedValueOnce({
      items: [prMerged('9'), prMerged('1')],
      nextCursor: null,
    });
    act(() => {
      refresh?.click();
    });
    await flush();
    expect(feedPage).toHaveBeenLastCalledWith({ organizationId: ORG_ID });
    expect(itemIds()).toEqual(['pr_merged:9', 'pr_merged:1']);
    expect(byTestId('team-feed-live-toggle')).toBeNull();
  });

  it('pages older items through the scroll observer and drops duplicates', async () => {
    feedPage.mockResolvedValueOnce({
      items: [prMerged('3'), prMerged('2')],
      nextCursor: 'cursor-2',
    });
    await render();
    expect(byTestId('team-feed-sentinel')).not.toBeNull();
    const observer = observers.at(-1);
    expect(observer?.root).toBeNull();

    feedPage.mockResolvedValueOnce({
      items: [prMerged('2'), prMerged('1')],
      nextCursor: null,
    });
    act(() => {
      observer?.callback(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await flush();

    expect(feedPage).toHaveBeenLastCalledWith({
      organizationId: ORG_ID,
      cursor: 'cursor-2',
    });
    expect(itemIds()).toEqual(['pr_merged:3', 'pr_merged:2', 'pr_merged:1']);
    expect(byTestId('team-feed-sentinel')).toBeNull();
  });

  it('opens a permalink window and highlights the anchor', async () => {
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const feedItem = jest.fn(() =>
      Promise.resolve({
        anchor: prMerged('2'),
        newer: [prMerged('3')],
        older: [prMerged('1')],
        backwardCursor: null,
      }),
    );
    await render({ highlightItemId: 'pr_merged:2', feedItem });

    expect(feedItem).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      itemId: 'pr_merged:2',
    });
    expect(feedPage).not.toHaveBeenCalled();
    expect(itemIds()).toEqual(['pr_merged:3', 'pr_merged:2', 'pr_merged:1']);
    const anchor = container.querySelector('#feed-item-pr_merged\\:2');
    expect(anchor?.className).toContain('ring-2');
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it('blocks feed user content from session replay', async () => {
    await render({ blockClassName: 'ph-no-capture' });
    const card = container.querySelector('[data-testid="feed-item"]');
    expect(
      card?.querySelector('[data-testid="feed-item-avatar"]')?.className,
    ).toContain('ph-no-capture');
    expect(card?.querySelectorAll('.ph-no-capture').length).toBeGreaterThan(2);
  });

  it('adds no class token when the host has no replay privacy', async () => {
    await render();
    const avatar = container.querySelector('[data-testid="feed-item-avatar"]');
    expect(avatar?.className).toBe('relative mt-0.5 shrink-0');
  });
});

describe('TeamFeedSection member filter privacy', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('blocks member names in the filter', () => {
    const client = createFakeSettingsClient({
      'organization.feed.page': () =>
        Promise.resolve({ items: [], nextCursor: null }),
    });
    const { host } = createTestSettingsHost({
      client,
      privacy: { blockClassName: 'ph-no-capture', maskClassName: '' },
    });
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <TeamFeedSection
            orgId={ORG_ID}
            organizationName="Acme"
            mobileBrowser={false}
            canManageMembers={false}
            members={[MEMBER]}
          />
        </TestSettingsHost>,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="team-feed-member-filter"]',
    );
    if (trigger === null) throw new Error('no member filter');
    act(() => trigger.click());
    const option = document.querySelector<HTMLElement>(
      `[data-testid="team-feed-member-filter-option-${MEMBER.id}"]`,
    );
    if (option === null) throw new Error('no member option');
    const name = Array.from(option.querySelectorAll('span')).find(
      (span) => span.textContent === 'Ada Lovelace',
    );
    expect(name?.className).toContain('ph-no-capture');
    act(() => option.click());
    // The picked name shows on the trigger, blocked, and stays out of its
    // accessible name, which session replay records as written.
    expect(trigger.querySelector('.ph-no-capture')?.textContent).toBe(
      'Ada Lovelace',
    );
    expect(trigger.getAttribute('aria-label')).toBe('Member');
  });
});
