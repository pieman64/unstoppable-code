/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * CAN-3383 feed host: the feed-activity hint sits between the filter header
 * and the feed body, shows over empty and populated feeds, and hides while
 * any filter (including a not-yet-debounced search) is active.
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FeedPageResponse, PrMergedFeedItem } from '@canopy/protocol';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import type { ViewerDataSharingLoadState } from '../use-viewer-data-sharing';
import {
  OrganizationSettingsSlotsProvider,
  type OrganizationDataSharingOptInProps,
  type OrganizationSettingsSlots,
} from '../organization-settings-slots';

const mockGetTeamFeed = jest.fn<Promise<FeedPageResponse>, [unknown]>();

jest.mock('../team-feed-cards', () => ({
  FeedItemCard: (): null => null,
  FeedActorProfileLinksProvider: ({
    children,
  }: {
    children: ReactNode;
  }): ReactNode => children,
}));

const mockUseViewerDataSharing = jest.fn<
  ViewerDataSharingLoadState,
  [string | null]
>();
jest.mock('../use-viewer-data-sharing', () => ({
  useViewerDataSharing: (orgId: string | null): ViewerDataSharingLoadState =>
    mockUseViewerDataSharing(orgId),
}));

import { TeamFeedSection } from '../team-feed-section';

const ORG_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
const HINT = '[data-testid="data-sharing-opt-in-feed-activity"]';

const PRIVATE_METADATA: ViewerDataSharingLoadState = {
  state: 'ready',
  status: {
    viewerUserId: '0d9e8f7a-6b5c-4d3e-9f1a-2b3c4d5e6f70',
    scopes: {
      metadata: 'private',
      plans: 'unknown',
      summaries: 'unknown',
      transcripts: 'unknown',
    },
  },
};

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

describe('TeamFeedSection data-sharing hint', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    mockGetTeamFeed.mockResolvedValue({ items: [], nextCursor: null });
    mockUseViewerDataSharing.mockReturnValue(PRIVATE_METADATA);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(
    personal = false,
    slots: OrganizationSettingsSlots = {},
  ): Promise<void> {
    const client = createFakeSettingsClient({
      'organization.feed.page': (input) => mockGetTeamFeed(input),
    });
    const { host } = createTestSettingsHost({ client });
    act(() => {
      root.render(
        <TestSettingsHost host={host}>
          <OrganizationSettingsSlotsProvider slots={slots}>
            <TeamFeedSection
              orgId={ORG_ID}
              organizationName="Acme"
              mobileBrowser={false}
              canManageMembers={false}
              personal={personal}
            />
          </OrganizationSettingsSlotsProvider>
        </TestSettingsHost>,
      );
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
  }

  function hint(): HTMLElement | null {
    return container.querySelector(HINT);
  }

  it('sits between the filter header and an empty feed', async () => {
    await render();
    expect(mockUseViewerDataSharing).toHaveBeenCalledWith(ORG_ID);
    const element = hint();
    expect(element).not.toBeNull();
    expect(element?.previousElementSibling?.getAttribute('data-testid')).toBe(
      'team-feed-header',
    );
  });

  it('hands off to the desktop review where the host has no inline opt-in', async () => {
    await render();
    expect(hint()?.textContent).toContain('desktop app first');
  });

  it('renders the host opt-in slot instead of the desktop handoff', async () => {
    const slotProps: OrganizationDataSharingOptInProps[] = [];
    const DataSharingOptIn = (
      props: OrganizationDataSharingOptInProps,
    ): JSX.Element => {
      slotProps.push(props);
      return <div data-testid="host-opt-in" />;
    };
    await render(false, { DataSharingOptIn });
    expect(hint()).toBeNull();
    expect(
      container.querySelector('[data-testid="host-opt-in"]'),
    ).not.toBeNull();
    expect(slotProps.at(-1)).toEqual({
      feature: 'feed-activity',
      organizationId: ORG_ID,
    });
  });

  it('does not render the host opt-in slot for a Personal feed', async () => {
    const DataSharingOptIn = (): JSX.Element => (
      <div data-testid="host-opt-in" />
    );
    await render(true, { DataSharingOptIn });
    expect(container.querySelector('[data-testid="host-opt-in"]')).toBeNull();
  });

  it('also shows above a populated feed', async () => {
    mockGetTeamFeed.mockResolvedValue({ items: [FEED_ITEM], nextCursor: null });
    await render();
    expect(hint()).not.toBeNull();
  });

  it('does not fetch or show a team sharing hint for a Personal feed', async () => {
    await render(true);
    expect(mockUseViewerDataSharing).toHaveBeenCalledWith(null);
    expect(hint()).toBeNull();
  });

  it('renders nothing while the viewer status is loading', async () => {
    mockUseViewerDataSharing.mockReturnValue({ state: 'loading' });
    await render();
    expect(hint()).toBeNull();
  });

  it('hides while a type filter is active', async () => {
    await render();
    const chip = container.querySelector<HTMLButtonElement>(
      '[data-testid="team-feed-type-pr_merged"]',
    );
    act(() => {
      chip?.click();
    });
    expect(hint()).toBeNull();

    const clear = container.querySelector<HTMLButtonElement>(
      '[data-testid="team-feed-clear-filters"]',
    );
    act(() => {
      clear?.click();
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    expect(hint()).not.toBeNull();
  });

  it('hides as soon as the viewer types a search', async () => {
    await render();
    const search = container.querySelector<HTMLInputElement>(
      '[data-testid="team-feed-search"]',
    );
    if (!search) throw new Error('Missing search input');
    act(() => {
      // The native setter, so React's input tracking sees the change.
      Reflect.set(HTMLInputElement.prototype, 'value', 'deploy', search);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(hint()).toBeNull();
  });
});
