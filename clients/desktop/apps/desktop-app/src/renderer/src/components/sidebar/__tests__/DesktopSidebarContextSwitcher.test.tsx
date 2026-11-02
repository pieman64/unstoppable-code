/**
 * @jest-environment jsdom
 */
import type { ForeignActivityProjection } from '@canopy/protocol/foreign-activity';
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  CanopyCloudEntitlementsState,
  NativeAiCreditsAvailability,
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { organizationBillingPath } from '@canopy/protocol/billing';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import {
  useSharedContainerReplicasStore,
  type SharedContainerListEntry,
} from '@/stores/sharedContainerReplicasStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { DesktopSidebarContextSwitcher } from '../DesktopSidebarContextSwitcher';
import { useDesktopWorkspaceContextAvailability } from '@/hooks/useDesktopWorkspaceContextSwitcher';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let mockHostedSettingsClient: unknown = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): unknown => mockHostedSettingsClient,
}));

let mockForeignProjection: ForeignActivityProjection = {
  epoch: '',
  sequence: 0,
  groups: [],
};
jest.mock('@/hooks/useForeignActivityProjection', () => ({
  useForeignActivityProjection: (): ForeignActivityProjection =>
    mockForeignProjection,
}));

// The share entry point's own gate is covered by its hook's tests.
let mockShareEntryPointVisible = true;
jest.mock('@/hooks/useSharedContainerEntryPointVisible', () => ({
  useSharedContainerEntryPointVisible: (): boolean =>
    mockShareEntryPointVisible,
}));

jest.mock('../DesktopCreateTeamDialog', () => ({
  DesktopCreateTeamDialog: ({
    personalOrganizationId,
    onClose,
  }: {
    personalOrganizationId: string;
    onClose: () => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-create-team-dialog"
      data-personal-organization-id={personalOrganizationId}
      onClick={onClose}
    />
  ),
  DesktopInviteTeamDialog: ({
    organizationId,
  }: {
    organizationId: string;
  }): JSX.Element => (
    <div
      data-testid="mock-invite-team-dialog"
      data-organization-id={organizationId}
    />
  ),
}));

const PERSONAL_ORG = '44444444-4444-4444-8444-444444444444';
const ACME = '11111111-1111-4111-8111-111111111111';
const ZEN = '22222222-2222-4222-8222-222222222222';

type Role = WorkspaceContextOrganization['role'];

function account(
  overrides: Partial<CanopyCloudAccountPublicState> = {},
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
    account: {
      id: 'acct_1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'DEVELOPER',
    },
    personalOrganizationId: PERSONAL_ORG,
    ...overrides,
  };
}

const SIGNED_OUT = account({ hasApiKey: false, account: undefined });
const GUEST = account({ credentialSource: 'guest' });

function entitlements(freeAccess: boolean): CanopyCloudEntitlementsState {
  return {
    resolved: true,
    canDisableSharing: true,
    canRemoteControl: false,
    source: 'none',
    plan: null,
    trial: null,
    billingManageableOrg: null,
    displayPlan: null,
    billingPresentation: null,
    freeAccess,
  };
}

function pool(
  organizationId: string,
  balance: number,
): NativeAiCreditsAvailability {
  return {
    personalEligible: true,
    inOrg: true,
    orgCreditPoolCovered: true,
    orgSpendable: true,
    ownerOrganization: { id: organizationId, name: 'Pool' },
    ownerOrganizationBalanceCredits: balance,
    pricingUrl: 'https://cloud.example.com/pricing',
  };
}

let openPortalPage: jest.Mock;
let setContextIpc: jest.Mock;
let loadAvailability: jest.Mock;

function installApi({
  cloudAccount = account(),
  freeAccess = false,
  availability = (): Promise<NativeAiCreditsAvailability> =>
    Promise.reject(new Error('no pool')),
}: {
  cloudAccount?: CanopyCloudAccountPublicState;
  freeAccess?: boolean;
  availability?: () => Promise<NativeAiCreditsAvailability>;
} = {}): void {
  openPortalPage = jest.fn().mockResolvedValue(true);
  setContextIpc = jest
    .fn()
    .mockImplementation((request: { context: WorkspaceContext }) =>
      Promise.resolve({
        context: request.context,
        revision: useWorkspaceContextStore.getState().state.revision + 1,
        organizations: useWorkspaceContextStore.getState().state.organizations,
      }),
    );
  loadAvailability = jest.fn().mockImplementation(availability);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadCanopyCloudAccount: jest.fn().mockResolvedValue(cloudAccount),
      loadCanopyCloudEntitlements: jest
        .fn()
        .mockResolvedValue(entitlements(freeAccess)),
      getCanopyCloudBaseUrl: jest.fn().mockResolvedValue(null),
      openAuthenticatedPortalPage: openPortalPage,
      loadNativeAiCreditsAvailability: loadAvailability,
      workspaceContext: {
        get: jest
          .fn()
          .mockResolvedValue(useWorkspaceContextStore.getState().state),
        set: setContextIpc,
        onChanged: jest.fn((): (() => void) => (): void => {}),
      },
    },
  });
}

function setFlags({
  orgProjects = true,
  billing = true,
}: { orgProjects?: boolean; billing?: boolean } = {}): void {
  const snapshot = getDefaultFeatureFlagSnapshot();
  snapshot.values['canopy-shared-org-projects-enabled'] = orgProjects;
  snapshot.values['canopy-billing-enabled'] = billing;
  useFeatureFlagsStore.setState({ snapshot });
}

function seedContext(
  context: WorkspaceContext,
  organizations: readonly WorkspaceContextOrganization[],
): void {
  useWorkspaceContextStore.setState({
    state: { context, revision: 1, organizations: [...organizations] },
    hydrated: true,
  });
}

function acme(role: Role): WorkspaceContextOrganization {
  return { id: ACME, name: 'Acme', role };
}

const ACME_CONTEXT: WorkspaceContext = {
  kind: 'organization',
  organizationId: ACME,
};

/** A foreign-activity projection with one running chat in `context`. */
function runningIn(context: WorkspaceContext): ForeignActivityProjection {
  return {
    epoch: 'epoch',
    sequence: 1,
    groups: [
      {
        context,
        workspaces: [
          {
            workspaceId: 'workspace',
            name: 'Workspace',
            running: 1,
            unread: 0,
            interrupted: false,
            stopTargets: [],
            latestTarget: {
              source: 'chat',
              operationId: 'turn',
              workspaceId: 'workspace',
              worktreeId: 'worktree',
              resultToken: null,
            },
          },
        ],
      },
    ],
  };
}

/** A viewable invitation listed under `organizationId`, or direct. */
function invitation(
  id: string,
  listed: Pick<SharedContainerListEntry, 'organizationId' | 'access'>,
  capabilities: SharedContainerListEntry['container']['capabilities'] = [
    'VIEW',
  ],
): SharedContainerListEntry {
  return {
    ...listed,
    container: {
      id,
      ownerUserId: 'owner',
      owner: { userId: 'owner', name: 'Owner' },
      access: listed.access ?? 'organization',
      containerType: 'CODE_WORKTREE',
      title: id,
      revision: 1,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      capabilities,
    },
  };
}

function seedShares(
  entries: SharedContainerListEntry[],
  acceptedIds: string[] = [],
): void {
  useSharedContainerReplicasStore.setState({
    entries,
    listStatus: 'success',
    acceptedIds,
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function click(testId: string): void {
  act(() => {
    byTestId(testId)?.click();
  });
}

function ContextSwitcherUnderTest(): JSX.Element {
  const availability = useDesktopWorkspaceContextAvailability();
  return (
    <DesktopSidebarContextSwitcher
      availability={availability}
      action={<button type="button" data-testid="context-activity-toggle" />}
    />
  );
}

describe('DesktopSidebarContextSwitcher', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockForeignProjection = { epoch: '', sequence: 0, groups: [] };
    mockShareEntryPointVisible = true;
    useSharedContainerReplicasStore.getState().reset();
    setFlags();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
    seedContext({ kind: 'personal' }, []);
  });

  async function render(): Promise<void> {
    act(() => {
      root.render(<ContextSwitcherUnderTest />);
    });
    await flush();
  }

  function openMenu(): void {
    click('sidebar-context-row');
  }

  function closeMenu(): void {
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
  }

  it.each([
    ['the org-projects flag is off', false, account()],
    ['signed out', true, SIGNED_OUT],
    ['a guest', true, GUEST],
  ] as const)(
    'renders nothing when %s, even with organizations',
    async (_label, orgProjects, cloudAccount) => {
      setFlags({ orgProjects });
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installApi({ cloudAccount, freeAccess: true });
      await render();
      expect(container.innerHTML).toBe('');
      expect(window.api.loadCanopyCloudEntitlements).not.toHaveBeenCalled();
      expect(loadAvailability).not.toHaveBeenCalled();
    },
  );

  it('shows Personal with its actions, and no Organization settings, without organizations', async () => {
    seedContext({ kind: 'personal' }, []);
    installApi();
    await render();
    expect(byTestId('sidebar-top-context-row')).not.toBeNull();
    expect(byTestId('sidebar-context-row')?.textContent).toBe('Personal');
    openMenu();
    expect(
      byTestId('sidebar-context-option-personal')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(1);
    expect(byTestId('account-personal-activity-row')).not.toBeNull();
    expect(byTestId('account-create-team-row')).not.toBeNull();
    expect(byTestId('sidebar-context-create-organization')).not.toBeNull();
    expect(byTestId('sidebar-context-organization-settings')).toBeNull();
  });

  it('appears and disappears as availability changes', async () => {
    installApi({ cloudAccount: SIGNED_OUT });
    await render();
    expect(byTestId('sidebar-top-context-row')).toBeNull();

    jest.mocked(window.api.loadCanopyCloudAccount).mockResolvedValue(account());
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    const wrapper = byTestId('sidebar-top-context-row');
    expect(wrapper?.className).toContain('items-center');
    expect(
      wrapper?.querySelector('[data-testid="context-activity-toggle"]'),
    ).not.toBeNull();
    expect(byTestId('sidebar-context-row')?.textContent).toBe('Personal');

    act(() => seedContext({ kind: 'personal' }, [acme('OWNER')]));
    await flush();
    expect(byTestId('sidebar-context-row')?.textContent).toBe('Personal');

    act(() => setFlags({ orgProjects: false }));
    await flush();
    expect(byTestId('sidebar-top-context-row')).toBeNull();
  });

  it('opens the personal Feed and creates a team from Personal, with no Organization settings', async () => {
    seedContext({ kind: 'personal' }, [acme('MEMBER')]);
    installApi();
    await render();
    openMenu();
    expect(byTestId('sidebar-context-organization-settings')).toBeNull();
    click('account-personal-activity-row');
    expect(openPortalPage).toHaveBeenCalledWith(
      `/organization/${PERSONAL_ORG}`,
    );
    expect(byTestId('sidebar-context-menu')).toBeNull();

    openMenu();
    click('account-create-team-row');
    // The dialog outlives the closed menu.
    expect(byTestId('sidebar-context-menu')).toBeNull();
    expect(
      byTestId('mock-create-team-dialog')?.getAttribute(
        'data-personal-organization-id',
      ),
    ).toBe(PERSONAL_ORG);
  });

  it.each([
    ['OWNER', true],
    ['ADMIN', true],
    ['MEMBER', false],
  ] as const)(
    'opens the organization Feed and settings, and Invite your team for an %s: %s',
    async (role, invites) => {
      seedContext(ACME_CONTEXT, [acme(role)]);
      installApi();
      await render();
      expect(byTestId('sidebar-context-row')?.textContent).toBe('Acme');
      openMenu();
      expect(byTestId('account-create-team-row')).toBeNull();
      expect(byTestId('account-invite-team-row') !== null).toBe(invites);
      expect(byTestId('sidebar-context-create-organization')).not.toBeNull();
      click('account-personal-activity-row');
      expect(openPortalPage).toHaveBeenLastCalledWith(`/organization/${ACME}`);

      openMenu();
      click('sidebar-context-organization-settings');
      expect(openPortalPage).toHaveBeenLastCalledWith(
        `/organization/${ACME}/settings`,
      );
      if (!invites) return;

      openMenu();
      click('account-invite-team-row');
      expect(
        byTestId('mock-invite-team-dialog')?.getAttribute(
          'data-organization-id',
        ),
      ).toBe(ACME);
      // Switching context keeps the dialog on the organization it opened for.
      act(() => seedContext({ kind: 'personal' }, [acme(role)]));
      await flush();
      expect(
        byTestId('mock-invite-team-dialog')?.getAttribute(
          'data-organization-id',
        ),
      ).toBe(ACME);
    },
  );

  describe('with hosted settings openable in this window', () => {
    beforeEach(() => {
      mockHostedSettingsClient = {};
    });

    afterEach(() => {
      mockHostedSettingsClient = null;
      useRemoteControlStore.setState({ context: { mode: 'local' } });
      useNavigationStore.getState().closeSettings();
    });

    it.each([
      ['account-personal-activity-row', { page: 'feed' }],
      ['account-context-statistics-row', { page: 'statistics' }],
      ['sidebar-context-organization-settings', { page: 'settings' }],
      [
        'sidebar-context-menu-item-ai-credits',
        { page: 'settings', subtab: 'billing' },
      ],
    ] as const)('opens %s inside Settings', async (testId, expected) => {
      seedContext(ACME_CONTEXT, [acme('OWNER')]);
      installApi({ freeAccess: true });
      await render();
      openMenu();
      click(testId);
      const navigation = useNavigationStore.getState();
      expect(navigation.settingsOpen).toBe(true);
      expect(navigation.settingsHostedLocation?.route).toEqual({
        scope: 'organization',
        organizationId: ACME,
        ...expected,
      });
      expect(openPortalPage).not.toHaveBeenCalled();
    });

    it('opens the personal Statistics inside Settings', async () => {
      seedContext({ kind: 'personal' }, []);
      installApi();
      await render();
      openMenu();
      click('account-context-statistics-row');
      expect(
        useNavigationStore.getState().settingsHostedLocation?.route,
      ).toEqual({
        scope: 'organization',
        organizationId: PERSONAL_ORG,
        page: 'statistics',
      });
      expect(openPortalPage).not.toHaveBeenCalled();
    });

    it('opens Create an organization inside Settings with the create flag (CAN-4554)', async () => {
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      installApi();
      await render();
      openMenu();
      click('sidebar-context-create-organization');
      const navigation = useNavigationStore.getState();
      expect(navigation.settingsOpen).toBe(true);
      expect(navigation.settingsHostedLocation).toEqual({
        route: { scope: 'organizations' },
        search: 'create=1',
        hash: '',
      });
      expect(openPortalPage).not.toHaveBeenCalled();
    });

    it('opens Create an organization on the web in a remote-control window', async () => {
      seedContext(ACME_CONTEXT, [acme('MEMBER')]);
      installApi();
      useRemoteControlStore.setState({
        context: {
          mode: 'remote',
          deviceId: 'dev-b',
          name: 'Studio',
          platform: 'linux',
        },
      });
      await render();
      openMenu();
      click('sidebar-context-create-organization');
      expect(openPortalPage).toHaveBeenCalledWith('/organization?create=1');
      expect(useNavigationStore.getState().settingsOpen).toBe(false);
    });

    it('opens the web in a remote-control window', async () => {
      seedContext(ACME_CONTEXT, [acme('OWNER')]);
      installApi();
      useRemoteControlStore.setState({
        context: {
          mode: 'remote',
          deviceId: 'dev-b',
          name: 'Studio',
          platform: 'linux',
        },
      });
      await render();
      openMenu();
      click('account-context-statistics-row');
      expect(openPortalPage).toHaveBeenCalledWith(
        `/organization/${ACME}/statistics`,
      );
      expect(useNavigationStore.getState().settingsOpen).toBe(false);
    });
  });

  it('offers Statistics to owners and admins only, on the web without hosted settings', async () => {
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      seedContext(ACME_CONTEXT, [acme(role)]);
      installApi();
      await render();
      openMenu();
      const row = byTestId('account-context-statistics-row');
      expect(row !== null).toBe(role !== 'MEMBER');
      if (row) {
        click('account-context-statistics-row');
        expect(openPortalPage).toHaveBeenCalledWith(
          `/organization/${ACME}/statistics`,
        );
      } else {
        openMenu();
      }
    }
  });

  it('opens Create an organization on the web without hosted settings (CAN-4554)', async () => {
    seedContext({ kind: 'personal' }, []);
    installApi();
    await render();
    openMenu();
    click('sidebar-context-create-organization');
    expect(openPortalPage).toHaveBeenCalledWith('/organization?create=1');
    expect(byTestId('sidebar-context-menu')).toBeNull();
    expect(useNavigationStore.getState().settingsOpen).toBe(false);
  });

  it('offers no actions for an organization that is not a membership', async () => {
    seedContext({ kind: 'organization', organizationId: ZEN }, [acme('OWNER')]);
    installApi({ freeAccess: true });
    await render();
    openMenu();
    for (const testId of [
      'account-personal-activity-row',
      'account-context-statistics-row',
      'account-invite-team-row',
      'sidebar-context-menu-item-ai-credits',
      'sidebar-context-organization-settings',
    ]) {
      expect(byTestId(testId)).toBeNull();
    }
  });

  it('closes an open team dialog when the account signs out', async () => {
    seedContext({ kind: 'personal' }, [acme('OWNER')]);
    installApi();
    await render();
    openMenu();
    click('account-create-team-row');
    expect(byTestId('mock-create-team-dialog')).not.toBeNull();
    (window.api.loadCanopyCloudAccount as jest.Mock).mockResolvedValue(
      SIGNED_OUT,
    );
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(byTestId('mock-create-team-dialog')).toBeNull();
  });

  it('offers no Personal actions until the personal organization is known', async () => {
    seedContext({ kind: 'personal' }, [acme('OWNER')]);
    const cloudAccount = account();
    delete cloudAccount.personalOrganizationId;
    installApi({ cloudAccount });
    await render();
    openMenu();
    expect(byTestId('sidebar-context-menu')).not.toBeNull();
    expect(byTestId('account-create-team-row')).toBeNull();
    expect(byTestId('account-personal-activity-row')).toBeNull();
    expect(byTestId('sidebar-context-organization-settings')).toBeNull();
    // Create an organization targets no existing organization, so it shows.
    expect(byTestId('sidebar-context-create-organization')).not.toBeNull();
  });

  it.each(['create', 'invite'] as const)(
    'invalidates an open %s dialog on account replacement, including returning to the first account',
    async (kind) => {
      seedContext(kind === 'create' ? { kind: 'personal' } : ACME_CONTEXT, [
        acme('OWNER'),
      ]);
      installApi();
      await render();
      openMenu();
      click(
        kind === 'create'
          ? 'account-create-team-row'
          : 'account-invite-team-row',
      );
      const dialogId =
        kind === 'create'
          ? 'mock-create-team-dialog'
          : 'mock-invite-team-dialog';
      expect(byTestId(dialogId)).not.toBeNull();
      const loadAccount = jest.mocked(window.api.loadCanopyCloudAccount);
      loadAccount.mockResolvedValue(
        account({
          account: {
            id: 'acct_2',
            name: 'Grace Hopper',
            email: 'grace@example.com',
            role: 'DEVELOPER',
          },
        }),
      );
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(byTestId(dialogId)).toBeNull();
      loadAccount.mockResolvedValue(account());
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(byTestId(dialogId)).toBeNull();
    },
  );

  describe('organization AI Credits pool', () => {
    it("keeps OWNER to ADMIN continuity and fences a demoted viewer's pending balance on promotion", async () => {
      const pending: Array<(value: NativeAiCreditsAvailability) => void> = [];
      seedContext(ACME_CONTEXT, [acme('OWNER')]);
      installApi({
        freeAccess: true,
        availability: () => new Promise((resolve) => pending.push(resolve)),
      });
      await render();
      openMenu();
      await flush();
      act(() => {
        pending.at(-1)?.(pool(ACME, 12));
      });
      await flush();
      expect(
        byTestId('sidebar-context-menu-item-ai-credits-balance')?.textContent,
      ).toBe('12');
      const reads = loadAvailability.mock.calls.length;
      act(() => seedContext(ACME_CONTEXT, [acme('ADMIN')]));
      await flush();
      expect(
        byTestId('sidebar-context-menu-item-ai-credits-balance')?.textContent,
      ).toBe('12');
      expect(loadAvailability).toHaveBeenCalledTimes(reads);
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      const departed = pending.at(-1);
      act(() => seedContext(ACME_CONTEXT, [acme('MEMBER')]));
      expect(byTestId('sidebar-context-menu-item-ai-credits')).toBeNull();
      const demotedReads = loadAvailability.mock.calls.length;
      act(() => {
        window.dispatchEvent(new Event('focus'));
      });
      expect(loadAvailability).toHaveBeenCalledTimes(demotedReads);
      act(() => seedContext(ACME_CONTEXT, [acme('ADMIN')]));
      await flush();
      expect(
        byTestId('sidebar-context-menu-item-ai-credits-balance'),
      ).toBeNull();
      act(() => {
        pending.at(-1)?.(pool(ACME, 0));
      });
      await flush();
      act(() => {
        departed?.(pool(ACME, 99));
      });
      await flush();
      expect(
        byTestId('sidebar-context-menu-item-ai-credits-balance')?.textContent,
      ).toBe('0');
      act(() => seedContext(ACME_CONTEXT, []));
      expect(byTestId('sidebar-context-menu-item-ai-credits')).toBeNull();
    });

    it.each(['OWNER', 'ADMIN'] as const)(
      'shows %s the pool, rounded, and refreshes on every open',
      async (role) => {
        seedContext(ACME_CONTEXT, [acme(role)]);
        installApi({
          freeAccess: true,
          availability: () => Promise.resolve(pool(ACME, 412.5)),
        });
        await render();
        openMenu();
        await flush();
        expect(
          byTestId('sidebar-context-menu-item-ai-credits-balance')?.textContent,
        ).toBe('413');
        const reads = loadAvailability.mock.calls.length;
        // One read per open, not a render loop.
        await flush();
        expect(loadAvailability.mock.calls.length).toBe(reads);

        closeMenu();
        openMenu();
        await flush();
        expect(loadAvailability.mock.calls.length).toBe(reads + 1);

        click('sidebar-context-menu-item-ai-credits');
        expect(openPortalPage).toHaveBeenLastCalledWith(
          organizationBillingPath(ACME),
        );
      },
    );

    it('shows a zero pool and no number while unknown', async () => {
      seedContext(ACME_CONTEXT, [acme('OWNER')]);
      installApi({
        freeAccess: true,
        availability: () => Promise.resolve(pool(ACME, 0)),
      });
      await render();
      openMenu();
      await flush();
      expect(
        byTestId('sidebar-context-menu-item-ai-credits-balance')?.textContent,
      ).toBe('0');

      loadAvailability.mockRejectedValue(new Error('offline'));
      closeMenu();
      openMenu();
      await flush();
      expect(byTestId('sidebar-context-menu-item-ai-credits')).not.toBeNull();
      expect(
        byTestId('sidebar-context-menu-item-ai-credits-balance'),
      ).toBeNull();
    });

    it.each([
      ['an ADMIN without free access', 'ADMIN', false],
      ['a MEMBER', 'MEMBER', true],
      ['an OWNER without free access', 'OWNER', false],
    ] as const)(
      'offers no pool row to %s',
      async (_label, role, freeAccess) => {
        seedContext(ACME_CONTEXT, [acme(role)]);
        installApi({
          freeAccess,
          availability: () => Promise.resolve(pool(ACME, 412.5)),
        });
        await render();
        openMenu();
        await flush();
        expect(byTestId('sidebar-context-menu-item-ai-credits')).toBeNull();
        expect(loadAvailability).not.toHaveBeenCalled();
      },
    );

    it("never shows another organization's pool after a rapid switch", async () => {
      const pending: Array<(value: NativeAiCreditsAvailability) => void> = [];
      seedContext(ACME_CONTEXT, [
        acme('OWNER'),
        { id: ZEN, name: 'Zen', role: 'OWNER' },
      ]);
      installApi({
        freeAccess: true,
        availability: () =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      });
      await render();
      act(() =>
        seedContext({ kind: 'organization', organizationId: ZEN }, [
          acme('OWNER'),
          { id: ZEN, name: 'Zen', role: 'OWNER' },
        ]),
      );
      await flush();
      openMenu();
      await flush();
      // Acme's read lands late; Zen's row stays without a number.
      await act(async () => {
        for (const resolve of pending) resolve(pool(ACME, 412.5));
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(
        byTestId('sidebar-context-menu-item-ai-credits-balance'),
      ).toBeNull();
      click('sidebar-context-menu-item-ai-credits');
      expect(openPortalPage).toHaveBeenLastCalledWith(
        organizationBillingPath(ZEN),
      );
    });
  });

  it('marks another context with updates on the trigger', async () => {
    seedContext({ kind: 'personal' }, [acme('MEMBER')]);
    mockForeignProjection = runningIn(ACME_CONTEXT);
    installApi();
    await render();
    expect(byTestId('sidebar-context-attention-dot')).not.toBeNull();
    expect(byTestId('sidebar-context-row')?.getAttribute('aria-label')).toBe(
      'Workspace context: Personal, updates in Acme',
    );
  });

  describe('pending shares in other contexts (CAN-4783)', () => {
    function triggerLabel(): string | null | undefined {
      return byTestId('sidebar-context-row')?.getAttribute('aria-label');
    }
    function optionLabel(key: string): string | null | undefined {
      return byTestId(`sidebar-context-option-${key}`)?.getAttribute(
        'aria-label',
      );
    }
    function update(apply: () => void): void {
      act(apply);
    }

    it('marks the organization holding an invitation while Personal is selected', async () => {
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      seedShares([invitation('one', { organizationId: ACME })]);
      installApi();
      await render();
      expect(byTestId('sidebar-context-attention-dot')).not.toBeNull();
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 1 pending share in Acme',
      );
      openMenu();
      expect(byTestId(`sidebar-context-activity-${ACME}`)).not.toBeNull();
      expect(optionLabel(ACME)).toBe('Acme, 1 pending share');
      expect(byTestId('sidebar-context-activity-personal')).toBeNull();
    });

    it('follows the listing from none to two and back as shares arrive and resolve', async () => {
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      installApi();
      await render();
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
      expect(triggerLabel()).toBe('Workspace context: Personal');

      const one = invitation('one', { organizationId: ACME });
      const two = invitation('two', { organizationId: ACME });
      update(() => seedShares([one]));
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 1 pending share in Acme',
      );
      update(() => seedShares([one, two]));
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 2 pending shares in Acme',
      );
      // Accepted, still listed.
      update(() => seedShares([one, two], ['two']));
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 1 pending share in Acme',
      );
      // Removed from the listing.
      update(() => seedShares([two], ['two']));
      expect(triggerLabel()).toBe('Workspace context: Personal');
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
    });

    it('clears the cue when the last invitation is accepted', async () => {
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      seedShares([invitation('one', { organizationId: ACME })]);
      installApi();
      await render();
      update(() =>
        useSharedContainerReplicasStore.setState({ acceptedIds: ['one'] }),
      );
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
      expect(triggerLabel()).toBe('Workspace context: Personal');
    });

    it('clears the cue when the listing drops the last invitation', async () => {
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      seedShares([invitation('one', { organizationId: ACME })]);
      installApi();
      await render();
      update(() => seedShares([]));
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
      expect(triggerLabel()).toBe('Workspace context: Personal');
    });

    it('drops shares that lose VIEW or whose organization is no longer listed', async () => {
      seedContext({ kind: 'personal' }, [
        acme('MEMBER'),
        { id: ZEN, name: 'Zen', role: 'MEMBER' },
      ]);
      seedShares([
        invitation('one', { organizationId: ACME }),
        invitation('two', { organizationId: ZEN }),
      ]);
      installApi();
      await render();
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 1 pending share in Acme, 1 pending share in Zen',
      );
      update(() =>
        seedShares([
          invitation('one', { organizationId: ACME }, []),
          invitation('two', { organizationId: ZEN }),
        ]),
      );
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 1 pending share in Zen',
      );
      update(() => seedContext({ kind: 'personal' }, [acme('MEMBER')]));
      expect(triggerLabel()).toBe('Workspace context: Personal');
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
    });

    it('quiets the cue inside its context and restores it on return, without accepting', async () => {
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      seedShares([invitation('one', { organizationId: ACME })]);
      installApi();
      await render();
      openMenu();
      await act(async () => {
        byTestId(`sidebar-context-option-${ACME}`)?.click();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(byTestId('sidebar-context-row')?.textContent).toBe('Acme');
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
      expect(triggerLabel()).toBe('Workspace context: Acme');
      expect(useSharedContainerReplicasStore.getState().acceptedIds).toEqual(
        [],
      );

      openMenu();
      await act(async () => {
        byTestId('sidebar-context-option-personal')?.click();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 1 pending share in Acme',
      );
    });

    it('marks Personal for a direct share while an organization is selected', async () => {
      seedContext(ACME_CONTEXT, [acme('MEMBER')]);
      seedShares([
        invitation('direct', { access: 'direct', organizationId: ZEN }),
      ]);
      installApi();
      await render();
      expect(triggerLabel()).toBe(
        'Workspace context: Acme, 1 pending share in Personal',
      );
      openMenu();
      expect(optionLabel('personal')).toBe('Personal, 1 pending share');
    });

    it('keeps chat updates when the shares in the same context resolve', async () => {
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      mockForeignProjection = runningIn(ACME_CONTEXT);
      seedShares([invitation('one', { organizationId: ACME })]);
      installApi();
      await render();
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, updates in Acme, 1 pending share in Acme',
      );
      update(() => seedShares([]));
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, updates in Acme',
      );
      expect(byTestId('sidebar-context-attention-dot')).not.toBeNull();
      openMenu();
      expect(optionLabel(ACME)).toBe('Acme, has updates');
    });

    it('shows nothing while sharing is hidden or the context is not hydrated', async () => {
      mockShareEntryPointVisible = false;
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      seedShares([invitation('one', { organizationId: ACME })]);
      installApi();
      await render();
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
      expect(triggerLabel()).toBe('Workspace context: Personal');

      mockShareEntryPointVisible = true;
      act(() => {
        root.render(<ContextSwitcherUnderTest />);
      });
      await flush();
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 1 pending share in Acme',
      );

      update(() => useWorkspaceContextStore.setState({ hydrated: false }));
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
      update(() => useWorkspaceContextStore.setState({ hydrated: true }));
      expect(triggerLabel()).toBe(
        'Workspace context: Personal, 1 pending share in Acme',
      );
    });

    it('forgets the previous account’s shares when the store resets', async () => {
      seedContext({ kind: 'personal' }, [acme('MEMBER')]);
      seedShares([invitation('one', { organizationId: ACME })]);
      installApi();
      await render();
      expect(byTestId('sidebar-context-attention-dot')).not.toBeNull();
      update(() => useSharedContainerReplicasStore.getState().reset());
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
      expect(triggerLabel()).toBe('Workspace context: Personal');
    });
  });

  it('switches through main, disables the row while switching, and toasts a refused switch', async () => {
    seedContext({ kind: 'personal' }, [acme('MEMBER')]);
    installApi();
    let resolveSwitch: () => void = () => {};
    // The switcher reads the toast action when it renders.
    const addToast = jest.spyOn(useGitHubStore.getState(), 'addToast');
    await render();
    setContextIpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSwitch = (): void =>
            resolve({
              context: ACME_CONTEXT,
              revision: 2,
              organizations: [acme('MEMBER')],
            });
        }),
    );
    openMenu();
    await act(async () => {
      byTestId(`sidebar-context-option-${ACME}`)?.click();
      await Promise.resolve();
    });
    expect(setContextIpc).toHaveBeenCalledWith({
      context: ACME_CONTEXT,
      expectedRevision: 1,
    });
    expect(
      (byTestId('sidebar-context-row') as HTMLButtonElement | null)?.disabled,
    ).toBe(true);
    await act(async () => {
      resolveSwitch();
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
    expect(
      (byTestId('sidebar-context-row') as HTMLButtonElement | null)?.disabled,
    ).toBe(false);
    expect(byTestId('sidebar-context-row')?.textContent).toBe('Acme');

    try {
      setContextIpc.mockRejectedValueOnce(new Error('stale-revision'));
      openMenu();
      await act(async () => {
        byTestId('sidebar-context-option-personal')?.click();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(addToast).toHaveBeenCalledWith(
        "Couldn't switch context. Try again.",
        'error',
      );
      expect(byTestId('sidebar-context-row')?.textContent).toBe('Acme');
    } finally {
      addToast.mockRestore();
    }
  });

  // CAN-3672: pending organization invitations in the switcher.
  describe('pending organization invitations', () => {
    const GLOBEX = '55555555-5555-4555-8555-555555555555';
    let respond: jest.Mock<Promise<unknown>, [unknown]>;
    let incoming: jest.Mock<Promise<unknown>, []>;

    function globexInvitation(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        id: 'invite-1',
        organizationId: GLOBEX,
        organizationName: 'Globex',
        organizationTeamName: null,
        role: 'MEMBER',
        invitedByName: 'Grace',
        createdAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-11-01T00:00:00.000Z',
        enforcedSettings: [],
        ...overrides,
      };
    }

    beforeEach(() => {
      let invitations = [globexInvitation()];
      incoming = jest.fn<Promise<unknown>, []>(() =>
        Promise.resolve({ invitations }),
      );
      respond = jest.fn<Promise<unknown>, [unknown]>(() => {
        invitations = [];
        return Promise.resolve({ ok: true });
      });
      mockHostedSettingsClient = {
        read: (operation: string): Promise<unknown> =>
          operation === 'organization.invitations.incoming'
            ? incoming()
            : Promise.reject(new Error(`unexpected ${operation}`)),
        write: (operation: string, input: unknown): Promise<unknown> =>
          operation === 'organization.invitations.respond'
            ? respond(input)
            : Promise.reject(new Error(`unexpected ${operation}`)),
        subscribe: (): (() => void) => (): void => {},
      };
    });

    afterEach(() => {
      mockHostedSettingsClient = null;
      useRemoteControlStore.setState({ context: { mode: 'local' } });
      useNavigationStore.getState().closeSettings();
    });

    function installInvitationApi(): void {
      installApi();
      Object.assign(window.api, {
        refreshCanopyCloudEnforcedSettings: jest
          .fn()
          .mockResolvedValue(account()),
      });
    }

    it('shows the cue and the invitation with its offered role', async () => {
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installInvitationApi();
      await render();
      expect(incoming).toHaveBeenCalledTimes(1);
      expect(byTestId('sidebar-context-row')?.getAttribute('aria-label')).toBe(
        'Workspace context: Personal, 1 pending invitation',
      );
      expect(byTestId('sidebar-context-attention-dot')).not.toBeNull();
      openMenu();
      await flush();
      const row = byTestId('sidebar-context-invitation-invite-1');
      expect(row?.textContent).toContain('Globex');
      expect(row?.textContent).toContain('Member');
    });

    it('accepts once, then selects the organization and opens its Projects after main lists it', async () => {
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installInvitationApi();
      await render();
      openMenu();
      await flush();
      await act(async () => {
        byTestId('sidebar-context-invitation-accept-invite-1')?.click();
        byTestId('sidebar-context-invitation-accept-invite-1')?.click();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith({
        inviteId: 'invite-1',
        action: 'accept',
      });
      expect(window.api.refreshCanopyCloudEnforcedSettings).toHaveBeenCalled();
      // Nothing opens until main lists the membership.
      expect(setContextIpc).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().settingsOpen).toBe(false);

      await act(async () => {
        useWorkspaceContextStore.setState({
          state: {
            context: { kind: 'personal' },
            revision: 2,
            organizations: [
              acme('OWNER'),
              { id: GLOBEX, name: 'Globex', role: 'MEMBER' },
            ],
          },
        });
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      await flush();

      expect(setContextIpc).toHaveBeenCalledWith({
        context: { kind: 'organization', organizationId: GLOBEX },
        expectedRevision: 2,
      });
      const navigation = useNavigationStore.getState();
      expect(navigation.settingsOpen).toBe(true);
      expect(navigation.settingsHostedLocation?.route).toEqual({
        scope: 'organization',
        organizationId: GLOBEX,
        page: 'projects',
      });
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
    });

    it('declines after confirming, without switching or opening anything', async () => {
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installInvitationApi();
      await render();
      openMenu();
      await flush();
      click('sidebar-context-invitation-decline-invite-1');
      expect(respond).not.toHaveBeenCalled();
      await act(async () => {
        byTestId('sidebar-context-decline-invitation-confirm')?.click();
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(respond).toHaveBeenCalledWith({
        inviteId: 'invite-1',
        action: 'decline',
      });
      expect(setContextIpc).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().settingsOpen).toBe(false);
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
    });

    it('a newer explicit selection outside the switcher cancels a pending acceptance destination', async () => {
      let complete: (value: unknown) => void = () => {};
      respond.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installInvitationApi();
      await render();
      openMenu();
      await flush();
      click('sidebar-context-invitation-accept-invite-1');
      await flush();
      await act(async () => {
        useWorkspaceContextStore.getState().applyBroadcast({
          ...useWorkspaceContextStore.getState().state,
          revision: 2,
          reason: 'switch',
          context: { kind: 'personal' },
        });
        complete({ ok: true });
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      await act(async () => {
        useWorkspaceContextStore.setState({
          state: {
            context: { kind: 'personal' },
            revision: 3,
            organizations: [
              acme('OWNER'),
              { id: GLOBEX, name: 'Globex', role: 'MEMBER' },
            ],
          },
        });
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(respond).toHaveBeenCalledTimes(1);
      expect(setContextIpc).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().settingsOpen).toBe(false);
    });

    it('re-reads on a same-account refresh that leaves memberships unchanged', async () => {
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installInvitationApi();
      await render();
      expect(incoming).toHaveBeenCalledTimes(1);
      incoming.mockResolvedValueOnce({ invitations: [] });
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
            detail: { reason: 'same-account-refresh' },
          }),
        );
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      await flush();
      expect(incoming).toHaveBeenCalledTimes(2);
      expect(byTestId('sidebar-context-attention-dot')).toBeNull();
    });

    it('uses refresh completion once when the same refresh also broadcasts memberships', async () => {
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installInvitationApi();
      await render();
      await act(async () => {
        useWorkspaceContextStore.setState({
          state: {
            context: { kind: 'personal' },
            revision: 2,
            organizations: [acme('OWNER')],
          },
        });
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(incoming).toHaveBeenCalledTimes(1);
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, {
            detail: { reason: 'same-account-refresh' },
          }),
        );
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
      });
      expect(incoming).toHaveBeenCalledTimes(2);
    });

    it('routes an invitation with enforced settings to Settings > Organizations', async () => {
      incoming.mockResolvedValue({
        invitations: [
          globexInvitation({
            enforcedSettings: [
              {
                organizationId: GLOBEX,
                organizationName: 'Globex',
                policies: [],
              },
            ],
          }),
        ],
      });
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installInvitationApi();
      await render();
      openMenu();
      await flush();
      click('sidebar-context-invitation-review-invite-1');
      expect(respond).not.toHaveBeenCalled();
      expect(
        useNavigationStore.getState().settingsHostedLocation?.route,
      ).toEqual({ scope: 'organizations' });
    });

    it('reads nothing in a remote-control window', async () => {
      useRemoteControlStore.setState({
        context: {
          mode: 'remote',
          deviceId: 'dev-b',
          name: 'Studio',
          platform: 'linux',
        },
      });
      seedContext({ kind: 'personal' }, [acme('OWNER')]);
      installInvitationApi();
      await render();
      openMenu();
      await flush();
      expect(incoming).not.toHaveBeenCalled();
      expect(byTestId('sidebar-context-invitations')).toBeNull();
    });
  });
});
