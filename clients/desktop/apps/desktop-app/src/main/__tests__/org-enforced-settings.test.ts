import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import type { OrgTelemetryEnforcement } from '@canopy/desktop-shared/lib/telemetry-enforcement';
import type { TelemetryEnforcedScopeMap } from '@canopy/protocol/canopy-server';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ALL_OFF: TelemetryEnforcedScopeMap = {
  transcripts: false,
  plans: false,
  metadata: false,
  summaries: false,
};

const mockUpdatePreferencesFile = jest.fn();
const mockSetTelemetryEnforcementByOrganization = jest.fn<
  boolean,
  [ReadonlyMap<string, OrgTelemetryEnforcement>]
>();
const mockMigrateOrgPinnedTelemetrySharing = jest.fn<
  Promise<boolean>,
  [CanopyCloudAccountPublicState | null]
>();
const mockSendToWindow = jest.fn<boolean, unknown[]>();
const mockGetAllWindows = jest.fn<unknown[], []>();
const mockSetCurrentModelGatewayAccount = jest.fn(() => ({
  changed: false,
  changedOrganizationIds: [] as string[],
}));
const mockBroadcastModelRegistryUpdated = jest.fn<void, []>();
const mockInvalidateSessionsForOrganizations = jest.fn<
  Promise<void>,
  unknown[]
>();

jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): unknown[] => mockGetAllWindows() },
}));

jest.mock('../lib/preferences-store', () => ({
  updatePreferencesFile: (...args: unknown[]): unknown =>
    mockUpdatePreferencesFile(...args),
}));

jest.mock('../lib/telemetry-pin-migration', () => ({
  migrateOrgPinnedTelemetrySharing: (
    account: CanopyCloudAccountPublicState | null,
  ): Promise<boolean> => mockMigrateOrgPinnedTelemetrySharing(account),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: (...args: unknown[]): boolean => mockSendToWindow(...args),
}));

jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: (): {
    setTelemetryEnforcementByOrganization: (
      byOrg: ReadonlyMap<string, OrgTelemetryEnforcement>,
    ) => boolean;
  } => ({
    setTelemetryEnforcementByOrganization: (
      byOrg: ReadonlyMap<string, OrgTelemetryEnforcement>,
    ): boolean => mockSetTelemetryEnforcementByOrganization(byOrg),
  }),
}));

jest.mock('../lib/model-gateway-state', () => ({
  setCurrentModelGatewayAccount: (account: unknown): unknown =>
    mockSetCurrentModelGatewayAccount(account),
}));

jest.mock('../models/model-registry', () => ({
  broadcastModelRegistryUpdated: (): void =>
    mockBroadcastModelRegistryUpdated(),
}));

jest.mock('../agents/session-manager', () => ({
  invalidateSessionsForOrganizations: (...args: unknown[]): Promise<void> =>
    mockInvalidateSessionsForOrganizations(...args),
}));

import { applyEnforcedSettings } from '../services/org-enforced-settings';

function accountEnforcing(
  organizationId: string,
  organizationName: string,
  scopes: Partial<TelemetryEnforcedScopeMap>,
  prohibitedScopes?: Partial<TelemetryEnforcedScopeMap>,
): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: [],
    organizations: [],
    teams: [],
    storageAvailable: true,
    enforcedSettings: [
      {
        organizationId,
        organizationName,
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: { ...ALL_OFF, ...scopes },
            ...(prohibitedScopes
              ? { prohibitedScopes: { ...ALL_OFF, ...prohibitedScopes } }
              : {}),
          },
        ],
      },
    ],
  };
}

function accountWithModelPolicy(): CanopyCloudAccountPublicState {
  return {
    ...accountEnforcing(ORG_A, 'Acme', {}),
    enforcedSettings: [
      {
        organizationId: ORG_A,
        organizationName: 'Acme',
        policies: [
          {
            kind: 'model-policy',
            blockedModelIds: [],
            reviewedModelIds: ['anthropic/claude-sonnet-5'],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllWindows.mockReturnValue([]);
  mockSetTelemetryEnforcementByOrganization.mockReturnValue(false);
  mockMigrateOrgPinnedTelemetrySharing.mockResolvedValue(false);
  mockInvalidateSessionsForOrganizations.mockResolvedValue();
});

describe('applyEnforcedSettings telemetry policy', () => {
  it('pushes separate per-org policies and never pins preferences', async () => {
    const a = accountEnforcing(ORG_A, 'Acme', { transcripts: true });
    const b = accountEnforcing(ORG_B, 'Globex', {}, { metadata: true });
    const account = {
      ...a,
      enforcedSettings: [
        ...(a.enforcedSettings ?? []),
        ...(b.enforcedSettings ?? []),
      ],
    };

    await applyEnforcedSettings(account);

    const byOrg = mockSetTelemetryEnforcementByOrganization.mock.calls[0][0];
    expect(byOrg.get(ORG_A)?.enforcement.required.transcripts).toBe(true);
    expect(byOrg.get(ORG_A)?.enforcement.prohibited.metadata).toBe(false);
    expect(byOrg.get(ORG_B)?.enforcement.required.transcripts).toBe(false);
    expect(byOrg.get(ORG_B)?.enforcement.prohibited.metadata).toBe(true);
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
    expect(mockMigrateOrgPinnedTelemetrySharing).toHaveBeenCalledWith(account);
  });

  it('reports and broadcasts a map change', async () => {
    const window = { id: 1 };
    mockGetAllWindows.mockReturnValue([window]);
    mockSetTelemetryEnforcementByOrganization.mockReturnValue(true);

    await expect(
      applyEnforcedSettings(accountEnforcing(ORG_A, 'Acme', {})),
    ).resolves.toBe(true);
    expect(mockSendToWindow).toHaveBeenCalledWith(
      window,
      'preferences:changed',
    );
  });

  it('reports a one-time pin migration as a preferences change', async () => {
    mockMigrateOrgPinnedTelemetrySharing.mockResolvedValue(true);
    await expect(
      applyEnforcedSettings(accountEnforcing(ORG_A, 'Acme', {})),
    ).resolves.toBe(true);
  });

  it('installs and broadcasts runtime enforcement when pin migration fails', async () => {
    const window = { id: 1 };
    mockGetAllWindows.mockReturnValue([window]);
    mockSetTelemetryEnforcementByOrganization.mockReturnValue(true);
    mockMigrateOrgPinnedTelemetrySharing.mockRejectedValue(new Error('EACCES'));

    await expect(
      applyEnforcedSettings(accountEnforcing(ORG_A, 'Acme', {})),
    ).resolves.toBe(true);

    expect(mockSetTelemetryEnforcementByOrganization).toHaveBeenCalledTimes(1);
    expect(mockSendToWindow).toHaveBeenCalledWith(
      window,
      'preferences:changed',
    );
  });
});

describe('applyEnforcedSettings model policy', () => {
  it('broadcasts when the model policy changes', async () => {
    const window = { id: 1 };
    mockGetAllWindows.mockReturnValue([window]);
    const account = accountWithModelPolicy();

    const first = await applyEnforcedSettings(account);
    const unchanged = await applyEnforcedSettings(account);
    const cleared = await applyEnforcedSettings(null);

    expect(first).toBe(true);
    expect(unchanged).toBe(false);
    expect(cleared).toBe(true);
    expect(mockSendToWindow).toHaveBeenCalledTimes(2);
  });

  it('refreshes the model registry and invalidates only changed organizations', async () => {
    mockSetCurrentModelGatewayAccount.mockReturnValueOnce({
      changed: true,
      changedOrganizationIds: [ORG_A],
    });
    await applyEnforcedSettings(accountWithModelPolicy());

    expect(mockBroadcastModelRegistryUpdated).toHaveBeenCalledTimes(1);
    expect(mockInvalidateSessionsForOrganizations.mock.calls).toEqual([
      [
        [ORG_A],
        'model-gateway-policy-changed',
        { activeTurnPolicy: 'preserve' },
      ],
    ]);
  });
});
