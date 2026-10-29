/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
  CanopyCloudAiCreditsState,
  CanopyCloudEntitlementsState,
  TelemetrySyncStatus,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { PrivacyTab } from '../PrivacyTab';

// The new "Cloud Sync" section embeds the heavy CanopyCloudAccountSection
// (loads API keys, OAuth state, etc.). These tests exercise PrivacyTab's own
// subscription gate, so stub the section — its behavior has dedicated coverage.
jest.mock('../CanopyCloudAccountSection', () => ({
  CanopyCloudAccountSection: (): null => null,
}));

let mockHostedSettingsAvailable = false;
jest.mock('../hosted/hosted-settings-availability', () => ({
  ...jest.requireActual<object>('../hosted/hosted-settings-availability'),
  useHostedSettingsAvailable: (): boolean => mockHostedSettingsAvailable,
}));

const ACME_ORG_ID = '0b7c2d4e-8f1a-4b3c-9d5e-6f7a8b9c0d1e';

/** Select Acme (or Personal) as the workspace context the tab reads. */
function selectContext(organizationId: string | null): void {
  useWorkspaceContextStore.setState({
    hydrated: true,
    state: {
      context: organizationId
        ? { kind: 'organization', organizationId }
        : { kind: 'personal' },
      revision: 1,
      organizations: [{ id: ACME_ORG_ID, name: 'Acme', role: 'MEMBER' }],
    },
  });
}

describe('PrivacyTab subscription gate', () => {
  let container: HTMLElement;
  let root: Root;
  const loadCanopyCloudAiCredits = jest.fn();
  const loadCanopyCloudEntitlements = jest.fn();
  const loadCanopyCloudAccount = jest.fn();
  const refreshCanopyCloudEnforcedSettings = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadCanopyCloudAiCredits.mockResolvedValue(nonSubscriberCredits());
    // Default to a resolved free (non-`data_sync_control`) probe: it no longer
    // gates Off, which the tests below assert.
    loadCanopyCloudEntitlements.mockResolvedValue(gatedEntitlements());
    loadCanopyCloudAccount.mockResolvedValue(connectedAccount());
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(connectedAccount());
    Object.assign(window, {
      api: {
        loadPreferences: jest.fn(() => Promise.resolve(makeTestPreferences())),
        savePreferences: jest.fn(() => Promise.resolve()),
        loadCanopyCloudAccount,
        refreshCanopyCloudEnforcedSettings,
        onPreferencesChanged: jest.fn(() => (): void => {}),
        onPreferencesSynced: jest.fn(() => (): void => {}),
        loadCanopyCloudAiCredits,
        loadCanopyCloudEntitlements,
        browser: { openExternal: jest.fn(() => Promise.resolve()) },
        telemetrySync: {
          getStatus: jest.fn(() => Promise.resolve(telemetrySyncStatus())),
          onStatusEvent: jest.fn(() => (): void => {}),
        },
      } as Partial<CanopyApi> as CanopyApi,
    });
  });

  it('reports Personal catalog state and clears it when Privacy unmounts', async (): Promise<void> => {
    const snapshot = useFeatureFlagsStore.getState().snapshot;
    useFeatureFlagsStore.setState({
      snapshot: {
        ...snapshot,
        values: {
          ...snapshot.values,
          [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
        },
      },
    });
    await renderTab();
    expect(
      useCurrentUiStateStore.getState().slices['settings.personalCatalog'],
    ).toMatchObject({ loaded: true, enabled: false, pending: false });
    act((): void => {
      root.render(<div />);
    });
    expect(
      useCurrentUiStateStore.getState().slices['settings.personalCatalog'],
    ).toBeUndefined();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllMocks();
    selectContext(null);
    mockHostedSettingsAvailable = false;
  });

  describe('with hosted account settings', () => {
    let originalFlags: ReturnType<
      typeof useFeatureFlagsStore.getState
    >['snapshot'];

    beforeEach(() => {
      // Organization projects on, so the personal-catalog section can mount.
      originalFlags = useFeatureFlagsStore.getState().snapshot;
      useFeatureFlagsStore.setState({
        snapshot: {
          ...originalFlags,
          values: {
            ...originalFlags.values,
            [CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key]: true,
          },
        },
      });
    });

    afterEach(() => {
      useFeatureFlagsStore.setState({ snapshot: originalFlags });
    });

    function sectionTitles(): string[] {
      return Array.from(container.querySelectorAll('section > div > h2')).map(
        (heading) => heading.textContent?.trim() ?? '',
      );
    }

    it('keeps only Activity sharing when hosted settings are available', async () => {
      mockHostedSettingsAvailable = true;
      await renderTab();

      // The cloud account is on hosted Account; the catalog on Public profile.
      expect(sectionTitles()).toEqual(['Activity sharing']);
      expect(
        container.querySelector('[data-testid="personal-catalog-settings"]'),
      ).toBeNull();
      expect(
        useCurrentUiStateStore.getState().slices['settings.personalCatalog'],
      ).toBeUndefined();
      expect(
        container.querySelector(
          '[data-testid="telemetry-sharing-transcripts-off"]',
        ),
      ).not.toBeNull();
    });

    it('keeps Cloud sync and the personal catalog when hosted settings are unavailable', async () => {
      await renderTab();

      expect(sectionTitles()).toEqual([
        'Cloud sync',
        'Personal projects on the web',
        'Activity sharing',
      ]);
    });
  });

  async function renderTab(): Promise<void> {
    await act(async () => {
      root.render(<PrivacyTab />);
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });
  }

  it('shows stored Off as selectable Off with no CTA for a non-subscriber', async () => {
    await renderTab();

    const transcriptsOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    // Off is no longer a paid perk: a free probe neither floors nor gates it.
    expect(transcriptsOff?.getAttribute('aria-disabled')).toBeNull();
    expect(transcriptsOff?.disabled).toBe(false);
    expect(transcriptsOff?.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector('[data-testid="telemetry-subscribe-cta"]'),
    ).toBeNull();
  });

  it('keeps Off selectable while entitlements are still loading', async () => {
    loadCanopyCloudEntitlements.mockReturnValue(new Promise(() => {}));

    await renderTab();

    const transcriptsOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    expect(transcriptsOff?.disabled).toBe(false);
    expect(transcriptsOff?.getAttribute('aria-disabled')).toBeNull();
    expect(transcriptsOff?.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="telemetry-sharing-bulk-off"]',
      )?.disabled,
    ).toBe(false);
  });

  it('enables Off with no CTA for a confirmed subscriber', async () => {
    loadCanopyCloudAiCredits.mockResolvedValue(subscriberCredits());
    // A confirmed subscriber holds the `data_sync_control` entitlement, so the
    // gate opens and the unlock CTA is suppressed.
    loadCanopyCloudEntitlements.mockResolvedValue(entitledEntitlements());

    await renderTab();

    const transcriptsOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    expect(transcriptsOff?.disabled).toBe(false);
    expect(transcriptsOff?.getAttribute('aria-pressed')).toBe('true');
    expect(
      container.querySelector('[data-testid="telemetry-subscribe-cta"]'),
    ).toBeNull();
  });

  it('hides the subscribe CTA when the org manages telemetry, even for a non-subscriber', async () => {
    // Non-subscriber (default) would normally show the CTA, but the org enforces
    // (locks) every scope, so the member can't disable sharing regardless.
    loadCanopyCloudAccount.mockResolvedValue(orgEnforcedAccount());
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(orgEnforcedAccount());
    selectContext(ACME_ORG_ID);

    await renderTab();

    // Scopes are pinned to Organization by the org lock...
    const transcriptsOrg = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-organization"]',
    );
    expect(transcriptsOrg?.getAttribute('aria-pressed')).toBe('true');
    // ...and the subscribe CTA is suppressed.
    expect(
      container.querySelector('[data-testid="telemetry-subscribe-cta"]'),
    ).toBeNull();
  });

  it('pins a prohibited scope to Off', async () => {
    loadCanopyCloudAccount.mockResolvedValue(orgProhibitedAccount());
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(
      orgProhibitedAccount(),
    );
    selectContext(ACME_ORG_ID);

    await renderTab();

    const transcriptsOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    expect(transcriptsOff?.getAttribute('aria-pressed')).toBe('true');
    expect(transcriptsOff?.disabled).toBe(true);
    const transcriptsPrivate = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-private"]',
    );
    expect(transcriptsPrivate?.getAttribute('aria-pressed')).toBe('false');
    expect(
      container.querySelector('[data-testid="telemetry-subscribe-cta"]'),
    ).toBeNull();
  });

  // CAN-3459: an org's rules govern only that org's work, so Personal shows
  // the member's own choices with nothing locked.
  it('locks nothing in Personal even when an org enforces every scope', async () => {
    loadCanopyCloudAccount.mockResolvedValue(orgEnforcedAccount());
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(orgEnforcedAccount());
    selectContext(null);

    await renderTab();

    expect(
      container
        .querySelector('[data-testid="telemetry-sharing-row-transcripts"]')
        ?.getAttribute('data-locked'),
    ).toBeNull();
    const transcriptsOff = container.querySelector<HTMLButtonElement>(
      '[data-testid="telemetry-sharing-transcripts-off"]',
    );
    expect(transcriptsOff?.getAttribute('aria-pressed')).toBe('true');
    expect(transcriptsOff?.disabled).toBe(false);
    expect(
      container.querySelector('[data-testid="telemetry-subscribe-cta"]'),
    ).toBeNull();
  });

  // Locks are display only: editing an unlocked row saves the member's own
  // stored value for every scope, never the org's pinned values.
  it('never saves the selected org pins into the preference', async () => {
    loadCanopyCloudAccount.mockResolvedValue(orgProhibitedAccount());
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(
      orgProhibitedAccount(),
    );
    const stored = makeTestPreferences();
    stored.telemetrySharing = {
      transcripts: 'organization',
      plans: 'off',
      metadata: 'off',
      summaries: 'off',
    };
    const savePreferences = jest.fn(() => Promise.resolve());
    Object.assign(window.api, {
      loadPreferences: jest.fn(() => Promise.resolve(stored)),
      savePreferences,
    });
    selectContext(ACME_ORG_ID);

    await renderTab();

    // Displayed at the prohibited `off`...
    expect(
      container
        .querySelector('[data-testid="telemetry-sharing-transcripts-off"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="telemetry-sharing-plans-private"]',
        )
        ?.click();
      await Promise.resolve();
    });

    // ...but the saved preference keeps the member's own `organization`.
    expect(savePreferences).toHaveBeenCalledWith({
      telemetrySharing: {
        transcripts: 'organization',
        plans: 'private',
        metadata: 'off',
        summaries: 'off',
      },
    });
  });

  // Regression: a disconnected cloud account made the flush loop defer without
  // recording an upload error, so the last successful sync kept rendering as a
  // green "Synced 14h ago · 237 pending" while the Cloud Sync card directly
  // above showed a red dot and a Login button for the same account.
  it('reports the sync status as disconnected when the cloud credential is gone', async () => {
    loadCanopyCloudAccount.mockResolvedValue(unreadableAccount());
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(unreadableAccount());
    const staleSyncedStatus: TelemetrySyncStatus = {
      ...telemetrySyncStatus(),
      lastSyncedAt: new Date(Date.now() - 14 * 3_600_000).toISOString(),
      pendingCount: 237,
    };
    window.api.telemetrySync.getStatus = jest.fn(() =>
      Promise.resolve(staleSyncedStatus),
    );

    await renderTab();

    const line = container.querySelector<HTMLElement>(
      '[data-testid="settings-cloud-sync-status"]',
    );
    expect(line?.textContent).toBe('Sign in to sync · 237 pending');
  });

  it('keeps the last-synced status for a connected account', async () => {
    const syncedStatus: TelemetrySyncStatus = {
      ...telemetrySyncStatus(),
      lastSyncedAt: new Date(Date.now() - 300_000).toISOString(),
      pendingCount: 4,
    };
    window.api.telemetrySync.getStatus = jest.fn(() =>
      Promise.resolve(syncedStatus),
    );

    await renderTab();

    const line = container.querySelector<HTMLElement>(
      '[data-testid="settings-cloud-sync-status"]',
    );
    expect(line?.textContent).toContain('Synced 5m ago');
    expect(line?.textContent).toContain('4 pending');
  });

  // A guest holds a real device credential that uploads normally, so it must
  // not be reported as disconnected the way the real-account surfaces do.
  it('treats a guest device credential as connected for sync status', async () => {
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());
    refreshCanopyCloudEnforcedSettings.mockResolvedValue(guestAccount());
    const syncedStatus: TelemetrySyncStatus = {
      ...telemetrySyncStatus(),
      lastSyncedAt: new Date(Date.now() - 300_000).toISOString(),
    };
    window.api.telemetrySync.getStatus = jest.fn(() =>
      Promise.resolve(syncedStatus),
    );

    await renderTab();

    expect(
      container.querySelector<HTMLElement>(
        '[data-testid="settings-cloud-sync-status"]',
      )?.textContent,
    ).toContain('Synced 5m ago');
  });
});

function telemetrySyncStatus(): TelemetrySyncStatus {
  return {
    isSyncing: false,
    pendingCount: 0,
    sharingActive: true,
    lastSyncedAt: null,
    lastErrorAt: null,
    lastError: null,
  };
}

function connectedAccount(): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: ['portal-v1'],
    storageAvailable: true,
    account: {
      id: 'acct-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'ADMIN',
    },
  };
}

/**
 * The degraded/signed-out shape the account store collapses an unreadable or
 * absent credential into: no API key and no resolved account metadata.
 */
function unreadableAccount(): CanopyCloudAccountPublicState {
  return {
    read: 'error',
    hasApiKey: false,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
  };
}

/** Consented guest device credential (CAN-936) — uploads like a real account. */
function guestAccount(): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'guest',
    credentialSource: 'guest',
    capabilities: ['portal-v1'],
    storageAvailable: true,
    account: {
      id: 'guest-1',
      name: 'Guest',
      email: 'guest+abc@guest.canopy.invalid',
      role: 'MEMBER',
    },
  };
}

function orgEnforcedAccount(): CanopyCloudAccountPublicState {
  return {
    ...connectedAccount(),
    enforcedSettings: [
      {
        organizationId: ACME_ORG_ID,
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: { transcripts: true, plans: true, metadata: true },
          },
        ],
      },
    ],
  };
}

/** Connected, in an org that prohibits transcripts at every visibility. */
function orgProhibitedAccount(): CanopyCloudAccountPublicState {
  return {
    ...connectedAccount(),
    enforcedSettings: [
      {
        organizationId: ACME_ORG_ID,
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {
              transcripts: false,
              plans: false,
              metadata: false,
              summaries: false,
            },
            prohibitedScopes: {
              transcripts: true,
              plans: false,
              metadata: false,
              summaries: false,
            },
          },
        ],
      },
    ],
  };
}

function nonSubscriberCredits(): CanopyCloudAiCreditsState {
  return {
    connected: true,
    email: 'alice@example.com',
    subscription: { email: 'alice@example.com', active: false },
    balance: null,
    noUdAccount: false,
    error: null,
  };
}

function subscriberCredits(): CanopyCloudAiCreditsState {
  return {
    ...nonSubscriberCredits(),
    subscription: { email: 'alice@example.com', active: true },
  };
}

/** Resolved probe without the `data_sync_control` capability — `off` gated. */
function gatedEntitlements(): CanopyCloudEntitlementsState {
  return {
    resolved: true,
    canDisableSharing: false,
    source: 'none',
    plan: null,
    trial: null,
    billingManageableOrg: null,
  };
}

/** Resolved probe with the `data_sync_control` capability — `off` unlocked. */
function entitledEntitlements(): CanopyCloudEntitlementsState {
  return {
    resolved: true,
    canDisableSharing: true,
    source: 'subscription',
    plan: { key: 'individual', displayName: 'Pro' },
    trial: null,
    billingManageableOrg: null,
  };
}
