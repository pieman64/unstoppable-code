import type { JSX, ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import type {
  DeepLinkShareOpenEvent,
  PublicShareSnapshot,
} from '@canopy/desktop-shared/types';
import type { PublicShareLanding } from '../usePublicShareLanding';

function publicShareLanding(
  snapshot: PublicShareSnapshot | null = null,
  installReview: PublicShareLanding['installReview'] = null,
): PublicShareLanding {
  return {
    state:
      snapshot === null ? { phase: 'loading' } : { phase: 'ready', snapshot },
    snapshot,
    detecting: false,
    installed: null,
    installing: false,
    installError: '',
    verificationError: '',
    needsRefresh: false,
    refresh: (): void => undefined,
    uninstalling: false,
    installProgress: '',
    installStatus: '',
    agentReadiness: null,
    agentReadinessLoading: false,
    agentReviewLoading: false,
    workspaceReadiness: null,
    workspaceReadinessLoading: false,
    install: (): ReturnType<PublicShareLanding['install']> =>
      Promise.resolve(null),
    insertInChat: (): ReturnType<PublicShareLanding['insertInChat']> =>
      Promise.resolve('unhandled'),
    tryNow: (): void => undefined,
    manage: (): void => undefined,
    uninstall: (): ReturnType<PublicShareLanding['uninstall']> =>
      Promise.resolve(false),
    installReview,
    openingInstallReview: false,
    closeInstallReview: (): void => undefined,
    completeInstallReview: (): void => undefined,
    retryResolve: (): void => undefined,
    signIn: (): void => undefined,
    switchAccount: (): void => undefined,
  };
}

const mockUsePublicShareLanding = jest.fn<PublicShareLanding, []>(() =>
  publicShareLanding(),
);
const mockInstallSharedAutomationModal = jest.fn(
  ({ source }: { source?: 'shared' | 'public' | 'curated' }): JSX.Element => (
    <div data-source={source} />
  ),
);

jest.mock('../../shared', () => ({
  LoadingPlaceholder: ({ label }: { label: string }): JSX.Element => (
    <p>{label}</p>
  ),
}));
jest.mock('@canopy/ui-shared/components/ShareInstallDialog', () => ({
  ShareInstallDialog: ({
    title,
    typeLabel,
    loading,
  }: {
    title: ReactNode;
    typeLabel?: string;
    loading?: ReactNode;
  }): JSX.Element => (
    <section>
      <h1>{title}</h1>
      <p>{typeLabel}</p>
      {loading}
    </section>
  ),
}));
jest.mock('../usePublicShareLanding', () => ({
  get usePublicShareLanding(): typeof mockUsePublicShareLanding {
    return mockUsePublicShareLanding;
  },
}));
jest.mock('@/components/automations/InstallSharedAutomationModal', () => ({
  InstallSharedAutomationModal: (props: {
    source?: 'shared' | 'public' | 'curated';
  }): JSX.Element => mockInstallSharedAutomationModal(props),
}));

const mockPendingShareDeepLink: { current: DeepLinkShareOpenEvent | null } = {
  current: null,
};
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: Object.assign(
    <T,>(
      selector: (state: {
        pendingShareInstall:
          | { link: DeepLinkShareOpenEvent; origin: 'deep-link' }
          | undefined;
      }) => T,
    ): T =>
      selector({
        pendingShareInstall: mockPendingShareDeepLink.current
          ? { link: mockPendingShareDeepLink.current, origin: 'deep-link' }
          : undefined,
      }),
    { getState: () => ({ consumeShareInstall: jest.fn() }) },
  ),
}));
jest.mock(
  '@/components/shared-containers/SharedContainerLinkLandingModal',
  () => ({
    SharedContainerLinkLandingModal: (): JSX.Element => (
      <div data-testid="shared-container-link-landing" />
    ),
  }),
);

import { ShareInstallModal, ShareInstallModalHost } from '../ShareInstallModal';

describe('ShareInstallModal', () => {
  beforeEach(() => {
    mockUsePublicShareLanding.mockReturnValue(publicShareLanding());
  });

  it('labels a loading workspace-entity share as a project template', () => {
    const link: DeepLinkShareOpenEvent = {
      entity: 'workspace',
      externalId: '48e61855-f19c-49f9-a3d5-97c569eae78a',
      intent: 'install',
    };

    const html = renderToString(
      <ShareInstallModal link={link} origin="deep-link" onClose={jest.fn()} />,
    );

    expect(html).toContain('Shared project template');
    expect(html).toContain('Project template');
    expect(html).not.toContain('Shared blueprint');
    expect(html).not.toContain('Shared workspace');
  });

  it('labels a loading automation share as Automation', () => {
    const link: DeepLinkShareOpenEvent = {
      entity: 'automation',
      externalId: '48e61855-f19c-49f9-a3d5-97c569eae78a',
      intent: 'install',
    };

    const html = renderToString(
      <ShareInstallModal link={link} origin="deep-link" onClose={jest.fn()} />,
    );

    expect(html).toContain('Shared automation');
  });

  it('opens scoped automation installs against authenticated resources', () => {
    const link: DeepLinkShareOpenEvent = {
      entity: 'automation',
      externalId: '48e61855-f19c-49f9-a3d5-97c569eae78a',
      intent: 'install',
      audience: 'TEAM',
    };
    const snapshot: PublicShareSnapshot = {
      entity: 'automation',
      externalId: link.externalId,
      contentHash: 'a'.repeat(64),
      automation: {
        version: 1,
        name: 'Team automation',
        description: '',
        trigger: {
          kind: 'cron',
          expression: '0 2 * * *',
          timezone: 'local',
        },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Check the queue',
          plugins: [],
        },
        hasRunCondition: false,
      },
      authorUsername: null,
      updatedAt: '2026-09-19T00:00:00.000Z',
    };
    mockUsePublicShareLanding.mockReturnValue(
      publicShareLanding(snapshot, {
        entity: 'automation',
        externalId: link.externalId,
      }),
    );

    renderToString(
      <ShareInstallModal link={link} origin="deep-link" onClose={jest.fn()} />,
    );

    expect(mockInstallSharedAutomationModal).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'shared' }),
    );
  });

  it('opens curated automation installs against catalog resources', () => {
    const link: DeepLinkShareOpenEvent = {
      entity: 'automation',
      externalId: 'daily-review',
      intent: 'install',
      automationSource: 'curated',
    };
    const snapshot: PublicShareSnapshot = {
      entity: 'automation',
      externalId: link.externalId,
      contentHash: 'a'.repeat(64),
      sourceKind: 'curated',
      automation: {
        version: 1,
        name: 'Daily review',
        description: '',
        trigger: {
          kind: 'cron',
          expression: '0 2 * * *',
          timezone: 'local',
        },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Check the queue',
          plugins: [],
        },
        hasRunCondition: false,
      },
      authorUsername: null,
      updatedAt: '2026-09-19T00:00:00.000Z',
    };
    mockUsePublicShareLanding.mockReturnValue(
      publicShareLanding(snapshot, {
        entity: 'automation',
        externalId: link.externalId,
      }),
    );

    renderToString(
      <ShareInstallModal link={link} origin="deep-link" onClose={jest.fn()} />,
    );

    expect(mockInstallSharedAutomationModal).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'curated' }),
    );
  });

  it('routes a shared-container link to its own landing, not the public-share resolver', () => {
    mockPendingShareDeepLink.current = {
      entity: 'shared-container',
      externalId: `${'a'.repeat(42)}A`,
      intent: 'install',
    };
    mockUsePublicShareLanding.mockClear();

    const html = renderToString(<ShareInstallModalHost />);

    expect(html).toContain('shared-container-link-landing');
    expect(mockUsePublicShareLanding).not.toHaveBeenCalled();
    mockPendingShareDeepLink.current = null;
  });
});
