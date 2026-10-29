/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FeedPageResponse, PrMergedFeedItem } from '@canopy/protocol';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';

const mockGetTeamFeed = jest.fn<Promise<FeedPageResponse>, []>();

// The cards are irrelevant here — only the sentinel below them matters.
jest.mock('../team-feed-cards', () => ({
  FeedItemCard: (): null => null,
  FeedActorProfileLinksProvider: ({
    children,
  }: {
    children: ReactNode;
  }): ReactNode => children,
}));

/**
 * A real `PrMergedFeedItem`, not a cast partial: the cards are mocked out, so
 * only the list branch and its actor lookup read this, but an annotated
 * fixture is what keeps the shape honest if `FeedItem` changes.
 */
const FEED_ITEM: PrMergedFeedItem = {
  id: 'pr_merged:1',
  type: 'pr_merged',
  occurredAt: '2026-01-01T00:00:00.000Z',
  actor: { userId: 'user-1', displayName: 'Ada' },
  worktreeId: null,
  repoName: 'unstoppabledomains/canopy',
  prNumber: 1,
  prUrl: 'https://github.com/unstoppabledomains/canopy/pull/1',
  title: 'Merged pull request',
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

import { TeamFeedSection } from '../team-feed-section';

interface ObserverRecord {
  readonly root: Element | Document | null | undefined;
  readonly observed: Element[];
}

const observers: ObserverRecord[] = [];

class RecordingIntersectionObserver {
  private readonly record: ObserverRecord;
  constructor(_callback: IntersectionObserverCallback, init?: { root?: null }) {
    this.record = { root: init?.root, observed: [] };
    observers.push(this.record);
  }
  observe(target: Element): void {
    this.record.observed.push(target);
  }
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): [] {
    return [];
  }
}

describe('TeamFeedSection infinite-scroll observer root', () => {
  let container: HTMLElement;
  let root: Root;
  let scrollRegion: HTMLElement;

  beforeEach(() => {
    observers.length = 0;
    // One page WITH a cursor, so the infinite-scroll sentinel renders and the
    // observer under test is constructed. Set per test: `resetMocks` strips
    // implementations between tests.
    mockGetTeamFeed.mockResolvedValue({
      items: [FEED_ITEM],
      nextCursor: 'cursor-2',
    });
    global.IntersectionObserver =
      RecordingIntersectionObserver as unknown as typeof IntersectionObserver;
    container = document.createElement('div');
    document.body.appendChild(container);
    scrollRegion = document.createElement('div');
    document.body.appendChild(scrollRegion);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    scrollRegion.remove();
  });

  async function render(element: HTMLElement | null): Promise<void> {
    const client = createFakeSettingsClient({
      'organization.feed.page': () => mockGetTeamFeed(),
    });
    // The host's settings scroll region (`null` outside one).
    const host = {
      ...createTestSettingsHost({ client }).host,
      useScrollElement: (): HTMLElement | null => element,
    };
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <TeamFeedSection
            orgId="org-1"
            organizationName="Acme"
            mobileBrowser={false}
            canManageMembers={false}
          />
        </TestSettingsHost>,
      );
    });
    // The initial page resolves through a couple of microtask hops before the
    // cursor commits and the sentinel (and its observer) mount.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  it('observes against the host settings scroll region, not the document viewport', async () => {
    // Inside the shared sidebar chrome the page sits in a nested scroller. An
    // observer left on the default (viewport) root never sees the sentinel,
    // which silently stops paging after the first page.
    await render(scrollRegion);

    expect(observers.length).toBeGreaterThan(0);
    expect(observers.at(-1)?.root).toBe(scrollRegion);
  });

  it('falls back to the viewport root when the host has no scroll region', async () => {
    await render(null);

    expect(observers.length).toBeGreaterThan(0);
    expect(observers.at(-1)?.root).toBeNull();
  });
});
