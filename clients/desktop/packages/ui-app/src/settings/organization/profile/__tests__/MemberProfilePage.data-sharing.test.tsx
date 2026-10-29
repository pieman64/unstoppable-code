/**
 * @jest-environment jsdom
 */
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * CAN-3383 profile host: the member-profiles hint renders once, above the
 * tabs, and only on the viewer's own profile. Another member's profile never
 * even requests the viewer's status, so it cannot explain their missing work.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MemberProfileHeader } from '@canopy/protocol/team';
import {
  createTestSettingsHost,
  TestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';
import type { ViewerDataSharingLoadState } from '../../use-viewer-data-sharing';

jest.mock('../profile-api', () => ({
  fetchMemberProfileDigests: jest.fn(() => Promise.resolve([])),
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

// The overview body is irrelevant here; only the hint's placement matters.
jest.mock('../ProfileOverviewSection', () => ({
  ProfileOverviewSection: (): null => null,
}));

const mockUseViewerDataSharing = jest.fn<
  ViewerDataSharingLoadState,
  [string | null]
>();
jest.mock('../../use-viewer-data-sharing', () => ({
  useViewerDataSharing: (orgId: string | null): ViewerDataSharingLoadState =>
    mockUseViewerDataSharing(orgId),
}));

import { MemberProfilePage } from '../MemberProfilePage';

const host = createTestSettingsHost({
  pathname: '/organization/org/members/user',
}).host;

const ORG = { id: '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f', name: 'Acme' };
const VIEWER = '0d9e8f7a-6b5c-4d3e-9f1a-2b3c4d5e6f70';
const HINT = '[data-testid="data-sharing-opt-in-member-profiles"]';

const MEMBER: MemberProfileHeader = {
  id: VIEWER,
  name: 'Grace',
  email: 'grace@example.com',
  image: null,
  role: 'MEMBER',
  memberSinceIso: '2026-01-01T00:00:00.000Z',
};

const PRIVATE_METADATA: ViewerDataSharingLoadState = {
  state: 'ready',
  status: {
    viewerUserId: VIEWER,
    scopes: {
      metadata: 'private',
      plans: 'unknown',
      summaries: 'unknown',
      transcripts: 'unknown',
    },
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // The web Jest config cleared mocks between tests; the root one does not.
  jest.clearAllMocks();
  window.localStorage.clear();
  mockUseViewerDataSharing.mockImplementation(
    (orgId: string | null): ViewerDataSharingLoadState =>
      orgId === null ? { state: 'idle' } : PRIVATE_METADATA,
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function renderProfile(
  props: Partial<Parameters<typeof MemberProfilePage>[0]> = {},
): Promise<void> {
  await act(async () => {
    root.render(
      <TestSettingsHost host={host}>
        <MemberProfilePage
          org={ORG}
          member={MEMBER}
          viewerCanViewStats={false}
          editContext={null}
          mobileBrowser={false}
          {...props}
        />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
}

describe('MemberProfilePage layout', () => {
  it('sits in the shared settings column with its back link leading', async () => {
    await renderProfile();
    const column = container.querySelector(
      '[data-testid="settings-page-column"]',
    );
    expect(container.firstElementChild).toBe(column);
    expect(column?.className).toContain('max-w-5xl');
    const page = container.querySelector('[data-testid="member-profile-page"]');
    expect(page?.parentElement).toBe(column);
    expect(page?.firstElementChild?.getAttribute('data-testid')).toBe(
      'member-profile-back',
    );
  });
});

describe('MemberProfilePage data-sharing hint', () => {
  it('renders once, directly above the tabs, on the own profile', async () => {
    await renderProfile({ isOwnProfile: true });
    expect(mockUseViewerDataSharing).toHaveBeenCalledWith(ORG.id);
    const hints = container.querySelectorAll(HINT);
    expect(hints).toHaveLength(1);
    const tabs = container.querySelector('[data-testid="profile-tabs"]');
    expect(hints[0]?.nextElementSibling?.contains(tabs)).toBe(true);
  });

  it('never requests or renders on another member’s profile', async () => {
    await renderProfile({ isOwnProfile: false });
    expect(mockUseViewerDataSharing).not.toHaveBeenCalledWith(ORG.id);
    expect(container.querySelector(HINT)).toBeNull();
  });

  it('stays hidden while ownership is not established', async () => {
    await renderProfile();
    expect(container.querySelector(HINT)).toBeNull();
  });

  it('stays hidden on a lapsed organization', async () => {
    await renderProfile({ isOwnProfile: true, orgLapsed: true });
    expect(container.querySelector(HINT)).toBeNull();
  });

  it('gives mobile browsers text guidance', async () => {
    await renderProfile({ isOwnProfile: true, mobileBrowser: true });
    expect(
      container.querySelector(
        '[data-testid="data-sharing-opt-in-member-profiles-mobile"]',
      ),
    ).not.toBeNull();
  });
});
