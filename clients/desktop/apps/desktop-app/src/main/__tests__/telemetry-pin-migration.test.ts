import type {
  CanopyCloudAccountPublicState,
  TelemetrySharingPreferences,
} from '@canopy/desktop-shared/types';

const mockHasMigrationRun = jest.fn<Promise<boolean>, [string]>();
const mockMarkMigrationRun = jest.fn<Promise<void>, [string]>();
const mockReadPreferencesFile = jest.fn<
  Promise<{ telemetrySharing: TelemetrySharingPreferences }>,
  []
>();
const mockPeekPreferencesLoadError = jest.fn<unknown, []>();
const mockUpdatePreferencesFile = jest.fn<
  Promise<unknown>,
  [(existing: { telemetrySharing: TelemetrySharingPreferences }) => unknown]
>();
const mockRefreshScopeFromPreferences = jest.fn<Promise<void>, []>();
const mockLogMainProcessInfo = jest.fn<void, [string, unknown?]>();

jest.mock('../lib/migrations', () => ({
  hasMigrationRun: (key: string): Promise<boolean> => mockHasMigrationRun(key),
  markMigrationRun: (key: string): Promise<void> => mockMarkMigrationRun(key),
}));

jest.mock('../lib/preferences-store', () => ({
  DEFAULT_PREFERENCES: {
    telemetrySharing: {
      transcripts: 'off',
      plans: 'off',
      metadata: 'off',
      summaries: 'off',
    },
  },
  readPreferencesFile: (): Promise<{
    telemetrySharing: TelemetrySharingPreferences;
  }> => mockReadPreferencesFile(),
  peekPreferencesLoadError: (): unknown => mockPeekPreferencesLoadError(),
  updatePreferencesFile: (
    updater: (existing: {
      telemetrySharing: TelemetrySharingPreferences;
    }) => unknown,
  ): Promise<unknown> => mockUpdatePreferencesFile(updater),
}));

jest.mock('../services/telemetry-sync-service', () => ({
  getTelemetrySyncService: (): {
    refreshScopeFromPreferences: () => Promise<void>;
  } => ({
    refreshScopeFromPreferences: (): Promise<void> =>
      mockRefreshScopeFromPreferences(),
  }),
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: (message: string, context?: unknown): void =>
    mockLogMainProcessInfo(message, context),
}));

import {
  TELEMETRY_ORG_PINS_RESET_MIGRATION_KEY,
  migrateOrgPinnedTelemetrySharing,
} from '../lib/telemetry-pin-migration';

const ALL_OFF = {
  transcripts: false,
  plans: false,
  metadata: false,
  summaries: false,
};

function account(): CanopyCloudAccountPublicState {
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
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: { ...ALL_OFF, transcripts: true, metadata: true },
            prohibitedScopes: { ...ALL_OFF, plans: true },
          },
        ],
      },
    ],
  };
}

const stored = {
  transcripts: 'organization',
  plans: 'off',
  metadata: 'private',
  summaries: 'organization',
} satisfies TelemetrySharingPreferences;

beforeEach(() => {
  jest.clearAllMocks();
  mockHasMigrationRun.mockResolvedValue(false);
  mockMarkMigrationRun.mockResolvedValue();
  mockPeekPreferencesLoadError.mockReturnValue(null);
  mockReadPreferencesFile.mockResolvedValue({ telemetrySharing: stored });
  mockUpdatePreferencesFile.mockImplementation((updater) =>
    Promise.resolve(updater({ telemetrySharing: stored })),
  );
  mockRefreshScopeFromPreferences.mockResolvedValue();
});

describe('migrateOrgPinnedTelemetrySharing', () => {
  it('resets only values matching the legacy union, marks once, and refreshes', async () => {
    await expect(migrateOrgPinnedTelemetrySharing(account())).resolves.toBe(
      true,
    );

    const updater = mockUpdatePreferencesFile.mock.calls[0][0];
    expect(updater({ telemetrySharing: stored })).toEqual({
      telemetrySharing: {
        ...stored,
        transcripts: 'off',
      },
    });
    expect(mockMarkMigrationRun).toHaveBeenCalledWith(
      TELEMETRY_ORG_PINS_RESET_MIGRATION_KEY,
    );
    expect(mockRefreshScopeFromPreferences).toHaveBeenCalledTimes(1);
    expect(mockLogMainProcessInfo).toHaveBeenCalledWith(
      '[telemetry] reset legacy org-pinned sharing preferences',
      { count: 1, scopes: ['transcripts'] },
    );
  });

  it('preserves a concurrent preference edit made after the initial read', async () => {
    const concurrent = {
      telemetrySharing: { ...stored, transcripts: 'private' as const },
    };
    let committedPatch: unknown;
    mockUpdatePreferencesFile.mockImplementation((updater) => {
      committedPatch = updater(concurrent);
      return Promise.resolve(committedPatch);
    });

    await expect(migrateOrgPinnedTelemetrySharing(account())).resolves.toBe(
      false,
    );

    expect(committedPatch).toEqual({});
    expect(mockMarkMigrationRun).toHaveBeenCalledWith(
      TELEMETRY_ORG_PINS_RESET_MIGRATION_KEY,
    );
    expect(mockRefreshScopeFromPreferences).toHaveBeenCalledTimes(1);
    expect(mockLogMainProcessInfo).not.toHaveBeenCalled();
  });

  it('refreshes persisted sharing before a marker failure can strand stale runtime state', async () => {
    let current = { telemetrySharing: stored };
    mockUpdatePreferencesFile.mockImplementation((updater) => {
      const patch = updater(current) as Partial<typeof current>;
      current = { ...current, ...patch };
      return Promise.resolve(current);
    });
    mockMarkMigrationRun
      .mockRejectedValueOnce(new Error('EACCES'))
      .mockResolvedValueOnce();

    await expect(migrateOrgPinnedTelemetrySharing(account())).rejects.toThrow(
      'EACCES',
    );
    expect(mockRefreshScopeFromPreferences).toHaveBeenCalledTimes(1);

    await expect(migrateOrgPinnedTelemetrySharing(account())).resolves.toBe(
      false,
    );
    expect(mockRefreshScopeFromPreferences).toHaveBeenCalledTimes(2);
    expect(mockMarkMigrationRun).toHaveBeenCalledTimes(2);
  });

  it('does not run or write after the marker exists', async () => {
    mockHasMigrationRun.mockResolvedValue(true);
    await expect(migrateOrgPinnedTelemetrySharing(account())).resolves.toBe(
      false,
    );
    expect(mockReadPreferencesFile).not.toHaveBeenCalled();
  });

  it('does not mark while signed out or after a degraded read', async () => {
    await expect(migrateOrgPinnedTelemetrySharing(null)).resolves.toBe(false);
    expect(mockMarkMigrationRun).not.toHaveBeenCalled();

    mockPeekPreferencesLoadError.mockReturnValue({ reason: 'corrupt' });
    await expect(migrateOrgPinnedTelemetrySharing(account())).resolves.toBe(
      false,
    );
    expect(mockMarkMigrationRun).not.toHaveBeenCalled();
    expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
  });

  it.each(['error', 'unavailable'] as const)(
    'does not mark after a degraded %s account read',
    async (read) => {
      await expect(
        migrateOrgPinnedTelemetrySharing({ ...account(), read }),
      ).resolves.toBe(false);

      expect(mockReadPreferencesFile).not.toHaveBeenCalled();
      expect(mockUpdatePreferencesFile).not.toHaveBeenCalled();
      expect(mockMarkMigrationRun).not.toHaveBeenCalled();
    },
  );
});
