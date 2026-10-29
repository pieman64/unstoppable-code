/**
 * @jest-environment jsdom
 *
 * Uses the repo's createRoot + act jsdom convention; @testing-library/react
 * is not installed.
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import type { SharedAutomationDetail } from '@canopy/protocol/automations';
import type { CuratedAutomationDetail } from '@canopy/protocol/automation-catalog';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

interface InstallModalProps {
  detail: { id: string; contentHash: string };
  source?: string;
  staleActivities?: ScheduledActivity[];
  workspaces: Array<{ id: string }>;
  onClose: () => void;
}
let mockInstallModalProps: InstallModalProps | null = null;

// The wizard has its own suite; here only what it is opened with matters.
jest.mock('../InstallSharedAutomationModal', () => ({
  InstallSharedAutomationModal: (props: InstallModalProps): JSX.Element => {
    mockInstallModalProps = props;
    return (
      <div data-testid="mock-install-modal">
        <button
          type="button"
          data-testid="mock-install-modal-close"
          onClick={props.onClose}
        >
          Close
        </button>
      </div>
    );
  },
}));
jest.mock('@/hooks/useAutomationScope', () => ({
  useAutomationScope: (): { projectsInContext: unknown[] } => ({
    projectsInContext: [
      { id: 'workspace-1', name: 'Canopy', type: 'single-repo' },
    ],
  }),
}));
jest.mock('../../shared/McpServerLogo', () => ({
  McpServerLogo: (): null => null,
}));
let mockPublicShareRowProps: { remoteId: string; canManage?: boolean } | null =
  null;
jest.mock('../AutomationPublicShareRow', () => ({
  AutomationPublicShareRow: (props: {
    remoteId: string;
    canManage?: boolean;
  }): null => {
    mockPublicShareRowProps = props;
    return null;
  },
}));

import {
  AutomationCatalogDetail,
  CuratedAutomationMarketplaceDetail,
  SharedAutomationMarketplaceDetail,
} from '../AutomationCatalogDetail';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { useNavigationStore } from '@/stores/navigationStore';

const SHARE_ID = '4f6b0f5e-2f66-4be4-9f8e-1f0a54a1c111';
const CURRENT = 'a'.repeat(64);
const OLDER = 'b'.repeat(64);

function activity(
  id: string,
  overrides: Partial<ScheduledActivity> = {},
): ScheduledActivity {
  return {
    version: 1,
    id,
    name: 'Morning standup',
    enabled: true,
    schedule: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
    action: { type: 'app_advisor_prompt', prompt: 'Summarize yesterday' },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    failureCount: 0,
    ...overrides,
  };
}

function installedFrom(
  remoteId: string,
  contentHash: string,
  sourceKind?: 'shared' | 'public' | 'curated',
): NonNullable<ScheduledActivity['installedFrom']> {
  return {
    remoteId,
    contentHash,
    installedAt: '2026-08-19T00:00:00.000Z',
    ...(sourceKind ? { sourceKind } : {}),
  };
}

function sharedDetail(
  overrides: Partial<SharedAutomationDetail> = {},
): SharedAutomationDetail {
  return {
    id: SHARE_ID,
    name: 'Triage inbox',
    description: 'Sorts new issues every morning.',
    triggerKind: 'cron',
    actionType: 'app_advisor_prompt',
    contentHash: CURRENT,
    shareScope: 'team',
    owner: {
      type: 'team',
      id: 'team-1',
      name: 'Platform',
      organization: { id: 'org-1', name: 'Acme' },
    },
    createdAt: '2026-08-19T00:00:00.000Z',
    updatedAt: '2026-08-19T00:00:00.000Z',
    createdBy: { id: 'user-1', name: 'Alex', email: null },
    canUpdate: false,
    canDelete: false,
    automation: {
      version: 2,
      name: 'Triage inbox',
      description: 'Sorts new issues every morning.',
      trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
      action: { type: 'app_advisor_prompt', prompt: 'Triage', plugins: [] },
      hasRunCondition: false,
    },
    ...overrides,
  };
}

function curatedDetail(
  overrides: Partial<CuratedAutomationDetail> = {},
): CuratedAutomationDetail {
  return {
    key: 'daily-review',
    name: 'Daily review',
    shortDescription: 'Reviews open pull requests each weekday.',
    icon: '',
    triggerKind: 'cron',
    cronExpression: '0 9 * * 1-5',
    actionType: 'app_advisor_prompt',
    pipelineSource: null,
    referencedCuratedPipelineKey: null,
    pluginCount: 0,
    contentHash: CURRENT,
    contentSizeBytes: 64,
    categories: [],
    popular: false,
    sortOrder: 0,
    revision: 1,
    authorName: 'Canopy',
    authorUrl: null,
    docsUrl: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    automation: {
      version: 2,
      name: 'Daily review',
      description: '',
      trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'local' },
      action: {
        type: 'app_advisor_prompt',
        prompt: 'Review open pull requests',
        plugins: [],
      },
      hasRunCondition: false,
    },
    ...overrides,
  };
}

const mockGetShared = jest.fn<Promise<SharedAutomationDetail>, [string]>();
const mockGetCurated = jest.fn<Promise<CuratedAutomationDetail>, [string]>();
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  jest.clearAllMocks();
  mockInstallModalProps = null;
  mockPublicShareRowProps = null;
  useNavigationStore.setState({
    pendingShareInstall: undefined,
    heldShareInstall: undefined,
    shareInstallBusy: false,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      automations: { getShared: mockGetShared, getCurated: mockGetCurated },
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(element: JSX.Element): Promise<void> {
  await act(async () => {
    root.render(element);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function byTestId(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

async function click(testId: string): Promise<void> {
  const node = byTestId(testId);
  if (!node) throw new Error(`Missing data-testid="${testId}"`);
  await act(async () => {
    node.click();
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('AutomationCatalogDetail', () => {
  it('summarizes a local automation and opens it in Automations', async () => {
    const onOpen = jest.fn();
    await render(
      <AutomationCatalogDetail
        activity={activity('standup')}
        summary="Scheduled · App Advisor prompt: Summarize yesterday"
        updateAvailable={false}
        onOpenInAutomations={onOpen}
      />,
    );

    expect(byTestId('automation-catalog-origin')?.textContent).toBe('Local');
    expect(byTestId('automation-catalog-trigger')?.textContent).toContain(
      'Scheduled',
    );
    expect(byTestId('automation-catalog-status')?.textContent).toBe('Enabled');
    expect(container.textContent).toContain(
      'Scheduled · App Advisor prompt: Summarize yesterday',
    );
    expect(byTestId('automation-catalog-update')).toBeNull();
    expect(byTestId('automation-catalog-update-available')).toBeNull();

    await click('automation-catalog-open');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Partial<ScheduledActivity>, string]>([
    [
      'Customize',
      { installedFrom: installedFrom('daily-review', CURRENT, 'curated') },
      'Added from Customize',
    ],
    [
      'a team share',
      { installedFrom: installedFrom(SHARE_ID, CURRENT) },
      'Added from a shared automation',
    ],
    [
      'a public link',
      { installedFrom: installedFrom(SHARE_ID, CURRENT, 'public') },
      'Added from a public link',
    ],
    [
      'the user, who shared it',
      {
        remote: {
          remoteId: SHARE_ID,
          contentHash: CURRENT,
          sharedAt: '2026-08-19T00:00:00.000Z',
        },
      },
      'Shared by you',
    ],
  ])('says the automation came from %s', async (_label, overrides, copy) => {
    await render(
      <AutomationCatalogDetail
        activity={activity('standup', { enabled: false, ...overrides })}
        summary=""
        updateAvailable={false}
        onOpenInAutomations={jest.fn()}
      />,
    );

    expect(byTestId('automation-catalog-origin')?.textContent).toBe(copy);
    expect(byTestId('automation-catalog-status')?.textContent).toBe('Disabled');
  });

  it('updates a stale curated copy through the wizard, in update mode', async () => {
    const stale = activity('standup', {
      installedFrom: installedFrom('daily-review', OLDER, 'curated'),
    });
    mockGetCurated.mockResolvedValue(curatedDetail());
    await render(
      <AutomationCatalogDetail
        activity={stale}
        summary=""
        updateAvailable
        onOpenInAutomations={jest.fn()}
      />,
    );
    expect(byTestId('automation-catalog-update-available')).not.toBeNull();

    await click('automation-catalog-update');

    expect(mockGetCurated).toHaveBeenCalledWith('daily-review');
    expect(mockGetShared).not.toHaveBeenCalled();
    expect(mockInstallModalProps).toMatchObject({
      source: 'curated',
      detail: { id: 'daily-review', contentHash: CURRENT },
      staleActivities: [stale],
      workspaces: [{ id: 'workspace-1' }],
    });
  });

  it('updates a stale team-share copy from the share itself', async () => {
    const stale = activity('standup', {
      installedFrom: installedFrom(SHARE_ID, OLDER),
    });
    mockGetShared.mockResolvedValue(sharedDetail());
    await render(
      <AutomationCatalogDetail
        activity={stale}
        summary=""
        updateAvailable
        onOpenInAutomations={jest.fn()}
      />,
    );

    await click('automation-catalog-update');

    expect(mockGetShared).toHaveBeenCalledWith(SHARE_ID);
    expect(mockGetCurated).not.toHaveBeenCalled();
    expect(mockInstallModalProps).toMatchObject({
      source: 'shared',
      detail: { id: SHARE_ID },
      staleActivities: [stale],
    });
  });

  it('says why an update could not be loaded and lets the user retry', async () => {
    mockGetCurated
      .mockRejectedValueOnce(new Error('Catalog unavailable'))
      .mockResolvedValueOnce(curatedDetail());
    await render(
      <AutomationCatalogDetail
        activity={activity('standup', {
          installedFrom: installedFrom('daily-review', OLDER, 'curated'),
        })}
        summary=""
        updateAvailable
        onOpenInAutomations={jest.fn()}
      />,
    );

    await click('automation-catalog-update');
    const error = byTestId('automation-catalog-update-error');
    expect(error?.textContent).toContain("Couldn't load the update.");
    expect(error?.textContent).toContain('Catalog unavailable');
    expect(mockInstallModalProps).toBeNull();

    await act(async () => {
      error?.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockInstallModalProps).not.toBeNull();
    expect(byTestId('automation-catalog-update-error')).toBeNull();
  });

  it('blocks the summary in session replay', async () => {
    await render(
      <AutomationCatalogDetail
        activity={activity('standup', {
          name: 'Acme payments standup',
          installedFrom: installedFrom('daily-review', OLDER, 'curated'),
        })}
        summary="Scheduled · Pipeline acme-deploy"
        updateAvailable
        onOpenInAutomations={jest.fn()}
      />,
    );

    expect(
      byTestId('automation-catalog-summary')?.classList.contains(
        POSTHOG_REPLAY_BLOCK_CLASS,
      ),
    ).toBe(true);
  });

  it('offers no update for a copy that came from a public link', async () => {
    await render(
      <AutomationCatalogDetail
        activity={activity('standup', {
          installedFrom: installedFrom(SHARE_ID, OLDER, 'public'),
        })}
        summary=""
        updateAvailable
        onOpenInAutomations={jest.fn()}
      />,
    );

    expect(byTestId('automation-catalog-update')).toBeNull();
  });
});

describe('SharedAutomationMarketplaceDetail', () => {
  it('previews the share and adds it through the shared install review', async () => {
    mockGetShared.mockResolvedValue(sharedDetail());
    await render(
      <SharedAutomationMarketplaceDetail
        automationId={SHARE_ID}
        activities={[]}
        onOpenInAutomations={jest.fn()}
      />,
    );

    expect(mockGetShared).toHaveBeenCalledWith(SHARE_ID);
    expect(byTestId('shared-automation-preview')).not.toBeNull();
    expect(byTestId('automation-source-install')?.textContent).toBe('Add');
    expect(mockInstallModalProps).toBeNull();

    // Opening the detail never starts an install (CAN-3710).
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();

    await click('automation-source-install');
    expect(mockInstallModalProps).toBeNull();
    expect(useNavigationStore.getState().pendingShareInstall).toEqual({
      link: {
        entity: 'automation',
        externalId: SHARE_ID,
        intent: 'install',
        audience: 'TEAM',
      },
      origin: 'in-app',
    });
  });

  it('keeps the wizard for a private share, which resolves for nobody else', async () => {
    mockGetShared.mockResolvedValue(sharedDetail({ shareScope: 'private' }));
    await render(
      <SharedAutomationMarketplaceDetail
        automationId={SHARE_ID}
        activities={[]}
        onOpenInAutomations={jest.fn()}
      />,
    );

    await click('automation-source-install');
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
    expect(mockInstallModalProps).toMatchObject({
      source: 'shared',
      detail: { id: SHARE_ID },
      staleActivities: [],
    });
  });

  it('offers the update for every stale copy of the share', async () => {
    mockGetShared.mockResolvedValue(sharedDetail());
    const staleA = activity('a', {
      installedFrom: installedFrom(SHARE_ID, OLDER),
    });
    const staleB = activity('b', {
      installedFrom: installedFrom(SHARE_ID, OLDER, 'shared'),
    });
    await render(
      <SharedAutomationMarketplaceDetail
        automationId={SHARE_ID}
        activities={[
          staleA,
          staleB,
          activity('current', {
            installedFrom: installedFrom(SHARE_ID, CURRENT),
          }),
        ]}
        onOpenInAutomations={jest.fn()}
      />,
    );

    expect(byTestId('shared-automation-badge-update-available')).not.toBeNull();
    expect(byTestId('automation-source-install')?.textContent).toBe('Update');
    await click('automation-source-install');
    expect(mockInstallModalProps?.staleActivities).toEqual([staleA, staleB]);
  });

  it.each<[string, ScheduledActivity]>([
    [
      'installed copy',
      activity('copy', { installedFrom: installedFrom(SHARE_ID, CURRENT) }),
    ],
    [
      'automation the user shared',
      activity('source', {
        remote: {
          remoteId: SHARE_ID,
          contentHash: CURRENT,
          sharedAt: '2026-08-19T00:00:00.000Z',
        },
      }),
    ],
  ])('opens the %s instead of adding it again', async (_label, local) => {
    mockGetShared.mockResolvedValue(sharedDetail());
    const onOpen = jest.fn();
    await render(
      <SharedAutomationMarketplaceDetail
        automationId={SHARE_ID}
        activities={[local]}
        onOpenInAutomations={onOpen}
      />,
    );

    expect(byTestId('mock-install-modal')).toBeNull();
    expect(byTestId('automation-source-install')).toBeNull();
    await click('automation-source-open');
    expect(onOpen).toHaveBeenCalledWith(local.id);
  });

  it.each<[string, ScheduledActivity]>([
    [
      'installed copy',
      activity('copy', { installedFrom: installedFrom(SHARE_ID, CURRENT) }),
    ],
    [
      'automation the user shared',
      activity('source', {
        remote: {
          remoteId: SHARE_ID,
          contentHash: CURRENT,
          sharedAt: '2026-08-19T00:00:00.000Z',
        },
      }),
    ],
  ])(
    'installs another independent copy beside the %s',
    async (_label, local) => {
      mockGetShared.mockResolvedValue(sharedDetail());
      await render(
        <SharedAutomationMarketplaceDetail
          automationId={SHARE_ID}
          activities={[local]}
          onOpenInAutomations={jest.fn()}
        />,
      );

      expect(byTestId('mock-install-modal')).toBeNull();
      expect(
        byTestId('automation-catalog-install-another-copy')?.textContent,
      ).toBe('Install another copy');
      await click('automation-catalog-install-another-copy');
      expect(mockInstallModalProps).toMatchObject({
        source: 'shared',
        detail: { id: SHARE_ID },
        staleActivities: [],
      });

      await click('mock-install-modal-close');
      expect(byTestId('mock-install-modal')).toBeNull();
    },
  );

  it('offers no second copy while adding or updating is the next step', async () => {
    mockGetShared.mockResolvedValue(sharedDetail());
    await render(
      <SharedAutomationMarketplaceDetail
        automationId={SHARE_ID}
        activities={[
          activity('stale', { installedFrom: installedFrom(SHARE_ID, OLDER) }),
        ]}
        onOpenInAutomations={jest.fn()}
      />,
    );

    expect(byTestId('automation-source-install')?.textContent).toBe('Update');
    expect(byTestId('automation-catalog-install-another-copy')).toBeNull();
  });

  it.each<[string, Partial<SharedAutomationDetail>, boolean]>([
    ['the author', { canUpdate: true, canDelete: true }, true],
    [
      'an organization admin who may only delete',
      { canUpdate: false, canDelete: true },
      true,
    ],
    ['a recipient', { canUpdate: false, canDelete: false }, false],
  ])(
    'lets %s manage the public link as allowed',
    async (_label, permissions, canManage) => {
      mockGetShared.mockResolvedValue(sharedDetail(permissions));
      await render(
        <SharedAutomationMarketplaceDetail
          automationId={SHARE_ID}
          activities={[]}
          onOpenInAutomations={jest.fn()}
        />,
      );

      expect(mockPublicShareRowProps).toEqual({
        remoteId: SHARE_ID,
        initialShare: null,
        canManage,
      });
    },
  );

  it('reports the share name once it loads', async () => {
    mockGetShared.mockResolvedValue(
      sharedDetail({ name: 'Public link only', shareScope: 'private' }),
    );
    const onNameLoaded = jest.fn();
    await render(
      <SharedAutomationMarketplaceDetail
        automationId={SHARE_ID}
        activities={[]}
        onOpenInAutomations={jest.fn()}
        onNameLoaded={onNameLoaded}
      />,
    );

    expect(onNameLoaded).toHaveBeenCalledTimes(1);
    expect(onNameLoaded).toHaveBeenCalledWith('Public link only');
  });

  it('says the share could not be loaded and retries', async () => {
    mockGetShared
      .mockRejectedValueOnce(new Error('Share unavailable'))
      .mockResolvedValueOnce(sharedDetail());
    await render(
      <SharedAutomationMarketplaceDetail
        automationId={SHARE_ID}
        activities={[]}
        onOpenInAutomations={jest.fn()}
      />,
    );

    const error = byTestId('automation-source-error');
    expect(error?.textContent).toContain("Couldn't load this automation.");
    expect(error?.textContent).toContain('Share unavailable');

    await act(async () => {
      error?.querySelector('button')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(byTestId('shared-automation-preview')).not.toBeNull();
    expect(mockGetShared).toHaveBeenCalledTimes(2);
  });
});

describe('CuratedAutomationMarketplaceDetail', () => {
  function curated(
    overrides: Partial<
      Parameters<typeof CuratedAutomationMarketplaceDetail>[0]
    > = {},
  ): JSX.Element {
    return (
      <CuratedAutomationMarketplaceDetail
        name="Daily review"
        detail={curatedDetail()}
        loading={false}
        error={null}
        onRetry={jest.fn()}
        activities={[]}
        onOpenInAutomations={jest.fn()}
        {...overrides}
      />
    );
  }

  it('waits for the catalog detail before showing anything to add', async () => {
    await render(curated({ detail: null, loading: true }));

    expect(container.textContent).toContain('Loading automation…');
    expect(byTestId('automation-source-install')).toBeNull();
  });

  it('shows what the automation does and adds it as a curated install', async () => {
    await render(curated());

    expect(container.textContent).toContain('Curated · Canopy');
    expect(container.textContent).toContain(
      'Reviews open pull requests each weekday.',
    );
    expect(byTestId('curated-automation-schedule')?.textContent).not.toBe('');
    expect(byTestId('automation-definition-summary')).not.toBeNull();
    expect(container.textContent).toContain('Review open pull requests');

    await click('automation-source-install');
    expect(mockInstallModalProps).toBeNull();
    expect(useNavigationStore.getState().pendingShareInstall).toEqual({
      link: {
        entity: 'automation',
        externalId: 'daily-review',
        intent: 'install',
        automationSource: 'curated',
        expectedAutomationContentHash: CURRENT,
      },
      origin: 'in-app',
    });
  });

  it('records the description in session replay', async () => {
    await render(curated());

    const description = Array.from(container.querySelectorAll('p')).find(
      (paragraph) =>
        paragraph.textContent === 'Reviews open pull requests each weekday.',
    );
    expect(description).toBeDefined();
    expect(description?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('never starts an install when the detail opens', async () => {
    await render(curated());

    expect(byTestId('mock-install-modal')).toBeNull();
    expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
  });

  it('offers the update when the installed copy is from an older revision', async () => {
    const stale = activity('copy', {
      installedFrom: installedFrom('daily-review', OLDER, 'curated'),
    });
    await render(curated({ activities: [stale] }));

    expect(byTestId('automation-catalog-update-available')).not.toBeNull();
    expect(byTestId('automation-source-install')?.textContent).toBe('Update');
    await click('automation-source-install');
    expect(mockInstallModalProps?.staleActivities).toEqual([stale]);
  });

  it('opens the installed copy instead of adding a current one again', async () => {
    const onOpen = jest.fn();
    await render(
      curated({
        activities: [
          activity('copy', {
            installedFrom: installedFrom('daily-review', CURRENT, 'curated'),
          }),
          // A team-share install with the same id is a different automation.
          activity('team', {
            installedFrom: installedFrom('daily-review', OLDER),
          }),
        ],
        onOpenInAutomations: onOpen,
      }),
    );

    expect(byTestId('mock-install-modal')).toBeNull();
    await click('automation-source-open');
    expect(onOpen).toHaveBeenCalledWith('copy');

    await click('automation-catalog-install-another-copy');
    expect(mockInstallModalProps).toMatchObject({
      source: 'curated',
      detail: { id: 'daily-review' },
      staleActivities: [],
    });
  });

  it('says the automation could not be loaded and retries', async () => {
    const onRetry = jest.fn();
    await render(
      curated({ detail: null, error: 'Catalog unavailable', onRetry }),
    );

    const error = byTestId('automation-source-error');
    expect(error?.textContent).toContain('Catalog unavailable');
    await act(async () => {
      error?.querySelector('button')?.click();
      await Promise.resolve();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
