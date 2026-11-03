/**
 * @jest-environment jsdom
 */
// `Object.assign` rather than a cast: the repo forbids `as` for type coercion,
// and this sets the same global with the same runtime effect.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DigestArchiveItem } from '@canopy/protocol/settings';
import type { MemberProfileHeader } from '@canopy/protocol/team';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';

const mockFetchDigests = jest.fn();

jest.mock('../profile-api', () => ({
  fetchMemberProfileDigests: (...args: unknown[]): unknown =>
    mockFetchDigests(...args),
  fetchMemberSharedPlans: jest.fn(() =>
    Promise.resolve({
      items: [],
      nextCursor: null,
    }),
  ),
  fetchMemberApprovedPlans: jest.fn(() =>
    Promise.resolve({
      items: [],
      nextCursor: null,
    }),
  ),
  fetchMemberSharedRuns: jest.fn(() =>
    Promise.resolve({ items: [], nextCursor: null }),
  ),
  fetchMemberSharedPipelines: jest.fn(() =>
    Promise.resolve({
      items: [],
      nextCursor: null,
    }),
  ),
}));

let mockTabParam: string | null = null;
const mockReplace = jest.fn();
const client = createFakeSettingsClient();

/** The profile route's host: its path, the `?tab=` under test, a router. */
function inHost(node: ReactNode): JSX.Element {
  const { host } = createTestSettingsHost({
    client,
    pathname: '/organization/org-1/members/user-1',
    search: mockTabParam === null ? '' : `tab=${mockTabParam}`,
    router: { replace: mockReplace },
  });
  return <TestSettingsHost host={host}>{node}</TestSettingsHost>;
}

import { MemberProfilePage } from '../MemberProfilePage';
import { ProfileDigestsSection } from '../ProfileDigestsSection';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockTabParam = null;
  mockFetchDigests.mockReset();
  mockReplace.mockReset();
  mockFetchDigests.mockResolvedValue([]);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

const MEMBER: MemberProfileHeader = {
  id: 'user-1',
  name: 'Grace',
  email: 'grace@example.com',
  image: null,
  role: 'MEMBER',
  memberSinceIso: '2026-01-01T00:00:00.000Z',
};

function makeDigest(
  overrides: Partial<DigestArchiveItem> = {},
): DigestArchiveItem {
  return {
    externalId: 'digest-1',
    cadence: 'WEEKLY',
    periodStart: '2026-08-10T00:00:00.000Z',
    periodEnd: '2026-08-17T00:00:00.000Z',
    headline: 'Shipped the archive',
    variant: 'FULL',
    status: 'READY',
    billedCredits: null,
    createdAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

async function renderProfile(
  props: Partial<Parameters<typeof MemberProfilePage>[0]> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      inHost(
        <MemberProfilePage
          org={{ id: 'org-1', name: 'Acme' }}
          member={MEMBER}
          viewerCanViewStats={false}
          editContext={null}
          mobileBrowser={false}
          {...props}
        />,
      ),
    );
    await Promise.resolve();
  });
}

describe('MemberProfilePage: Digests tab visibility', () => {
  it('places Digests immediately after Overview when it is shown', async () => {
    await renderProfile({ showDigestsTab: true });

    const keys = Array.from(
      container.querySelectorAll('[data-testid^="profile-tab-"]'),
    ).map((el) =>
      (el.getAttribute('data-testid') ?? '').replace('profile-tab-', ''),
    );
    expect(keys).toEqual(['overview', 'digests', 'runs', 'plans', 'pipelines']);
  });

  it('omits the tab when nothing is featured for this viewer', async () => {
    // The whole point of the conditional tab: without it every profile in the
    // org would grow a Digests tab that resolves to an empty list.
    await renderProfile({ showDigestsTab: false });

    expect(
      container.querySelector('[data-testid="profile-tab-digests"]'),
    ).toBeNull();
  });

  it('falls back to Overview when ?tab=digests is not available to this viewer', async () => {
    // A shared deep link outliving the feature is normal, not an edge case:
    // the owner can unfeature at any time.
    mockTabParam = 'digests';
    await renderProfile({ showDigestsTab: false });

    expect(
      container.querySelector('[data-testid="profile-digests-tab"]'),
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="profile-tab-overview"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true');
    // The URL must converge on what was actually rendered. Without this the
    // address bar keeps `?tab=digests` while Overview shows, so the selected tab
    // and the URL disagree and a refresh carries the dead param forward.
    // `replace`, not `push`, so the fallback adds no history entry for Back to
    // bounce off.
    expect(mockReplace).toHaveBeenCalledWith(
      '/organization/org-1/members/user-1',
    );
  });

  it('leaves the URL alone when the digests tab is available', async () => {
    // Guards the convergence effect from firing on the happy path, where it
    // would strip a legitimate `?tab=digests` out from under the user.
    mockTabParam = 'digests';
    mockFetchDigests.mockResolvedValue([]);
    await renderProfile({ showDigestsTab: true });

    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('renders the digests pane on ?tab=digests when it is available', async () => {
    mockTabParam = 'digests';
    mockFetchDigests.mockResolvedValue([makeDigest()]);
    await renderProfile({ showDigestsTab: true });

    expect(
      container.querySelector('[data-testid="profile-digests-tab"]'),
    ).not.toBeNull();
    expect(mockFetchDigests).toHaveBeenCalledWith(client, 'org-1', 'user-1');
  });

  it('does not fetch digests until the tab is selected', async () => {
    await renderProfile({ showDigestsTab: true });

    expect(mockFetchDigests).not.toHaveBeenCalled();
  });

  it('renders no tabs at all while the org is lapsed', async () => {
    await renderProfile({ showDigestsTab: true, orgLapsed: true });

    expect(container.querySelector('[data-testid="profile-tabs"]')).toBeNull();
  });
});

describe('ProfileDigestsSection', () => {
  async function renderSection(isOwnProfile: boolean): Promise<void> {
    await act(async () => {
      root.render(
        inHost(
          <ProfileDigestsSection
            orgId="org-1"
            userId="user-1"
            memberName="Grace"
            isOwnProfile={isOwnProfile}
          />,
        ),
      );
      await Promise.resolve();
    });
  }

  it('links the owner’s own rows to the canonical personal archive', async () => {
    mockFetchDigests.mockResolvedValue([makeDigest()]);
    await renderSection(true);

    expect(container.textContent).toContain('Your work digests');
    expect(
      container
        .querySelector('[data-testid="profile-digests-archive-link"]')
        ?.getAttribute('href'),
    ).toBe('/account/digests');
    const row = container.querySelector('a[href*="digest-1"]');
    expect(row?.getAttribute('href')).toBe('/account/digests/digest-1');
  });

  it('links another member’s rows to the protected member-scoped route', async () => {
    // The account permalink would 404 for a viewer who is not the owner, and
    // only the member route applies the share-safe projection.
    mockFetchDigests.mockResolvedValue([makeDigest()]);
    await renderSection(false);

    expect(container.textContent).toContain('Shared digests');
    expect(
      container.querySelector('[data-testid="profile-digests-archive-link"]'),
    ).toBeNull();
    const row = container.querySelector('a[href*="digest-1"]');
    expect(row?.getAttribute('href')).toBe(
      '/organization/org-1/members/user-1/digests/digest-1',
    );
  });

  it('shows the self empty state when the owner has no digests', async () => {
    mockFetchDigests.mockResolvedValue([]);
    await renderSection(true);

    expect(container.textContent).toContain('No work digests yet.');
  });

  it('shows the race-condition empty state for another viewer', async () => {
    // Reachable when the last feature is removed between the tab rendering
    // and this fetch resolving.
    mockFetchDigests.mockResolvedValue([]);
    await renderSection(false);

    expect(container.textContent).toContain(
      "Grace hasn't shared any work digests with this organization.",
    );
  });

  it('surfaces a retryable message when the request fails', async () => {
    mockFetchDigests.mockRejectedValueOnce(new Error('SENTINEL-SERVER-BODY'));
    mockFetchDigests.mockResolvedValueOnce([makeDigest()]);
    await renderSection(false);

    const error = container.querySelector(
      '[data-testid="profile-digests-error"]',
    );
    expect(error?.textContent).toContain("Couldn't load this.");
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try again',
    );
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetchDigests).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="profile-digests-error"]'),
    ).toBeNull();
    expect(container.textContent).toContain('Shared digests');
  });
});
