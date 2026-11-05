import type {
  PreferencesLoadErrorDetails,
  PreferencesData,
} from '../../../types';
import { DEFAULT_PREFERENCES } from '../defaults';
import { createPreferenceFormatMigrations } from '../preference-format-migrations';

function fixture(): {
  migrations: ReturnType<typeof createPreferenceFormatMigrations>;
  ledger: {
    hasRun: jest.Mock<Promise<boolean>, [string]>;
    markRun: jest.Mock<Promise<void>, [string]>;
  };
  store: {
    read: jest.Mock<Promise<PreferencesData>, []>;
    update: jest.Mock<Promise<PreferencesData>, []>;
    peekLoadError: jest.Mock<PreferencesLoadErrorDetails | null, []>;
  };
} {
  const ledger = {
    hasRun: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(false),
    markRun: jest.fn<Promise<void>, [string]>().mockResolvedValue(undefined),
  };
  const store = {
    read: jest.fn(
      (): Promise<PreferencesData> => Promise.resolve(DEFAULT_PREFERENCES),
    ),
    update: jest.fn(
      (): Promise<PreferencesData> => Promise.resolve(DEFAULT_PREFERENCES),
    ),
    peekLoadError: jest.fn((): PreferencesLoadErrorDetails | null => null),
    hasPersistedState: (): Promise<boolean> => Promise.resolve(true),
    readStoredPayload: (): Promise<{ kind: 'missing' }> =>
      Promise.resolve({ kind: 'missing' }),
  };
  return {
    migrations: createPreferenceFormatMigrations({ ledger, store }),
    ledger,
    store,
  };
}

it('a degraded read never marks or writes the sidebar migration', async () => {
  const { migrations, ledger, store } = fixture();
  store.peekLoadError.mockReturnValue({
    timestamp: '2026-11-04T00:00:00.000Z',
    reason: 'parse',
    message: 'Invalid preferences',
    filePath: 'memory',
  });
  await migrations.migrateSidebarRemoteControlVisible();
  expect(store.update).not.toHaveBeenCalled();
  expect(ledger.markRun).not.toHaveBeenCalled();
});

it('an unavailable ledger skips the migration without reading', async () => {
  const { migrations, ledger, store } = fixture();
  const unavailable = new Error('Ledger unavailable');
  ledger.hasRun.mockRejectedValue(unavailable);
  await expect(migrations.migrateSidebarRemoteControlVisible()).rejects.toBe(
    unavailable,
  );
  expect(store.read).not.toHaveBeenCalled();
  expect(store.update).not.toHaveBeenCalled();
  expect(ledger.markRun).not.toHaveBeenCalled();
});
