/**
 * @jest-environment jsdom
 *
 * Covers the desktop bindings the shared share dialog cannot see: the
 * organization/team membership derived from the cloud account, and
 * organization setup through the authenticated portal bridge.
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ShareResourceScope } from '@canopy/ui-app/sharing';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type { CanopyCloudEntitlementsState } from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { readCanopyCloudAccountChangeReason } from '@/lib/canopyCloudAccountChange';
import { useCloudConnectGateStore } from '@/stores/cloudConnectGateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { DesktopShareResourceDialog } from '../DesktopShareResourceDialog';
import { desktopOrganizationAccess } from '@/lib/sharing/organization-access';

let mockHostedSettingsClient: unknown = null;
jest.mock('@/client/hosted-settings-client-registry', () => ({
  registeredHostedSettingsClient: (): unknown => mockHostedSettingsClient,
}));

const PREFIX = 'share-thing';

describe('DesktopShareResourceDialog', () => {
  let container: HTMLDivElement;
  let root: Root;
  const share = jest.fn(() => Promise.resolve({}));
  const onClose = jest.fn();
  const loadCanopyCloudAccount = jest.fn();
  const loadCanopyCloudEntitlements = jest.fn<
    Promise<CanopyCloudEntitlementsState>,
    []
  >();
  const openAuthenticatedPortalPage = jest.fn<Promise<boolean>, [string]>();
  const refreshCanopyCloudEnforcedSettings = jest.fn<Promise<unknown>, []>(() =>
    Promise.resolve(),
  );
  const listSharedTeams = jest.fn(() =>
    Promise.resolve({ success: true, data: { data: [] } }),
  );
  const listSharedOrganizations = jest.fn<
    ReturnType<typeof window.pipelines.listSharedOrganizations>,
    Parameters<typeof window.pipelines.listSharedOrganizations>
  >(() =>
    Promise.resolve({
      success: true,
      data: { serverId: 'server-1', data: [] },
    }),
  );

  function account(membership: {
    organizations?: { id: string; name: string }[];
    teams?: {
      id: string;
      name: string;
      organization: { id: string; name: string };
    }[];
  }): Record<string, unknown> {
    return {
      hasApiKey: true,
      capabilities: ['skills-crud-v1', 'teams-v1', 'organizations-v1'],
      storageAvailable: true,
      account: {
        id: 'account-1',
        name: 'Alice',
        email: 'alice@example.test',
        role: 'ADMIN',
      },
      ...membership,
    };
  }

  /** A device-scoped guest credential, which still has an API key. */
  function guestAccount(): Record<string, unknown> {
    return {
      hasApiKey: true,
      authMode: 'guest',
      credentialSource: 'guest',
      capabilities: ['skills-crud-v1'],
      storageAvailable: true,
      account: {
        id: 'guest-1',
        name: 'Guest',
        email: 'guest+1@guest.canopy.invalid',
        role: 'DEVELOPER',
      },
    };
  }

  /** Free access grants every capability with no plan or trial. */
  function entitlements(freeAccess: boolean): CanopyCloudEntitlementsState {
    return {
      resolved: true,
      canDisableSharing: freeAccess,
      canRemoteControl: freeAccess,
      source: 'none',
      plan: null,
      trial: null,
      billingManageableOrg: null,
      displayPlan: null,
      billingPresentation: null,
      freeAccess,
    };
  }

  const ACME = {
    id: 'org-1',
    name: 'Acme',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const BETA = {
    id: 'org-2',
    name: 'Beta',
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };
  const PLATFORM = { id: 'team-1', name: 'Platform', organization: ACME };

  beforeEach(() => {
    share.mockClear();
    onClose.mockClear();
    loadCanopyCloudAccount.mockReset();
    loadCanopyCloudEntitlements.mockReset();
    loadCanopyCloudEntitlements.mockResolvedValue(entitlements(false));
    useCloudConnectGateStore.setState({ pending: null });
    openAuthenticatedPortalPage.mockReset();
    openAuthenticatedPortalPage.mockResolvedValue(true);
    refreshCanopyCloudEnforcedSettings.mockReset();
    refreshCanopyCloudEnforcedSettings.mockImplementation(() =>
      Promise.resolve(),
    );
    listSharedTeams.mockClear();
    listSharedOrganizations.mockClear();
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot(),
    });
    useWorkspaceContextStore.setState(
      useWorkspaceContextStore.getInitialState(),
      true,
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.assign(window, {
      api: {
        loadCanopyCloudAccount,
        loadCanopyCloudEntitlements,
        openAuthenticatedPortalPage,
        refreshCanopyCloudEnforcedSettings,
      },
      pipelines: { listSharedTeams, listSharedOrganizations },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    mockHostedSettingsClient = null;
    useNavigationStore.getState().closeSettings();
  });

  async function renderDialog(
    scopes: readonly ShareResourceScope[] = ['team', 'organization', 'public'],
  ): Promise<void> {
    await act(async () => {
      root.render(
        <DesktopShareResourceDialog
          resourceNoun="thing"
          testIdPrefix={PREFIX}
          requiredCapability="skills-crud-v1"
          scopes={scopes}
          share={share}
          onClose={onClose}
        />,
      );
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
    });
  }

  function byTestId(id: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  }

  // A pill with a reason stays focusable for its tooltip (`aria-disabled`).
  function scopeDisabled(scope: ShareResourceScope): boolean | undefined {
    const option = byTestId(`${PREFIX}-scope-${scope}`);
    if (!option) return undefined;
    return (
      option.hasAttribute('disabled') ||
      option.getAttribute('aria-disabled') === 'true'
    );
  }

  it('keeps the pills for an account with no organization, with Team and Organization disabled and Public preselected', async () => {
    loadCanopyCloudAccount.mockResolvedValue(
      account({ organizations: [], teams: [] }),
    );
    await renderDialog();

    // Every scope stays visible so the author sees Share will publish
    // publicly; the setup step lives in the disabled pills' tooltip.
    expect(scopeDisabled('team')).toBe(true);
    expect(scopeDisabled('organization')).toBe(true);
    expect(
      byTestId(`${PREFIX}-scope-public`)?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(byTestId(`${PREFIX}-organization-hint`)).toBeNull();
    expect(byTestId(`${PREFIX}-set-up-organization`)).toBeNull();
    act(() => {
      byTestId(`${PREFIX}-scope-team`)?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
    });
    expect(byTestId(`${PREFIX}-scope-team-reason`)?.textContent).toBe(
      'Team and organization sharing start with an organization.',
    );
    expect(byTestId(`${PREFIX}-set-up-organization`)).not.toBeNull();
    // Public stays usable, so the dialog is not replaced by the setup gate.
    expect(byTestId(`${PREFIX}-organization-required`)).toBeNull();
    expect(byTestId(`${PREFIX}-submit`)).not.toBeNull();
  });

  it('refreshes membership when the author returns from organization setup', async () => {
    loadCanopyCloudAccount.mockResolvedValue(
      account({ organizations: [], teams: [] }),
    );
    // Without Public there is no usable audience, so the setup gate is shown.
    await renderDialog(['team', 'organization']);

    // Nothing is refreshed before the setup page was opened.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(refreshCanopyCloudEnforcedSettings).not.toHaveBeenCalled();

    await act(async () => {
      byTestId(`${PREFIX}-set-up-organization`)?.click();
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });

    // The author created an organization on the web and came back.
    loadCanopyCloudAccount.mockResolvedValue(
      account({ organizations: [ACME], teams: [PLATFORM] }),
    );
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
    });

    expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalledTimes(1);
    expect(scopeDisabled('team')).toBe(false);
    expect(scopeDisabled('organization')).toBe(false);
    expect(byTestId(`${PREFIX}-organization-hint`)).toBeNull();

    // Later returns refresh again (the author may have come back before
    // finishing setup) until the dialog closes.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
    root = createRoot(container);
    window.dispatchEvent(new Event('focus'));
    expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalledTimes(2);
  });

  it('announces a return from organization setup as a same-account refresh (CAN-4061)', async () => {
    const before = account({ organizations: [], teams: [] });
    const after = account({ organizations: [ACME], teams: [PLATFORM] });
    loadCanopyCloudAccount.mockResolvedValue(before);
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(after);
    await renderDialog(['team', 'organization']);
    await act(async () => {
      byTestId(`${PREFIX}-set-up-organization`)?.click();
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });
    const reasons: string[] = [];
    const record = (event: Event): void => {
      reasons.push(readCanopyCloudAccountChangeReason(event));
    };
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);

    loadCanopyCloudAccount.mockResolvedValue(after);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
    });
    // A failed re-probe still tells the dialog to reload membership.
    refreshCanopyCloudEnforcedSettings.mockRejectedValue(new Error('offline'));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
    });

    window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, record);
    expect(reasons).toEqual(['same-account-refresh', 'refresh-failed']);
    expect(scopeDisabled('team')).toBe(false);
  });

  it('replaces the selector when a team-or-organization resource has no organization', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account({ organizations: [] }));
    await renderDialog(['team', 'organization']);

    expect(byTestId(`${PREFIX}-organization-required`)).not.toBeNull();
    expect(byTestId(`${PREFIX}-scope`)).toBeNull();
    expect(byTestId(`${PREFIX}-submit`)).toBeNull();
    expect(byTestId(`${PREFIX}-set-up-organization`)).not.toBeNull();
  });

  it('keeps the setup action and explains when the portal page does not open', async () => {
    openAuthenticatedPortalPage.mockResolvedValue(false);
    loadCanopyCloudAccount.mockResolvedValue(account({ organizations: [] }));
    await renderDialog(['team', 'organization']);

    await act(async () => {
      byTestId(`${PREFIX}-set-up-organization`)?.click();
      for (let flush = 0; flush < 3; flush += 1) await Promise.resolve();
    });

    expect(openAuthenticatedPortalPage).toHaveBeenCalledWith('/organization');
    expect(byTestId(`${PREFIX}-set-up-organization-error`)).not.toBeNull();
    expect(byTestId(`${PREFIX}-set-up-organization`)).not.toBeNull();
  });

  it('opens organization setup inside Settings and closes the dialog when hosted settings are openable', async () => {
    mockHostedSettingsClient = {};
    loadCanopyCloudAccount.mockResolvedValue(account({ organizations: [] }));
    await renderDialog(['team', 'organization']);

    await act(async () => {
      byTestId(`${PREFIX}-set-up-organization`)?.click();
      for (let flush = 0; flush < 3; flush += 1) await Promise.resolve();
    });

    expect(useNavigationStore.getState().settingsHostedLocation?.route).toEqual(
      { scope: 'organizations' },
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    expect(byTestId(`${PREFIX}-set-up-organization-error`)).toBeNull();
    // Nothing finishes on the web, so returning to the window re-probes nothing.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(refreshCanopyCloudEnforcedSettings).not.toHaveBeenCalled();
  });

  describe('Choose a plan for a lapsed organization', () => {
    async function renderLapsed(): Promise<void> {
      loadCanopyCloudAccount.mockResolvedValue({
        ...account({ organizations: [ACME], teams: [] }),
        organizations: [{ ...ACME, role: 'OWNER' }],
        orgBillingStates: [
          {
            organizationId: ACME.id,
            organizationName: ACME.name,
            teamsEntitled: false,
          },
        ],
      });
      await renderDialog(['organization']);
      await act(async () => {
        byTestId(`${PREFIX}-scope-organization`)?.click();
        for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
      });
    }

    it('opens organization billing inside Settings and closes the dialog', async () => {
      mockHostedSettingsClient = {};
      await renderLapsed();
      await act(async () => {
        byTestId(`${PREFIX}-choose-plan`)?.click();
        await Promise.resolve();
      });
      expect(
        useNavigationStore.getState().settingsHostedLocation?.route,
      ).toEqual({
        scope: 'organization',
        organizationId: ACME.id,
        page: 'settings',
        subtab: 'billing',
      });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(openAuthenticatedPortalPage).not.toHaveBeenCalled();
    });

    it('opens organization billing on the web and re-probes on return', async () => {
      await renderLapsed();
      await act(async () => {
        byTestId(`${PREFIX}-choose-plan`)?.click();
        await Promise.resolve();
      });
      expect(openAuthenticatedPortalPage).toHaveBeenCalledWith(
        `/organization/${ACME.id}/settings?tab=billing`,
      );
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => {
        window.dispatchEvent(new Event('focus'));
        for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
      });
      expect(refreshCanopyCloudEnforcedSettings).toHaveBeenCalled();
    });
  });

  it('disables only Team for an organization member with no team', async () => {
    loadCanopyCloudAccount.mockResolvedValue(
      account({ organizations: [ACME], teams: [] }),
    );
    await renderDialog();

    expect(scopeDisabled('team')).toBe(true);
    expect(scopeDisabled('organization')).toBe(false);
    expect(scopeDisabled('public')).toBe(false);
    expect(byTestId(`${PREFIX}-organization-hint`)).toBeNull();
    expect(byTestId(`${PREFIX}-set-up-organization`)).toBeNull();
    // Team is unusable, so the fallback lands on Organization.
    expect(
      byTestId(`${PREFIX}-scope-organization`)?.getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('keeps Team and Organization available when membership is reported', async () => {
    loadCanopyCloudAccount.mockResolvedValue(
      account({ organizations: [ACME], teams: [PLATFORM] }),
    );
    await renderDialog();

    expect(scopeDisabled('team')).toBe(false);
    expect(scopeDisabled('organization')).toBe(false);
    expect(byTestId(`${PREFIX}-organization-hint`)).toBeNull();
    expect(byTestId(`${PREFIX}-scope-team`)?.getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('keeps Team and Organization available when feature flags fall back to their outage defaults', async () => {
    // A flag-service outage must not empty the dialog: Teams has shipped, so
    // the audiences depend on membership alone.
    useFeatureFlagsStore.setState({
      snapshot: getDefaultFeatureFlagSnapshot('error'),
    });
    loadCanopyCloudAccount.mockResolvedValue(
      account({ organizations: [ACME], teams: [PLATFORM] }),
    );
    await renderDialog();

    expect(scopeDisabled('team')).toBe(false);
    expect(scopeDisabled('organization')).toBe(false);
    expect(scopeDisabled('public')).toBe(false);
    expect(byTestId(`${PREFIX}-scope-team`)?.getAttribute('aria-checked')).toBe(
      'true',
    );
  });

  it('passes the selected desktop context and account organizations to the shared dialog', async () => {
    const snapshot = getDefaultFeatureFlagSnapshot();
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        status: 'ready',
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    useWorkspaceContextStore.setState({
      hydrated: true,
      state: {
        context: { kind: 'organization', organizationId: BETA.id },
        revision: 1,
        organizations: [{ ...BETA, role: 'MEMBER' }],
      },
    });
    loadCanopyCloudAccount.mockResolvedValue(
      account({ organizations: [ACME, BETA], teams: [PLATFORM] }),
    );
    listSharedOrganizations.mockResolvedValue({
      success: true,
      data: { serverId: 'server-1', data: [ACME, BETA] },
    });

    await renderDialog(['organization']);
    await act(async () => {
      for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
    });

    expect(
      byTestId(`${PREFIX}-organization-picker-option-${BETA.id}`)?.getAttribute(
        'aria-pressed',
      ),
    ).toBe('true');
  });

  it('treats an account that does not report membership as available', async () => {
    loadCanopyCloudAccount.mockResolvedValue(account({}));
    await renderDialog();

    expect(scopeDisabled('team')).toBe(false);
    expect(scopeDisabled('organization')).toBe(false);
    expect(byTestId(`${PREFIX}-organization-hint`)).toBeNull();
    expect(byTestId(`${PREFIX}-organization-required`)).toBeNull();
  });
  it('offers a guest a free trial when the server reports no free access', async () => {
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    await renderDialog();

    expect(byTestId(`${PREFIX}-guest-cta-button`)?.textContent).toBe(
      'Start free trial',
    );
    await act(async () => {
      byTestId(`${PREFIX}-guest-cta-button`)?.click();
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });
    expect(useCloudConnectGateStore.getState().pending?.context.title).toBe(
      'Start your free trial',
    );
  });

  it('asks a guest to sign in to share under free access', async () => {
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    loadCanopyCloudEntitlements.mockResolvedValue(entitlements(true));
    await renderDialog();

    const cta = byTestId(`${PREFIX}-guest-cta`);
    // The "Create a free account" line is unchanged; only the trial framing goes.
    expect(cta?.textContent).toContain(
      'Create a free account to share things.',
    );
    expect(cta?.textContent).not.toContain('trial');
    expect(byTestId(`${PREFIX}-guest-cta-button`)?.textContent).toBe('Sign in');

    await act(async () => {
      byTestId(`${PREFIX}-guest-cta-button`)?.click();
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
    });
    expect(useCloudConnectGateStore.getState().pending?.context.title).toBe(
      'Sign in to share',
    );
  });
});

describe('desktopOrganizationAccess', () => {
  const organization = (
    id: string,
    role?: 'OWNER' | 'ADMIN' | 'MEMBER',
  ): {
    id: string;
    name: string;
    role?: 'OWNER' | 'ADMIN' | 'MEMBER';
    createdAt: string;
    updatedAt: string;
  } => ({
    id,
    name: id.toUpperCase(),
    ...(role ? { role } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('reads only an explicit lapsed billing entry as lapsed, and only an owner as able to choose a plan', () => {
    expect(
      desktopOrganizationAccess({
        organizations: [
          organization('acme', 'OWNER'),
          organization('beta', 'MEMBER'),
          organization('gamma'),
        ],
        orgBillingStates: [
          {
            organizationId: 'acme',
            organizationName: 'ACME',
            teamsEntitled: false,
          },
          {
            organizationId: 'beta',
            organizationName: 'BETA',
            teamsEntitled: true,
          },
        ],
      }),
    ).toEqual([
      {
        organizationId: 'acme',
        organizationName: 'ACME',
        teamsEntitled: false,
        canChoosePlan: true,
      },
      {
        organizationId: 'beta',
        organizationName: 'BETA',
        teamsEntitled: true,
        canChoosePlan: false,
      },
      // No billing entry and no role: both stay unknown.
      { organizationId: 'gamma', organizationName: 'GAMMA' },
    ]);
  });

  it('reports no facts for an account that stores neither list', () => {
    expect(desktopOrganizationAccess({})).toBeUndefined();
  });
});
