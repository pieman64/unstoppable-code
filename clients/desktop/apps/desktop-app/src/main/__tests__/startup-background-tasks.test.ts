import { SKILLS_CHANNELS } from '@canopy/desktop-shared/constants/skill-channels';
import { PLUGINS_CHANNELS } from '@canopy/desktop-shared/constants/plugin-channels';
import type { SkillUpdateProgress } from '@canopy/desktop-shared/types/skills';
import type { MarketplaceOperationProgress } from '@canopy/desktop-shared/types/plugins';
import type { BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';

const mockCheckUpdates = jest.fn();
const mockRefreshMarketplaces = jest.fn();
const mockRefreshInvocableInventoryAfterMutation = jest.fn();
const mockSendToWindowDetailed = jest.fn();
const mockRecordAppDiagnostic = jest.fn();
const mockIsE2eBuild = jest.fn<boolean, []>();
const mockEnqueueStartupLocalMemoryImportBatch = jest.fn();
const mockFlushTurnFeedbackOutbox = jest.fn();
const mockFlushSharedItemSubscriptions = jest.fn();
const mockSweepCodexMarketplaceStaging = jest.fn();
const mockPrefetchBlueprints = jest.fn();
const mockReconcileLedgerScopesAtStartup = jest.fn();
const mockReconcileSummaryPublications = jest.fn();
const mockReconcileManagedMarketplaceReceiptsAtStartup = jest.fn();

jest.mock('../lib/e2e-gate', () => ({
  isE2eBuild: (): boolean => mockIsE2eBuild(),
}));

jest.mock('../skills/skill-service', () => ({
  get checkUpdates(): typeof mockCheckUpdates {
    return mockCheckUpdates;
  },
}));

jest.mock('../plugins/plugin-service', () => ({
  get refreshMarketplaces(): typeof mockRefreshMarketplaces {
    return mockRefreshMarketplaces;
  },
  get reconcileManagedMarketplaceReceiptsAtStartup(): typeof mockReconcileManagedMarketplaceReceiptsAtStartup {
    return mockReconcileManagedMarketplaceReceiptsAtStartup;
  },
}));

jest.mock('../plugins/invocable-inventory-service', () => ({
  get refreshInvocableInventoryAfterMutation(): typeof mockRefreshInvocableInventoryAfterMutation {
    return mockRefreshInvocableInventoryAfterMutation;
  },
}));

jest.mock('../lib/window-send', () => ({
  get sendToWindowDetailed(): typeof mockSendToWindowDetailed {
    return mockSendToWindowDetailed;
  },
}));

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));

jest.mock('../feedback/turn-feedback-client', () => ({
  get flushTurnFeedbackOutbox(): typeof mockFlushTurnFeedbackOutbox {
    return mockFlushTurnFeedbackOutbox;
  },
}));

jest.mock('../canopy-cloud/shared-item-subscriptions', () => ({
  get flushSharedItemSubscriptions(): typeof mockFlushSharedItemSubscriptions {
    return mockFlushSharedItemSubscriptions;
  },
}));

jest.mock('../memory/local/import/import-job', () => ({
  get enqueueStartupLocalMemoryImportBatch(): typeof mockEnqueueStartupLocalMemoryImportBatch {
    return mockEnqueueStartupLocalMemoryImportBatch;
  },
}));

jest.mock('../plugins/codex-staging-janitor', () => ({
  get sweepCodexMarketplaceStaging(): typeof mockSweepCodexMarketplaceStaging {
    return mockSweepCodexMarketplaceStaging;
  },
}));

jest.mock('../blueprints/blueprint-catalog', () => ({
  get prefetchBlueprints(): typeof mockPrefetchBlueprints {
    return mockPrefetchBlueprints;
  },
}));

jest.mock('../ledger/lifecycle', () => ({
  get reconcileLedgerScopesAtStartup(): typeof mockReconcileLedgerScopesAtStartup {
    return mockReconcileLedgerScopesAtStartup;
  },
}));

jest.mock('../ledger/summary-reconciliation', () => ({
  get reconcileSummaryPublications(): typeof mockReconcileSummaryPublications {
    return mockReconcileSummaryPublications;
  },
}));

import { scheduleDeferredStartupBackgroundTasks } from '../startup-background-tasks';

function createBrowserWindow(webContents: EventEmitter): BrowserWindow {
  const win = jest.createMockFromModule<BrowserWindow>('electron');
  Object.assign(win, {
    id: 1,
    isDestroyed: (): boolean => false,
    webContents,
  });
  return win;
}

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  return (): void => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}

describe('startup background tasks', () => {
  let restoreDefaultPlatform: (() => void) | null = null;
  const liveE2eStartupBackgroundEnv =
    'CANOPY_PERFORMANCE_LIVE_STARTUP_BACKGROUND';

  beforeEach(() => {
    jest.useFakeTimers();
    restoreDefaultPlatform = setPlatform('darwin');
    jest.clearAllMocks();
    mockIsE2eBuild.mockReturnValue(false);
    mockCheckUpdates.mockResolvedValue({ success: true, data: {} });
    mockRefreshMarketplaces.mockResolvedValue({
      success: true,
      data: { version: 2, lastRefreshed: '', marketplaces: [] },
    });
    mockEnqueueStartupLocalMemoryImportBatch.mockResolvedValue(undefined);
    mockFlushTurnFeedbackOutbox.mockResolvedValue(undefined);
    mockFlushSharedItemSubscriptions.mockResolvedValue(undefined);
    mockSweepCodexMarketplaceStaging.mockResolvedValue({ removed: 0 });
    mockPrefetchBlueprints.mockResolvedValue(true);
    mockReconcileLedgerScopesAtStartup.mockResolvedValue('settled');
    mockReconcileManagedMarketplaceReceiptsAtStartup.mockReturnValue({
      status: 'unchanged',
    });
    mockReconcileSummaryPublications.mockResolvedValue({
      scopes: 0,
      published: 0,
      pending: 0,
    });
    delete process.env[liveE2eStartupBackgroundEnv];
  });

  afterEach(() => {
    restoreDefaultPlatform?.();
    restoreDefaultPlatform = null;
    delete process.env[liveE2eStartupBackgroundEnv];
    jest.useRealTimers();
  });

  it('broadcasts skill and marketplace progress while the deferred startup tasks run', async () => {
    const win = createBrowserWindow(new EventEmitter());
    const skillProgress: SkillUpdateProgress = {
      operation: 'check-updates',
      status: 'running',
      message: 'Checking installed skills for updates...',
    };
    const marketplaceProgress: MarketplaceOperationProgress = {
      operation: 'refresh',
      status: 'running',
      message: 'Checking installed marketplaces…',
    };
    mockCheckUpdates.mockImplementation(
      (reporter: (progress: SkillUpdateProgress) => void) => {
        reporter(skillProgress);
        return { success: true, data: {} };
      },
    );
    mockRefreshMarketplaces.mockImplementation(
      (reporter: (progress: MarketplaceOperationProgress) => void) => {
        reporter(marketplaceProgress);
        return {
          success: true,
          data: { version: 2, lastRefreshed: '', marketplaces: [] },
        };
      },
    );

    scheduleDeferredStartupBackgroundTasks(() => win);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockSendToWindowDetailed).toHaveBeenCalledWith(
      win,
      SKILLS_CHANNELS.UPDATE_PROGRESS,
      skillProgress,
    );
    expect(mockSendToWindowDetailed).toHaveBeenCalledWith(
      win,
      PLUGINS_CHANNELS.OPERATION_PROGRESS,
      marketplaceProgress,
    );
    expect(mockRefreshInvocableInventoryAfterMutation).toHaveBeenCalledWith(
      'startup:plugin_marketplace_refresh',
    );
    expect(mockEnqueueStartupLocalMemoryImportBatch).toHaveBeenCalledTimes(1);
    expect(mockFlushTurnFeedbackOutbox).toHaveBeenCalledTimes(1);
    expect(mockFlushSharedItemSubscriptions).toHaveBeenCalledTimes(1);
    expect(mockSweepCodexMarketplaceStaging).toHaveBeenCalledTimes(1);
  });

  it('repeats the Codex staging sweep on the retention cadence', async () => {
    const cancel = scheduleDeferredStartupBackgroundTasks(() => null);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    expect(mockSweepCodexMarketplaceStaging).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(12 * 60 * 60 * 1000);
    await Promise.resolve();

    expect(mockSweepCodexMarketplaceStaging).toHaveBeenCalledTimes(2);
    cancel();
    jest.advanceTimersByTime(12 * 60 * 60 * 1000);
    expect(mockSweepCodexMarketplaceStaging).toHaveBeenCalledTimes(2);
  });

  it('does not refresh invocable inventory when startup marketplace refresh fails', async () => {
    mockRefreshMarketplaces.mockResolvedValue({
      success: false,
      error: 'refresh failed',
    });

    scheduleDeferredStartupBackgroundTasks(() => null);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRefreshInvocableInventoryAfterMutation).not.toHaveBeenCalled();
  });

  it('reports an unavailable project-template catalog with public copy', async () => {
    mockPrefetchBlueprints.mockResolvedValue(false);

    scheduleDeferredStartupBackgroundTasks(() => null);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'startup_background_task_failed',
        reason:
          'blueprint_catalog_refresh: Project template catalog unavailable',
      }),
    );
  });

  it('postpones startup work until keyboard and mouse interaction is idle', async () => {
    const webContents = new EventEmitter();
    const win = createBrowserWindow(webContents);

    const cancel = scheduleDeferredStartupBackgroundTasks(() => win);
    jest.advanceTimersByTime(4000);
    webContents.emit('before-input-event');
    jest.advanceTimersByTime(4000);
    webContents.emit('before-mouse-event');
    jest.advanceTimersByTime(4999);

    expect(mockCheckUpdates).not.toHaveBeenCalled();
    expect(mockRefreshMarketplaces).not.toHaveBeenCalled();
    expect(mockEnqueueStartupLocalMemoryImportBatch).not.toHaveBeenCalled();
    expect(mockSweepCodexMarketplaceStaging).not.toHaveBeenCalled();
    expect(mockReconcileLedgerScopesAtStartup).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCheckUpdates).toHaveBeenCalledTimes(1);
    expect(mockRefreshMarketplaces).toHaveBeenCalledTimes(1);
    expect(mockReconcileLedgerScopesAtStartup).toHaveBeenCalledTimes(1);
    expect(webContents.listenerCount('before-input-event')).toBe(0);
    expect(webContents.listenerCount('before-mouse-event')).toBe(0);
    cancel();
  });

  it('cancels the idle gate and removes interaction listeners on quit', () => {
    const webContents = new EventEmitter();
    const win = createBrowserWindow(webContents);

    const cancel = scheduleDeferredStartupBackgroundTasks(() => win);
    cancel();
    jest.advanceTimersByTime(60_000);

    expect(mockCheckUpdates).not.toHaveBeenCalled();
    expect(mockRefreshMarketplaces).not.toHaveBeenCalled();
    expect(mockReconcileLedgerScopesAtStartup).not.toHaveBeenCalled();
    expect(webContents.listenerCount('before-input-event')).toBe(0);
    expect(webContents.listenerCount('before-mouse-event')).toBe(0);
  });

  it('runs at the maximum delay even when interaction never becomes idle', async () => {
    const webContents = new EventEmitter();
    const win = createBrowserWindow(webContents);

    const cancel = scheduleDeferredStartupBackgroundTasks(() => win);
    for (let elapsed = 1000; elapsed < 60_000; elapsed += 1000) {
      jest.advanceTimersByTime(1000);
      webContents.emit('before-input-event');
    }

    expect(mockCheckUpdates).not.toHaveBeenCalled();
    expect(mockRefreshMarketplaces).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCheckUpdates).toHaveBeenCalledTimes(1);
    expect(mockRefreshMarketplaces).toHaveBeenCalledTimes(1);
    expect(webContents.listenerCount('before-input-event')).toBe(0);
    expect(webContents.listenerCount('before-mouse-event')).toBe(0);
    cancel();
  });

  it('does not schedule or run any startup tasks under the E2E build', () => {
    mockIsE2eBuild.mockReturnValue(true);
    const win = createBrowserWindow(new EventEmitter());

    const cancel = scheduleDeferredStartupBackgroundTasks(() => win);
    jest.advanceTimersByTime(5000);

    expect(mockCheckUpdates).not.toHaveBeenCalled();
    expect(mockRefreshMarketplaces).not.toHaveBeenCalled();
    expect(mockEnqueueStartupLocalMemoryImportBatch).not.toHaveBeenCalled();
    expect(mockReconcileLedgerScopesAtStartup).not.toHaveBeenCalled();
    // The returned cancel must be a safe no-op.
    expect(() => cancel()).not.toThrow();
  });

  it('allows the performance suite to opt into real E2E startup tasks', async () => {
    mockIsE2eBuild.mockReturnValue(true);
    process.env[liveE2eStartupBackgroundEnv] = '1';

    scheduleDeferredStartupBackgroundTasks(() => null);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockCheckUpdates).toHaveBeenCalledTimes(1);
    expect(mockRefreshMarketplaces).toHaveBeenCalledTimes(1);
  });

  it('still schedules the automatic memory import on Windows', async () => {
    const restorePlatform = setPlatform('win32');
    const win = createBrowserWindow(new EventEmitter());

    try {
      const cancel = scheduleDeferredStartupBackgroundTasks(() => win);
      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      expect(mockCheckUpdates).not.toHaveBeenCalled();
      expect(mockRefreshMarketplaces).not.toHaveBeenCalled();
      expect(mockEnqueueStartupLocalMemoryImportBatch).toHaveBeenCalledTimes(1);
      expect(mockSweepCodexMarketplaceStaging).toHaveBeenCalledTimes(1);
      // Ledger reconciliation is local work and launches no provider CLI.
      expect(mockReconcileLedgerScopesAtStartup).toHaveBeenCalledTimes(1);
      // So is the marketplace receipt pass, which reads Claude's file only.
      expect(
        mockReconcileManagedMarketplaceReceiptsAtStartup,
      ).toHaveBeenCalledTimes(1);
      expect(() => cancel()).not.toThrow();
    } finally {
      restorePlatform();
    }
  });

  it.each([
    [
      'rejects',
      (): Promise<void> =>
        Promise.reject(new Error('Ledger storage unavailable')),
    ],
    [
      'throws',
      (): Promise<void> => {
        throw new Error('Ledger storage unavailable');
      },
    ],
  ])(
    'records a startup diagnostic when Ledger reconciliation %s',
    async (_outcome, reconcile) => {
      mockReconcileLedgerScopesAtStartup.mockImplementation(reconcile);

      scheduleDeferredStartupBackgroundTasks(() => null);
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockReconcileLedgerScopesAtStartup).toHaveBeenCalledTimes(1);
      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'startup_background_task_failed',
          reason: 'ledger_scope_reconciliation: Ledger storage unavailable',
        }),
      );
      // Unsettled scopes could still be rebound, so nothing publishes.
      expect(mockReconcileSummaryPublications).not.toHaveBeenCalled();
      // The other deferred tasks still run.
      expect(mockSweepCodexMarketplaceStaging).toHaveBeenCalledTimes(1);
      expect(mockCheckUpdates).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'reports a failed write',
      (): unknown => ({ status: 'failed', error: 'disk full' }),
      'disk full',
    ],
    [
      'throws',
      (): unknown => {
        throw new Error('receipts unavailable');
      },
      'receipts unavailable',
    ],
  ])(
    'records a startup diagnostic when the marketplace receipt pass %s',
    async (_outcome, reconcile, reason) => {
      mockReconcileManagedMarketplaceReceiptsAtStartup.mockImplementation(
        reconcile,
      );

      scheduleDeferredStartupBackgroundTasks(() => null);
      jest.advanceTimersByTime(5000);
      await Promise.resolve();

      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'startup_background_task_failed',
          reason: `plugin_marketplace_receipts: ${reason}`,
        }),
      );
      // The provider refresh still runs.
      expect(mockRefreshMarketplaces).toHaveBeenCalledTimes(1);
    },
  );

  it('reconciles Summary publications once Ledger scopes are settled', async () => {
    let settleScopes: () => void = (): void => undefined;
    mockReconcileLedgerScopesAtStartup.mockReturnValue(
      new Promise<string>((resolve) => {
        settleScopes = (): void => resolve('settled');
      }),
    );

    scheduleDeferredStartupBackgroundTasks(() => null);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();

    expect(mockReconcileLedgerScopesAtStartup).toHaveBeenCalledTimes(1);
    expect(mockReconcileSummaryPublications).not.toHaveBeenCalled();
    settleScopes();
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(mockReconcileSummaryPublications).toHaveBeenCalledTimes(1);
  });

  it('leaves Summary publications pending when the Ledger pass left scopes unsettled', async () => {
    mockReconcileLedgerScopesAtStartup.mockResolvedValue('incomplete');

    scheduleDeferredStartupBackgroundTasks(() => null);
    jest.advanceTimersByTime(5000);
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();

    expect(mockReconcileLedgerScopesAtStartup).toHaveBeenCalledTimes(1);
    expect(mockReconcileSummaryPublications).not.toHaveBeenCalled();
    // The pass reports its own failures; skipping is not one.
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'startup_background_task_failed' }),
    );
  });

  it('records a startup diagnostic when Summary reconciliation fails', async () => {
    mockReconcileSummaryPublications.mockRejectedValue(
      new Error('Summary files unreadable'),
    );

    scheduleDeferredStartupBackgroundTasks(() => null);
    jest.advanceTimersByTime(5000);
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();

    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'startup_background_task_failed',
        reason: 'ledger_summary_reconciliation: Summary files unreadable',
      }),
    );
  });
});
