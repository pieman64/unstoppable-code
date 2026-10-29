/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ApprovedPlanSummary,
  SharedPlanSummary,
} from '@canopy/protocol/plans';
import type { PipelineApiItem } from '@canopy/protocol/pipelines';

const mockFetchPlans = jest.fn();
const mockFetchApprovedPlans = jest.fn();
const mockFetchPipelines = jest.fn();

jest.mock('../profile-api', () => ({
  fetchMemberSharedPlans: (...args: unknown[]): unknown =>
    mockFetchPlans(...args),
  fetchMemberApprovedPlans: (...args: unknown[]): unknown =>
    mockFetchApprovedPlans(...args),
  fetchMemberSharedPipelines: (...args: unknown[]): unknown =>
    mockFetchPipelines(...args),
}));

import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
} from '../../../__tests__/helpers/test-settings-host';
import { ProfilePlansSection } from '../ProfilePlansSection';
import { ProfileApprovedPlansSection } from '../ProfileApprovedPlansSection';
import { ProfilePipelinesSection } from '../ProfilePipelinesSection';

function makePlan(
  overrides: Partial<SharedPlanSummary> = {},
): SharedPlanSummary {
  return {
    id: 'plan-1',
    title: 'Ship the profile page',
    contentHash: 'c',
    diagramsHash: 'd',
    snapshotHash: 's',
    localRevisionNumber: 1,
    remoteRevisionNumber: 1,
    repositories: [
      {
        repoId: 'r1',
        repoName: 'canopy',
        remoteUrl: null,
        branch: null,
        commitSha: null,
        defaultBranch: null,
      },
    ],
    shareScope: 'organization',
    owner: { type: 'organization', id: 'org-1', name: 'Acme' },
    createdBy: { id: 'u1', name: 'Grace', email: 'g@example.com' },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-02-01T00:00:00.000Z',
    canUpdate: false,
    canDelete: false,
    ...overrides,
  };
}

function makeApprovedPlan(
  overrides: Partial<ApprovedPlanSummary> = {},
): ApprovedPlanSummary {
  return {
    id: 'approved-1',
    title: 'Refactor the executor',
    reviewStatus: 'approved',
    planVersion: 2,
    implementationStartedAt: '2024-03-01T00:00:00.000Z',
    updatedAt: '2024-03-02T00:00:00.000Z',
    ...overrides,
  };
}

function makePipeline(
  overrides: Partial<PipelineApiItem> = {},
): PipelineApiItem {
  return {
    id: 'pipe-1',
    name: 'Nightly review',
    description: 'Runs the review bot',
    icon: 'workflow',
    version: '1',
    triggerTypes: [],
    createdBy: { id: 'u1', name: 'Grace' },
    shareScope: 'organization',
    owner: { type: 'organization', id: 'org-1', name: 'Acme' },
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-02-01T00:00:00.000Z',
    canUpdate: false,
    canDelete: false,
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

const client = createFakeSettingsClient();
const host = createTestSettingsHost({ client }).host;

/** Sections render inside a settings host; their loaders are mocked above. */
function inHost(node: ReactNode): JSX.Element {
  return <TestSettingsHost host={host}>{node}</TestSettingsHost>;
}

beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('ProfilePlansSection', () => {
  it('renders an empty state when the member has no shared plans', async () => {
    mockFetchPlans.mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => {
      root.render(
        inHost(
          <ProfilePlansSection orgId="org-1" userId="u1" memberName="Grace" />,
        ),
      );
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="profile-plans-empty"]'),
    ).not.toBeNull();
  });

  it('shows an error instead of the empty-state copy when the initial fetch fails', async () => {
    mockFetchPlans.mockRejectedValue(new Error('SENTINEL-SERVER-BODY'));
    await act(async () => {
      root.render(
        inHost(
          <ProfilePlansSection orgId="org-1" userId="u1" memberName="Grace" />,
        ),
      );
      await Promise.resolve();
    });
    await flush();
    // The misleading "hasn't shared any plans" copy must not render on error.
    expect(
      container.querySelector('[data-testid="profile-plans-empty"]'),
    ).toBeNull();
    expect(container.textContent).toContain("Couldn't load this. Try again.");
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });

  it('reloads the first page when Retry is pressed after a failed load', async () => {
    mockFetchPlans.mockRejectedValueOnce(new Error('SENTINEL-SERVER-BODY'));
    mockFetchPlans.mockResolvedValueOnce({
      items: [makePlan()],
      nextCursor: null,
    });
    await act(async () => {
      root.render(
        inHost(
          <ProfilePlansSection orgId="org-1" userId="u1" memberName="Grace" />,
        ),
      );
      await Promise.resolve();
    });
    await flush();

    const retry = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Retry',
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();

    expect(mockFetchPlans).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="profile-plans-list"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("Couldn't load this.");
  });

  it('renders plan rows that link to the plan detail route', async () => {
    mockFetchPlans.mockResolvedValue({
      items: [makePlan()],
      nextCursor: null,
    });
    await act(async () => {
      root.render(
        inHost(
          <ProfilePlansSection orgId="org-1" userId="u1" memberName="Grace" />,
        ),
      );
      await Promise.resolve();
    });
    await flush();
    const row = container.querySelector('[data-testid="profile-plan-row"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('href')).toBe('/plans/plan-1');
    expect(row?.textContent).toContain('Ship the profile page');
    expect(row?.textContent).toContain('canopy');
    // No further page → no "Load more" affordance.
    expect(
      container.querySelector('[data-testid="profile-plans-load-more"]'),
    ).toBeNull();
  });

  it('appends the next page when "Load more" is clicked, deduping by id', async () => {
    mockFetchPlans.mockResolvedValueOnce({
      items: [makePlan({ id: 'plan-1', title: 'First plan' })],
      nextCursor: 'cursor-1',
    });
    mockFetchPlans.mockResolvedValueOnce({
      // The repeated `plan-1` must be deduped; only `plan-2` is appended.
      items: [
        makePlan({ id: 'plan-1', title: 'First plan' }),
        makePlan({ id: 'plan-2', title: 'Second plan' }),
      ],
      nextCursor: null,
    });
    await act(async () => {
      root.render(
        inHost(
          <ProfilePlansSection orgId="org-1" userId="u1" memberName="Grace" />,
        ),
      );
      await Promise.resolve();
    });
    await flush();

    const loadMore = container.querySelector<HTMLButtonElement>(
      '[data-testid="profile-plans-load-more"]',
    );
    expect(loadMore).not.toBeNull();
    await act(async () => {
      loadMore?.click();
      await Promise.resolve();
    });
    await flush();

    expect(mockFetchPlans).toHaveBeenNthCalledWith(
      2,
      client,
      'org-1',
      'u1',
      'cursor-1',
    );
    const rows = container.querySelectorAll('[data-testid="profile-plan-row"]');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('First plan');
    expect(rows[1]?.textContent).toContain('Second plan');
    // Last page → button gone.
    expect(
      container.querySelector('[data-testid="profile-plans-load-more"]'),
    ).toBeNull();
  });
});

describe('ProfileApprovedPlansSection', () => {
  it('renders an empty state when the member has no implemented plans', async () => {
    mockFetchApprovedPlans.mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => {
      root.render(
        inHost(
          <ProfileApprovedPlansSection
            orgId="org-1"
            userId="u1"
            memberName="Grace"
          />,
        ),
      );
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="profile-approved-plans-empty"]'),
    ).not.toBeNull();
  });

  it('renders approved plan rows that link to the implemented viewer', async () => {
    mockFetchApprovedPlans.mockResolvedValue({
      items: [makeApprovedPlan()],
      nextCursor: null,
    });
    await act(async () => {
      root.render(
        inHost(
          <ProfileApprovedPlansSection
            orgId="org-1"
            userId="u1"
            memberName="Grace"
          />,
        ),
      );
      await Promise.resolve();
    });
    await flush();
    const row = container.querySelector(
      '[data-testid="profile-approved-plan-row"]',
    );
    expect(row).not.toBeNull();
    expect(row?.getAttribute('href')).toBe('/plans/implemented/approved-1');
    expect(row?.textContent).toContain('Refactor the executor');
    expect(row?.textContent).toContain('approved');
    expect(row?.textContent).toContain('v2');
  });
});

describe('ProfilePipelinesSection', () => {
  it('renders an empty state when the member has no shared pipelines', async () => {
    mockFetchPipelines.mockResolvedValue({ items: [], nextCursor: null });
    await act(async () => {
      root.render(
        inHost(
          <ProfilePipelinesSection
            orgId="org-1"
            userId="u1"
            memberName="Grace"
          />,
        ),
      );
      await Promise.resolve();
    });
    await flush();
    expect(
      container.querySelector('[data-testid="profile-pipelines-empty"]'),
    ).not.toBeNull();
  });

  it('renders pipeline rows with name and description', async () => {
    mockFetchPipelines.mockResolvedValue({
      items: [makePipeline()],
      nextCursor: null,
    });
    await act(async () => {
      root.render(
        inHost(
          <ProfilePipelinesSection
            orgId="org-1"
            userId="u1"
            memberName="Grace"
          />,
        ),
      );
      await Promise.resolve();
    });
    await flush();
    const row = container.querySelector('[data-testid="profile-pipeline-row"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Nightly review');
    expect(row?.textContent).toContain('Runs the review bot');
  });
});
