import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PreferencesFile } from '@canopy/desktop-shared/types';
import * as sharedTypes from '@canopy/desktop-shared/types';
import {
  DEFAULT_SIDEBAR_NAV_LAYOUT,
  LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT,
  reconcileSidebarNavLayout,
} from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import {
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
} from '@canopy/desktop-shared/types';

const mockGetCanopyDataDir = jest.fn<string, []>();

jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: (): string => mockGetCanopyDataDir(),
  getCanopySecureDataDir: (): string => `${mockGetCanopyDataDir()}/secure-data`,
  getPrimaryBrandDataDir: (): string => mockGetCanopyDataDir(),
  getResolvedCanopyDataDir: (): {
    path: string;
    source: 'primary';
    allCandidates: string[];
  } => ({
    path: mockGetCanopyDataDir(),
    source: 'primary',
    allCandidates: [mockGetCanopyDataDir()],
  }),
  getUserEnvironmentFilePath: (): string =>
    `${mockGetCanopyDataDir()}/environments.json`,
}));

import {
  APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY,
  CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY,
  CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY,
  LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY,
  SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY,
  SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY,
  SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY,
  captureChatSummaryModelSelectionMigrationSnapshot,
  captureLocalMemoryModelMigrationSnapshot,
  migrateApprovalDefaultsToFullAccess,
  migrateChatSummaryModelSelection,
  migrateClaudeWorkerModesToCanopy,
  migrateLocalMemoryDefaultOn,
  migrateLocalMemoryModelFromSummary,
  migrateSidebarManualSortDefault,
  migrateOpenAppLinksInBuiltInBrowserDefault,
  OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY,
  migrateSidebarMorePagesToMain,
  migrateSidebarRemoteControlVisible,
} from '../lib/preferences-migrations';
import {
  normalizePreferences,
  readPreferencesFile,
  readPreferencesFileForRenderer,
  invalidateRendererPreferencesCache,
  resetPreferencesLoadErrorForTests,
  updatePreferencesFile,
} from '../lib/preferences-store';

initClaudeModels([
  { id: 'opus[1m]', label: 'Opus 4.8 1M' },
  { id: 'sonnet', label: 'Sonnet 5' },
  { id: 'haiku', label: 'Haiku 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]);
initCodexModels([
  { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
  { id: 'gpt-5.5', label: 'GPT 5.5' },
]);
initOllamaModels([]);

async function writeFixture(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

function preferencesFile(
  preferences: Partial<PreferencesFile['preferences']>,
): string {
  return `${JSON.stringify({ version: 1, preferences }, null, 2)}\n`;
}

async function readPreferences(
  tempDir: string,
): Promise<PreferencesFile['preferences']> {
  const raw = await readFile(join(tempDir, 'preferences.json'), 'utf8');
  return (JSON.parse(raw) as PreferencesFile).preferences;
}

async function expectMissing(filePath: string): Promise<void> {
  await expect(access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('preference migrations', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'canopy-preferences-migration-'));
    mockGetCanopyDataDir.mockReturnValue(tempDir);
    resetPreferencesLoadErrorForTests();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    mockGetCanopyDataDir.mockReset();
  });

  describe('notification offer answer (CAN-4005)', () => {
    const earlier = '2026-09-01T12:00:00.000Z';
    const later = '2026-09-02T12:00:00.000Z';

    it.each([undefined, null, false, 42, '', '   ', 'invalid date', {}])(
      'rejects malformed answer %p',
      (value) => {
        expect(
          normalizePreferences({ osNotificationOfferAnsweredAt: value }),
        ).not.toHaveProperty('osNotificationOfferAnsweredAt');
      },
    );

    it('normalizes a valid answer and keeps normalization deterministic', () => {
      expect(
        normalizePreferences({
          osNotificationOfferAnsweredAt: '2026-09-01T14:00:00+02:00',
        }),
      ).toHaveProperty('osNotificationOfferAnsweredAt', earlier);
      const enabled = { osNotifications: { enabled: true } };
      expect(normalizePreferences(enabled)).not.toHaveProperty(
        'osNotificationOfferAnsweredAt',
      );
    });

    it.each([
      { completedAt: earlier },
      { dismissedAt: earlier },
      { completedAt: later, dismissedAt: earlier },
      { completedAt: earlier, dismissedAt: later },
      { completedAt: 'garbage', dismissedAt: earlier },
    ])('derives the earliest valid legacy answer from %p', (entry) => {
      const normalized = normalizePreferences({
        homeOnboardingSuggestions: {
          startedAt: earlier,
          entries: { notifications: entry },
        },
      });
      expect(normalized.osNotificationOfferAnsweredAt).toBe(earlier);
    });

    it('does not treat malformed legacy timestamps as answers', () => {
      expect(
        normalizePreferences({
          homeOnboardingSuggestions: {
            startedAt: earlier,
            entries: {
              notifications: { completedAt: 'garbage', dismissedAt: 42 },
            },
          },
        }),
      ).not.toHaveProperty('osNotificationOfferAnsweredAt');
    });

    it('keeps an explicit answer ahead of an earlier legacy answer', () => {
      expect(
        normalizePreferences({
          osNotificationOfferAnsweredAt: later,
          homeOnboardingSuggestions: {
            startedAt: earlier,
            entries: { notifications: { completedAt: earlier } },
          },
        }).osNotificationOfferAnsweredAt,
      ).toBe(later);
    });

    it('preserves retired notification history after the live id is removed', () => {
      const liveIds = sharedTypes.HOME_ONBOARDING_SUGGESTION_ENTRY_IDS.filter(
        (id) => id !== 'notifications',
      );
      const replacement = jest.replaceProperty(
        sharedTypes,
        'HOME_ONBOARDING_SUGGESTION_ENTRY_IDS',
        liveIds,
      );
      try {
        expect(
          normalizePreferences({
            homeOnboardingSuggestions: {
              startedAt: earlier,
              entries: { notifications: { dismissedAt: earlier } },
            },
          }).homeOnboardingSuggestions?.entries.notifications,
        ).toEqual({ dismissedAt: earlier });
      } finally {
        replacement.restore();
      }
    });

    it('derives without writing and persists on an unrelated ordinary save', async () => {
      const path = join(tempDir, 'preferences.json');
      await writeFixture(
        path,
        preferencesFile({
          colorMode: 'dark',
          homeOnboardingSuggestions: {
            startedAt: earlier,
            entries: { notifications: { dismissedAt: earlier } },
          },
        }),
      );
      expect((await readPreferencesFile()).osNotificationOfferAnsweredAt).toBe(
        earlier,
      );
      expect(await readPreferences(tempDir)).not.toHaveProperty(
        'osNotificationOfferAnsweredAt',
      );
      await updatePreferencesFile(() => ({ sidebarCollapsed: true }));
      expect(await readPreferences(tempDir)).toMatchObject({
        osNotificationOfferAnsweredAt: earlier,
        sidebarCollapsed: true,
        colorMode: 'dark',
      });
    });

    it('protects a legacy answer when reset erases its source before migration writes', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          homeOnboardingSuggestions: {
            startedAt: earlier,
            entries: { notifications: { dismissedAt: earlier } },
          },
        }),
      );
      await updatePreferencesFile(() => ({
        homeOnboardingSuggestions: { startedAt: earlier, entries: {} },
        osNotificationOfferAnsweredAt: undefined,
      }));
      invalidateRendererPreferencesCache();
      expect(
        (await readPreferencesFileForRenderer()).osNotificationOfferAnsweredAt,
      ).toBe(earlier);
      expect(
        (await readPreferences(tempDir)).homeOnboardingSuggestions?.entries,
      ).toEqual({});
    });

    it('migrates already-enabled profiles durably on renderer load', async () => {
      const osNotifications = {
        ...normalizePreferences({}).osNotifications,
        enabled: true,
      };
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({ osNotifications, colorMode: 'dark' }),
      );
      const [first, concurrent] = await Promise.all([
        readPreferencesFileForRenderer(),
        readPreferencesFileForRenderer({ view: 'persisted' }),
      ]);
      expect(first.osNotificationOfferAnsweredAt).toEqual(expect.any(String));
      expect(concurrent.osNotificationOfferAnsweredAt).toBe(
        first.osNotificationOfferAnsweredAt,
      );
      expect(await readPreferences(tempDir)).toMatchObject({
        osNotificationOfferAnsweredAt: first.osNotificationOfferAnsweredAt,
        colorMode: 'dark',
      });
      await updatePreferencesFile(() => ({
        osNotifications: { ...osNotifications, enabled: false },
      }));
      invalidateRendererPreferencesCache();
      expect(
        (await readPreferencesFileForRenderer()).osNotificationOfferAnsweredAt,
      ).toBe(first.osNotificationOfferAnsweredAt);
    });

    it.each([true, false])(
      'records an explicit master-toggle transition to %p',
      async (enabled) => {
        const osNotifications = {
          ...normalizePreferences({}).osNotifications,
          enabled: !enabled,
        };
        await writeFixture(
          join(tempDir, 'preferences.json'),
          preferencesFile({ osNotifications, sidebarCollapsed: true }),
        );
        const saved = await updatePreferencesFile(() => ({
          osNotifications: { ...osNotifications, enabled },
        }));
        expect(saved.osNotificationOfferAnsweredAt).toEqual(expect.any(String));
        expect(await readPreferences(tempDir)).toMatchObject({
          osNotificationOfferAnsweredAt: saved.osNotificationOfferAnsweredAt,
          sidebarCollapsed: true,
        });
      },
    );

    it('preserves the first committed answer across concurrent offer/settings patches and resets', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({ colorMode: 'dark' }),
      );
      const osNotifications = normalizePreferences({}).osNotifications;
      const [first, second] = await Promise.all([
        updatePreferencesFile(() => ({ osNotificationOfferAnsweredAt: later })),
        updatePreferencesFile(() => ({
          osNotificationOfferAnsweredAt: earlier,
          osNotifications: { ...osNotifications, enabled: true },
        })),
      ]);
      expect(first.osNotificationOfferAnsweredAt).toBe(later);
      expect(second.osNotificationOfferAnsweredAt).toBe(later);
      await updatePreferencesFile(() => ({
        osNotificationOfferAnsweredAt: undefined,
        homeOnboardingSuggestions: undefined,
      }));
      invalidateRendererPreferencesCache();
      expect(await readPreferencesFileForRenderer()).toMatchObject({
        osNotificationOfferAnsweredAt: later,
        colorMode: 'dark',
        osNotifications: { enabled: true },
      });
    });
  });

  it.each([
    {
      name: 'untouched default seed',
      preferences: { summaryModel: 'haiku' },
      expected: false,
    },
    {
      name: 'untouched Haiku 4.5 default seed',
      preferences: { summaryModel: 'claude-haiku-4-5-20251001' },
      expected: false,
    },
    {
      name: 'valid legacy non-default selection',
      preferences: { summaryModel: 'gpt-5.5' },
      expected: true,
    },
    {
      name: 'unavailable legacy selection',
      preferences: { summaryModel: 'ollama:missing-model' },
      expected: true,
    },
    {
      name: 'explicit unavailable selection',
      preferences: {
        summaryModel: 'ollama:missing-model',
        summaryModelSetByUser: true,
      },
      expected: true,
    },
    {
      name: 'malformed legacy selection',
      preferences: { summaryModel: 'invalid model id' },
      expected: false,
    },
    {
      name: 'explicit false marker',
      preferences: {
        summaryModel: 'gpt-5.5',
        summaryModelSetByUser: false,
      },
      expected: false,
    },
    {
      name: 'explicit Haiku marker',
      preferences: {
        summaryModel: 'claude-haiku-4-5-20251001',
        summaryModelSetByUser: true,
      },
      expected: true,
    },
  ])(
    'migrates the chat-summary marker for a $name',
    async ({ preferences, expected }) => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile(preferences),
      );

      await migrateChatSummaryModelSelection();

      expect((await readPreferences(tempDir)).summaryModelSetByUser).toBe(
        expected,
      );
      await expect(
        readFile(join(tempDir, 'migrations.json'), 'utf8'),
      ).resolves.toContain(
        `"${CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY}": true`,
      );
    },
  );

  it.each([
    {
      name: 'moves an untouched Haiku default to the new chat description default',
      preferences: { summaryModel: 'claude-haiku-4-5-20251001' },
      expected: { summaryModel: 'gpt-6-luna', summaryModelSetByUser: false },
    },
    {
      name: 'moves an explicitly unchosen model to the new default',
      preferences: { summaryModel: 'sonnet', summaryModelSetByUser: false },
      expected: { summaryModel: 'gpt-6-luna', summaryModelSetByUser: false },
    },
    {
      name: 'keeps a legacy model the user changed from Haiku',
      preferences: { summaryModel: 'gpt-5.5' },
      expected: { summaryModel: 'gpt-5.5', summaryModelSetByUser: true },
    },
    {
      name: 'keeps a chosen Haiku',
      preferences: {
        summaryModel: 'claude-haiku-4-5-20251001',
        summaryModelSetByUser: true,
      },
      expected: {
        summaryModel: 'claude-haiku-4-5-20251001',
        summaryModelSetByUser: true,
      },
    },
  ])('$name', async ({ preferences, expected }) => {
    await writeFixture(
      join(tempDir, 'preferences.json'),
      preferencesFile(preferences),
    );

    await migrateChatSummaryModelSelection();

    expect(await readPreferencesFile()).toMatchObject(expected);
  });

  it('marks a fresh profile without creating preferences', async () => {
    await migrateChatSummaryModelSelection();

    await expectMissing(join(tempDir, 'preferences.json'));
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY}": true`,
    );
  });

  it('preserves a captured legacy selection through earlier writes with a cold catalog', async () => {
    await writeFixture(
      join(tempDir, 'preferences.json'),
      preferencesFile({ summaryModel: 'gpt-5.5' }),
    );
    const snapshot = await captureChatSummaryModelSelectionMigrationSnapshot();

    initClaudeModels([]);
    initCodexModels([]);
    try {
      await updatePreferencesFile(() => ({
        approvalsUpgradeNoticeDismissed: true,
      }));
      expect((await readPreferences(tempDir)).summaryModel).toBe('gpt-5.5');

      initClaudeModels([
        { id: 'opus[1m]', label: 'Opus 4.8 1M' },
        { id: 'sonnet', label: 'Sonnet 5' },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      ]);
      initCodexModels([
        { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
        { id: 'gpt-5.5', label: 'GPT 5.5' },
      ]);
      await migrateChatSummaryModelSelection(snapshot);
    } finally {
      initClaudeModels([
        { id: 'opus[1m]', label: 'Opus 4.8 1M' },
        { id: 'sonnet', label: 'Sonnet 5' },
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      ]);
      initCodexModels([
        { id: 'gpt-6-luna', label: 'GPT 6 Luna' },
        { id: 'gpt-5.5', label: 'GPT 5.5' },
      ]);
    }

    expect(await readPreferences(tempDir)).toMatchObject({
      summaryModel: 'gpt-5.5',
      summaryModelSetByUser: true,
    });
  });

  it.each([
    {
      name: 'an Ultra fast default beside a stale legacy alias',
      preferences: {
        providerModelConfigDefaults: { codex: { speed: 'ultrafast' } },
        codexFastModeDefaultEnabled: true,
      },
      codex: { speed: 'ultrafast', fastMode: false },
      legacy: false,
    },
    {
      name: 'an explicit legacy false record over a true alias',
      preferences: {
        providerModelConfigDefaults: { codex: { fastMode: false } },
        codexFastModeDefaultEnabled: true,
      },
      codex: { fastMode: false },
      legacy: false,
    },
    {
      name: 'only the legacy alias',
      preferences: { codexFastModeDefaultEnabled: true },
      codex: { fastMode: true },
      legacy: true,
    },
  ])(
    'keeps the exact Codex speed default for $name across unrelated writes',
    async ({ preferences, codex, legacy }) => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        `${JSON.stringify({ version: 1, preferences }, null, 2)}\n`,
      );

      await updatePreferencesFile(() => ({
        approvalsUpgradeNoticeDismissed: true,
      }));

      const persisted = await readPreferences(tempDir);
      expect(persisted.providerModelConfigDefaults?.codex).toEqual(codex);
      expect(persisted.codexFastModeDefaultEnabled).toBe(legacy);
    },
  );

  it('migrates a legacy selection from the last-good preferences file', async () => {
    await writeFixture(
      join(tempDir, 'preferences.last-good.json'),
      preferencesFile({ summaryModel: 'gpt-5.5' }),
    );

    await migrateChatSummaryModelSelection();

    expect(await readPreferences(tempDir)).toMatchObject({
      summaryModel: 'gpt-5.5',
      summaryModelSetByUser: true,
    });
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${CHAT_SUMMARY_MODEL_SELECTION_MIGRATION_KEY}": true`,
    );
  });

  it('does not mark the chat-summary migration after a degraded read', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    await mkdir(preferencesPath, { recursive: true });

    await migrateChatSummaryModelSelection();

    await expectMissing(join(tempDir, 'migrations.json'));
  });

  it('lifts every persisted opt-in-era localMemoryEnabled false once', async () => {
    // Product decision (CAN-2657): ON for everyone at upgrade. An opt-in-era
    // false — materialized default or deliberate — is lifted; opting out
    // afterwards persists because the one-shot never re-runs.
    await writeFixture(
      join(tempDir, 'preferences.json'),
      preferencesFile({ localMemoryEnabled: false }),
    );

    await migrateLocalMemoryDefaultOn();
    expect((await readPreferences(tempDir)).localMemoryEnabled).toBe(true);

    await writeFixture(
      join(tempDir, 'preferences.json'),
      preferencesFile({
        localMemoryEnabled: false,
        localMemoryEnabledSetByUser: true,
      }),
    );
    await migrateLocalMemoryDefaultOn();
    expect((await readPreferences(tempDir)).localMemoryEnabled).toBe(false);
  });

  describe('local memory model from the old summary model', () => {
    const OLLAMA_MODEL = 'ollama-llama3.2';

    afterEach(() => {
      initOllamaModels([]);
    });

    async function migrateFromCapturedSnapshot(): Promise<void> {
      const snapshot = await captureLocalMemoryModelMigrationSnapshot();
      // Earlier startup writes serialize the full normalized object, which
      // materializes the new local memory defaults before this migration.
      await updatePreferencesFile(() => ({
        approvalsUpgradeNoticeDismissed: true,
      }));
      await migrateLocalMemoryModelFromSummary(snapshot);
    }

    it('keeps memory on the local model that used to run it', async () => {
      initOllamaModels([
        { id: OLLAMA_MODEL, rawModelId: 'llama3.2', label: 'Llama 3.2' },
      ]);
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          summaryModel: OLLAMA_MODEL,
          summaryThinkingLevel: 'low',
        }),
      );

      await migrateFromCapturedSnapshot();

      expect(await readPreferences(tempDir)).toMatchObject({
        localMemoryModel: OLLAMA_MODEL,
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: 'low',
      });
      await expect(
        readFile(join(tempDir, 'migrations.json'), 'utf8'),
      ).resolves.toContain(
        `"${LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY}": true`,
      );
    });

    it('keeps the local model while Ollama is not running', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({ summaryModel: OLLAMA_MODEL }),
      );

      await migrateFromCapturedSnapshot();

      expect(await readPreferences(tempDir)).toMatchObject({
        localMemoryModel: OLLAMA_MODEL,
        localMemoryModelSetByUser: true,
      });
    });

    it.each(['claude-haiku-4-5-20251001', 'haiku'])(
      'gives a profile with the untouched %s seed the provider-aware default',
      async (summaryModel) => {
        await writeFixture(
          join(tempDir, 'preferences.json'),
          preferencesFile({ summaryModel }),
        );

        await migrateFromCapturedSnapshot();

        expect(await readPreferences(tempDir)).toMatchObject({
          localMemoryModelSetByUser: false,
        });
        expect(await readPreferencesFile()).toMatchObject({
          localMemoryModel: normalizePreferences({}).localMemoryModel,
          localMemoryModelSetByUser: false,
        });
        await expect(
          readFile(join(tempDir, 'migrations.json'), 'utf8'),
        ).resolves.toContain(
          `"${LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY}": true`,
        );
      },
    );

    it('gives a profile whose chosen summary model was marked as not chosen the default', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          summaryModel: 'sonnet',
          summaryModelSetByUser: false,
        }),
      );

      await migrateFromCapturedSnapshot();

      expect(await readPreferences(tempDir)).toMatchObject({
        localMemoryModelSetByUser: false,
      });
    });

    it.each([
      ['a marked Claude choice', { summaryModelSetByUser: true }],
      ['an unmarked Claude choice other than the old default', {}],
    ])(
      'keeps %s on Claude with the Opus default at high thinking',
      async (_label, marker) => {
        await writeFixture(
          join(tempDir, 'preferences.json'),
          preferencesFile({
            summaryModel: 'sonnet',
            summaryThinkingLevel: 'low',
            ...marker,
          }),
        );

        await migrateFromCapturedSnapshot();

        expect(await readPreferences(tempDir)).toMatchObject({
          localMemoryModel: 'opus[1m]',
          localMemoryModelSetByUser: true,
          localMemoryThinkingLevel: 'high',
        });
      },
    );

    it('keeps a chosen Codex summary model on Codex with GPT 6.1 Sol at high thinking', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          summaryModel: 'gpt-5.5',
          summaryModelSetByUser: true,
          summaryThinkingLevel: 'low',
        }),
      );

      await migrateFromCapturedSnapshot();

      expect(await readPreferences(tempDir)).toMatchObject({
        localMemoryModel: 'gpt-6.1-sol',
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: 'high',
      });
      // Kept even while this install's catalog does not offer it: memory runs
      // refuse rather than fall back to another provider's model.
      expect(await readPreferencesFile()).toMatchObject({
        localMemoryModel: 'gpt-6.1-sol',
        localMemoryModelSetByUser: true,
      });
    });

    it('leaves a profile that already has a local memory model untouched', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          summaryModel: OLLAMA_MODEL,
          localMemoryModel: 'sonnet',
          localMemoryModelSetByUser: true,
          localMemoryThinkingLevel: 'medium',
        }),
      );

      await migrateFromCapturedSnapshot();

      expect(await readPreferences(tempDir)).toMatchObject({
        localMemoryModel: 'sonnet',
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: 'medium',
      });
    });

    it('still carries the legacy choice over after a startup stopped before this migration', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          summaryModel: 'sonnet',
          summaryThinkingLevel: 'low',
        }),
      );
      // First startup: the earlier migrations write the normalized object,
      // which materializes local memory defaults, then startup stops.
      const firstChatSummarySnapshot =
        await captureChatSummaryModelSelectionMigrationSnapshot();
      await migrateApprovalDefaultsToFullAccess(true);
      await migrateChatSummaryModelSelection(firstChatSummarySnapshot);
      expect(await readPreferences(tempDir)).toMatchObject({
        localMemoryModelSetByUser: false,
      });
      await expect(
        readFile(join(tempDir, 'migrations.json'), 'utf8'),
      ).resolves.not.toContain(LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY);

      // Next startup captures the partially migrated file.
      await migrateLocalMemoryModelFromSummary(
        await captureLocalMemoryModelMigrationSnapshot(),
      );

      expect(await readPreferences(tempDir)).toMatchObject({
        localMemoryModel: 'opus[1m]',
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: 'high',
      });

      // A later startup is a no-op.
      const migrated = await readFile(
        join(tempDir, 'preferences.json'),
        'utf8',
      );
      await migrateLocalMemoryModelFromSummary(
        await captureLocalMemoryModelMigrationSnapshot(),
      );
      await expect(
        readFile(join(tempDir, 'preferences.json'), 'utf8'),
      ).resolves.toBe(migrated);
    });

    it('keeps a model chosen before an interrupted migration recorded completion', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          summaryModel: 'sonnet',
          localMemoryModel: 'gpt-5.5',
          localMemoryModelSetByUser: true,
          localMemoryThinkingLevel: 'medium',
        }),
      );

      await migrateFromCapturedSnapshot();

      expect(await readPreferences(tempDir)).toMatchObject({
        localMemoryModel: 'gpt-5.5',
        localMemoryModelSetByUser: true,
        localMemoryThinkingLevel: 'medium',
      });
    });

    it('runs once', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({ summaryModel: 'claude-haiku-4-5-20251001' }),
      );
      await migrateFromCapturedSnapshot();
      const legacy = preferencesFile({ summaryModel: OLLAMA_MODEL });
      await writeFixture(join(tempDir, 'preferences.json'), legacy);

      await migrateLocalMemoryModelFromSummary(
        await captureLocalMemoryModelMigrationSnapshot(),
      );

      await expect(
        readFile(join(tempDir, 'preferences.json'), 'utf8'),
      ).resolves.toBe(legacy);
    });

    it('marks a fresh profile without creating preferences', async () => {
      await migrateLocalMemoryModelFromSummary();

      await expectMissing(join(tempDir, 'preferences.json'));
      await expect(
        readFile(join(tempDir, 'migrations.json'), 'utf8'),
      ).resolves.toContain(
        `"${LOCAL_MEMORY_MODEL_FROM_SUMMARY_MIGRATION_KEY}": true`,
      );
    });

    it('does not mark the migration after a degraded read', async () => {
      await mkdir(join(tempDir, 'preferences.json'), { recursive: true });

      await migrateLocalMemoryModelFromSummary();

      await expectMissing(join(tempDir, 'migrations.json'));
    });
  });

  it('never overrides a marker-backed explicit opt-out', async () => {
    await writeFixture(
      join(tempDir, 'preferences.json'),
      preferencesFile({
        localMemoryEnabled: false,
        localMemoryEnabledSetByUser: true,
      }),
    );

    await migrateLocalMemoryDefaultOn();

    expect((await readPreferences(tempDir)).localMemoryEnabled).toBe(false);
  });

  it('moves a persisted last-updated Projects sort to manual order once', async () => {
    // Manual order is the product default now. Every profile from the
    // recency-default era serialized `last-updated` whether or not the user
    // chose it, so the one-shot lifts all of them; a choice made afterwards
    // persists because the migration never re-runs.
    const preferencesPath = join(tempDir, 'preferences.json');
    await writeFixture(
      preferencesPath,
      preferencesFile({ sidebarProjectSortMode: 'last-updated' }),
    );

    await migrateSidebarManualSortDefault();

    const migrated = await readPreferences(tempDir);
    expect(migrated.sidebarProjectSortMode).toBe('manual');
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY}": true`,
    );

    await writeFixture(
      preferencesPath,
      preferencesFile({ ...migrated, sidebarProjectSortMode: 'last-updated' }),
    );

    await migrateSidebarManualSortDefault();

    expect((await readPreferences(tempDir)).sidebarProjectSortMode).toBe(
      'last-updated',
    );
  });

  it('leaves a manual Projects sort untouched and still marks the migration', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    const existingPreferences = preferencesFile({
      sidebarProjectSortMode: 'manual',
    });
    await writeFixture(preferencesPath, existingPreferences);

    await migrateSidebarManualSortDefault();

    await expect(readFile(preferencesPath, 'utf8')).resolves.toBe(
      existingPreferences,
    );
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${SIDEBAR_MANUAL_SORT_DEFAULT_MIGRATION_KEY}": true`,
    );
  });

  it('does not mark the sort migration when the preferences read was degraded', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    await mkdir(preferencesPath, { recursive: true });

    await migrateSidebarManualSortDefault();

    await expectMissing(join(tempDir, 'migrations.json'));

    await rm(preferencesPath, { recursive: true, force: true });
    resetPreferencesLoadErrorForTests();
    await writeFixture(
      preferencesPath,
      preferencesFile({ sidebarProjectSortMode: 'last-updated' }),
    );

    await migrateSidebarManualSortDefault();

    expect((await readPreferences(tempDir)).sidebarProjectSortMode).toBe(
      'manual',
    );
  });

  it('opens app links in the built-in browser for every profile once', async () => {
    // Opening clicked links in the built-in browser is the product default
    // now. Preferences serialize as a full object, so every earlier profile
    // carries `openAppLinksInBuiltInBrowser: false` whether or not the user
    // chose it; the one-shot turns all of them on, and a later choice of off
    // persists because the migration never re-runs.
    const preferencesPath = join(tempDir, 'preferences.json');
    await writeFixture(
      preferencesPath,
      preferencesFile({ openAppLinksInBuiltInBrowser: false }),
    );

    await migrateOpenAppLinksInBuiltInBrowserDefault();

    const migrated = await readPreferences(tempDir);
    expect(migrated.openAppLinksInBuiltInBrowser).toBe(true);
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY}": true`,
    );

    await writeFixture(
      preferencesPath,
      preferencesFile({ ...migrated, openAppLinksInBuiltInBrowser: false }),
    );

    await migrateOpenAppLinksInBuiltInBrowserDefault();

    expect((await readPreferences(tempDir)).openAppLinksInBuiltInBrowser).toBe(
      false,
    );
  });

  it('leaves built-in browser links already on untouched and still marks the migration', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    const existingPreferences = preferencesFile({
      openAppLinksInBuiltInBrowser: true,
    });
    await writeFixture(preferencesPath, existingPreferences);

    await migrateOpenAppLinksInBuiltInBrowserDefault();

    await expect(readFile(preferencesPath, 'utf8')).resolves.toBe(
      existingPreferences,
    );
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${OPEN_APP_LINKS_IN_BUILT_IN_BROWSER_DEFAULT_MIGRATION_KEY}": true`,
    );
  });

  it('does not mark the built-in browser links migration when the preferences read was degraded', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    await mkdir(preferencesPath, { recursive: true });

    await migrateOpenAppLinksInBuiltInBrowserDefault();

    await expectMissing(join(tempDir, 'migrations.json'));

    await rm(preferencesPath, { recursive: true, force: true });
    resetPreferencesLoadErrorForTests();
    await writeFixture(
      preferencesPath,
      preferencesFile({ openAppLinksInBuiltInBrowser: false }),
    );

    await migrateOpenAppLinksInBuiltInBrowserDefault();

    expect((await readPreferences(tempDir)).openAppLinksInBuiltInBrowser).toBe(
      true,
    );
  });

  it('migrates existing Claude worker mode preferences to canopy once', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    await writeFixture(
      preferencesPath,
      preferencesFile({
        canopyBackgroundProcessesMode: 'terminal',
        pipelinesMode: 'terminal',
      }),
    );

    await migrateClaudeWorkerModesToCanopy();

    const migrated = await readPreferences(tempDir);
    expect(migrated.canopyBackgroundProcessesMode).toBe('canopy');
    expect(migrated.pipelinesMode).toBe('canopy');
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(`"${CLAUDE_WORKER_MODES_CANOPY_MIGRATION_KEY}": true`);

    await writeFixture(
      preferencesPath,
      preferencesFile({
        ...migrated,
        canopyBackgroundProcessesMode: 'terminal',
        pipelinesMode: 'terminal',
      }),
    );

    await migrateClaudeWorkerModesToCanopy();

    const afterMarked = await readPreferences(tempDir);
    expect(afterMarked.canopyBackgroundProcessesMode).toBe('terminal');
    expect(afterMarked.pipelinesMode).toBe('terminal');
  });

  it('skips when no stored legacy mode preferences exist', async () => {
    await migrateClaudeWorkerModesToCanopy();

    await expectMissing(join(tempDir, 'preferences.json'));
    await expectMissing(join(tempDir, 'migrations.json'));
  });

  it('does not rewrite preferences when legacy modes are already canopy', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    const existingPreferences = preferencesFile({
      canopyBackgroundProcessesMode: 'canopy',
      pipelinesMode: 'canopy',
    });
    await writeFixture(preferencesPath, existingPreferences);

    await migrateClaudeWorkerModesToCanopy();

    await expect(readFile(preferencesPath, 'utf8')).resolves.toBe(
      existingPreferences,
    );
    await expectMissing(join(tempDir, 'migrations.json'));
  });

  it('migrates the legacy default sidebar layout to the new default once', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    await writeFixture(
      preferencesPath,
      preferencesFile({
        sidebarNavLayout: {
          order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
          moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
        },
      }),
    );

    await migrateSidebarRemoteControlVisible();

    const migrated = await readPreferences(tempDir);
    expect(migrated.sidebarNavLayout).toEqual(DEFAULT_SIDEBAR_NAV_LAYOUT);
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY}": true`,
    );

    await writeFixture(
      preferencesPath,
      preferencesFile({
        ...migrated,
        sidebarNavLayout: {
          order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
          moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
        },
      }),
    );

    await migrateSidebarRemoteControlVisible();

    const afterMarked = await readPreferences(tempDir);
    expect(afterMarked.sidebarNavLayout).toEqual(
      LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT,
    );
  });

  it('migrates a legacy default layout already reconciled to the Workflows key', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    await writeFixture(
      preferencesPath,
      preferencesFile({
        sidebarNavLayout: reconcileSidebarNavLayout({
          order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
          moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
        }),
      }),
    );

    await migrateSidebarRemoteControlVisible();

    const migrated = await readPreferences(tempDir);
    expect(migrated.sidebarNavLayout).toEqual(DEFAULT_SIDEBAR_NAV_LAYOUT);
  });

  it('leaves a reconciled customized layout untouched', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    const existingPreferences = preferencesFile({
      sidebarNavLayout: reconcileSidebarNavLayout({
        order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order].reverse(),
        moreStartIndex: 3,
      }),
    });
    await writeFixture(preferencesPath, existingPreferences);

    await migrateSidebarRemoteControlVisible();

    await expect(readFile(preferencesPath, 'utf8')).resolves.toBe(
      existingPreferences,
    );
  });

  it('does not mark the sidebar migration when the preferences read was degraded', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    // A directory at the preferences path makes both the read and the
    // subsequent recovery write fail, which is the path where
    // `readPreferencesFile()` silently hands back DEFAULT_PREFERENCES while
    // flagging a load error. The user's real (possibly legacy) layout is never
    // observed, so the migration must not burn its one-shot marker.
    await mkdir(preferencesPath, { recursive: true });

    await migrateSidebarRemoteControlVisible();

    await expectMissing(join(tempDir, 'migrations.json'));

    // Repair the file and relaunch: the migration must still run.
    await rm(preferencesPath, { recursive: true, force: true });
    resetPreferencesLoadErrorForTests();
    await writeFixture(
      preferencesPath,
      preferencesFile({
        sidebarNavLayout: {
          order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
          moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
        },
      }),
    );

    await migrateSidebarRemoteControlVisible();

    const migrated = await readPreferences(tempDir);
    expect(migrated.sidebarNavLayout).toEqual(DEFAULT_SIDEBAR_NAV_LAYOUT);
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY}": true`,
    );
  });

  it('leaves a customized sidebar layout untouched and still marks the migration', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    const customizedLayout = {
      order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order].reverse(),
      moreStartIndex: 3,
    };
    const existingPreferences = preferencesFile({
      sidebarNavLayout: customizedLayout,
    });
    await writeFixture(preferencesPath, existingPreferences);

    await migrateSidebarRemoteControlVisible();

    await expect(readFile(preferencesPath, 'utf8')).resolves.toBe(
      existingPreferences,
    );
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${SIDEBAR_REMOTE_CONTROL_VISIBLE_MIGRATION_KEY}": true`,
    );
  });

  describe('migrateSidebarMorePagesToMain', () => {
    const PRE_CAN_3678_DEFAULT = {
      order: [
        'app-advisor',
        'workflows',
        'plugins',
        'feed',
        'remote-control',
        'overview',
        'kanban',
        'environments',
        'agents',
        'statistics',
        'audit',
        'workers',
      ],
      moreStartIndex: 5,
    };
    const expectMarked = async (): Promise<void> => {
      await expect(
        readFile(join(tempDir, 'migrations.json'), 'utf8'),
      ).resolves.toContain(
        `"${SIDEBAR_MORE_PAGES_TO_MAIN_MIGRATION_KEY}": true`,
      );
    };

    it('turns the previous default layout into the current default', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({ sidebarNavLayout: PRE_CAN_3678_DEFAULT }),
      );

      await migrateSidebarMorePagesToMain();

      expect((await readPreferences(tempDir)).sidebarNavLayout).toEqual(
        DEFAULT_SIDEBAR_NAV_LAYOUT,
      );
      await expectMarked();
    });

    it('moves every retained More key, keeping their relative order', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          sidebarNavLayout: {
            order: [
              'plugins',
              'app-advisor',
              'workflows',
              'feed',
              'audit',
              'remote-control',
              'workers',
              'environments',
              'statistics',
              'kanban',
              'overview',
              'agents',
            ],
            moreStartIndex: 5,
          },
        }),
      );

      await migrateSidebarMorePagesToMain();

      expect((await readPreferences(tempDir)).sidebarNavLayout).toEqual({
        order: [
          'plugins',
          'app-advisor',
          'workflows',
          'feed',
          'audit',
          'remote-control',
          'workers',
          'statistics',
          'kanban',
          'overview',
        ],
        moreStartIndex: 10,
      });
    });

    it('empties More when Environments already sits in main nav', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          sidebarNavLayout: {
            order: [
              'environments',
              'app-advisor',
              'workflows',
              'plugins',
              'feed',
              'remote-control',
              'overview',
              'kanban',
              'agents',
              'statistics',
              'audit',
              'workers',
            ],
            moreStartIndex: 6,
          },
        }),
      );

      await migrateSidebarMorePagesToMain();

      const { sidebarNavLayout } = await readPreferences(tempDir);
      expect(sidebarNavLayout.order).not.toContain('environments');
      expect(sidebarNavLayout.moreStartIndex).toBe(
        sidebarNavLayout.order.length,
      );
    });

    it('leaves layouts with nothing to move untouched and still marks the migration', async () => {
      const preferencesPath = join(tempDir, 'preferences.json');
      for (const sidebarNavLayout of [
        DEFAULT_SIDEBAR_NAV_LAYOUT,
        {
          order: [...DEFAULT_SIDEBAR_NAV_LAYOUT.order],
          moreStartIndex: DEFAULT_SIDEBAR_NAV_LAYOUT.order.length,
        },
      ]) {
        await rm(join(tempDir, 'migrations.json'), { force: true });
        const existingPreferences = preferencesFile({ sidebarNavLayout });
        await writeFixture(preferencesPath, existingPreferences);

        await migrateSidebarMorePagesToMain();

        await expect(readFile(preferencesPath, 'utf8')).resolves.toBe(
          existingPreferences,
        );
        await expectMarked();
      }
    });

    it('marks the migration without writing preferences for a fresh profile', async () => {
      await migrateSidebarMorePagesToMain();

      await expectMissing(join(tempDir, 'preferences.json'));
      await expectMarked();
    });

    it('tolerates a stored divider past the end of the order', async () => {
      // Reconciliation on read clamps the divider, so the layout is already
      // all main nav and nothing moves.
      const preferencesPath = join(tempDir, 'preferences.json');
      const existingPreferences = preferencesFile({
        sidebarNavLayout: {
          order: [...PRE_CAN_3678_DEFAULT.order],
          moreStartIndex: 999,
        },
      });
      await writeFixture(preferencesPath, existingPreferences);

      await migrateSidebarMorePagesToMain();

      await expect(readFile(preferencesPath, 'utf8')).resolves.toBe(
        existingPreferences,
      );
      await expectMarked();
    });

    it('runs only once', async () => {
      const preferencesPath = join(tempDir, 'preferences.json');
      await writeFixture(
        preferencesPath,
        preferencesFile({ sidebarNavLayout: PRE_CAN_3678_DEFAULT }),
      );
      await migrateSidebarMorePagesToMain();
      const migrated = await readPreferences(tempDir);
      await writeFixture(
        preferencesPath,
        preferencesFile({
          ...migrated,
          sidebarNavLayout: PRE_CAN_3678_DEFAULT,
        }),
      );

      await migrateSidebarMorePagesToMain();

      expect((await readPreferences(tempDir)).sidebarNavLayout).toEqual(
        PRE_CAN_3678_DEFAULT,
      );
    });

    it('does not mark the migration when the preferences read was degraded', async () => {
      const preferencesPath = join(tempDir, 'preferences.json');
      await mkdir(preferencesPath, { recursive: true });

      await migrateSidebarMorePagesToMain();

      await expectMissing(join(tempDir, 'migrations.json'));

      await rm(preferencesPath, { recursive: true, force: true });
      resetPreferencesLoadErrorForTests();
      await writeFixture(
        preferencesPath,
        preferencesFile({ sidebarNavLayout: PRE_CAN_3678_DEFAULT }),
      );

      await migrateSidebarMorePagesToMain();

      expect((await readPreferences(tempDir)).sidebarNavLayout).toEqual(
        DEFAULT_SIDEBAR_NAV_LAYOUT,
      );
      await expectMarked();
    });

    it('turns a legacy default into the current default after the Remote Control migration', async () => {
      await writeFixture(
        join(tempDir, 'preferences.json'),
        preferencesFile({
          sidebarNavLayout: {
            order: [...LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order],
            moreStartIndex: LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
          },
        }),
      );

      await migrateSidebarRemoteControlVisible();
      await migrateSidebarMorePagesToMain();

      expect((await readPreferences(tempDir)).sidebarNavLayout).toEqual(
        DEFAULT_SIDEBAR_NAV_LAYOUT,
      );
    });
  });

  it('does not re-arm the notice when the posture was already Full Access', async () => {
    // Nothing is being changed for this user, so there is nothing to disclose.
    const preferencesPath = join(tempDir, 'preferences.json');
    await writeFixture(
      preferencesPath,
      preferencesFile({
        approvalsUpgradeNoticeDismissed: true,
        approvalDefaults: {
          worktree: 'full-access',
          cowork: 'full-access',
          appAdvisor: 'full-access',
        },
      }),
    );

    await migrateApprovalDefaultsToFullAccess();

    const migrated = await readPreferences(tempDir);
    expect(migrated.approvalDefaults).toEqual({
      worktree: 'full-access',
      cowork: 'full-access',
      appAdvisor: 'full-access',
    });
    expect(migrated.approvalsUpgradeNoticeDismissed).toBe(true);
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY}": true`,
    );
  });

  it('migrates all three approval defaults to Full Access for an existing user once', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    await writeFixture(
      preferencesPath,
      preferencesFile({
        approvalsUpgradeNoticeDismissed: true,
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'auto',
          appAdvisor: 'ask',
        },
      }),
    );

    await migrateApprovalDefaultsToFullAccess();

    const migrated = await readPreferences(tempDir);
    expect(migrated.approvalDefaults).toEqual({
      worktree: 'full-access',
      cowork: 'full-access',
      appAdvisor: 'full-access',
    });
    // CAN-3055: this migration OVERWRITES a posture the user may have chosen
    // deliberately, so it must re-arm the one-time disclosure notice. A profile
    // old enough to still need this migration has almost certainly already
    // dismissed the earlier notice, so without the re-arm the escalation ships
    // with no disclosure at all.
    expect(migrated.approvalsUpgradeNoticeDismissed).toBe(false);
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY}": true`,
    );

    await writeFixture(
      preferencesPath,
      preferencesFile({
        ...migrated,
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'ask',
          appAdvisor: 'ask',
        },
      }),
    );

    await migrateApprovalDefaultsToFullAccess();

    expect((await readPreferences(tempDir)).approvalDefaults).toEqual({
      worktree: 'ask',
      cowork: 'ask',
      appAdvisor: 'ask',
    });
  });

  it('keeps Ask defaults for a new user and records the migration as not applicable', async () => {
    await migrateApprovalDefaultsToFullAccess();

    await expectMissing(join(tempDir, 'preferences.json'));
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY}": true`,
    );

    await writeFixture(
      join(tempDir, 'preferences.json'),
      preferencesFile({
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'ask',
          appAdvisor: 'ask',
        },
      }),
    );

    await migrateApprovalDefaultsToFullAccess();

    expect((await readPreferences(tempDir)).approvalDefaults).toEqual({
      worktree: 'ask',
      cowork: 'ask',
      appAdvisor: 'ask',
    });
  });

  it('keeps Ask defaults when another startup service creates preferences for a fresh profile', async () => {
    await writeFixture(
      join(tempDir, 'preferences.json'),
      preferencesFile({
        ollamaExecutablePath: '/Applications/Ollama.app/Contents/MacOS/Ollama',
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'ask',
          appAdvisor: 'ask',
        },
      }),
    );

    await migrateApprovalDefaultsToFullAccess(false);

    expect((await readPreferences(tempDir)).approvalDefaults).toEqual({
      worktree: 'ask',
      cowork: 'ask',
      appAdvisor: 'ask',
    });
    await expect(
      readFile(join(tempDir, 'migrations.json'), 'utf8'),
    ).resolves.toContain(
      `"${APPROVAL_DEFAULTS_FULL_ACCESS_MIGRATION_KEY}": true`,
    );
  });

  it('does not overwrite a corrupt last-good file when the primary preferences file is missing', async () => {
    const lastGoodPath = join(tempDir, 'preferences.last-good.json');
    const corruptLastGood = '{not valid json';
    await writeFixture(lastGoodPath, corruptLastGood);

    await migrateApprovalDefaultsToFullAccess();

    await expectMissing(join(tempDir, 'preferences.json'));
    await expect(readFile(lastGoodPath, 'utf8')).resolves.toBe(corruptLastGood);
    await expectMissing(join(tempDir, 'migrations.json'));
  });

  it('does not mark the approval-default migration after a degraded existing-user read', async () => {
    const preferencesPath = join(tempDir, 'preferences.json');
    await mkdir(preferencesPath, { recursive: true });

    await migrateApprovalDefaultsToFullAccess();

    await expectMissing(join(tempDir, 'migrations.json'));

    await rm(preferencesPath, { recursive: true, force: true });
    resetPreferencesLoadErrorForTests();
    await writeFixture(
      preferencesPath,
      preferencesFile({
        approvalDefaults: {
          worktree: 'ask',
          cowork: 'ask',
          appAdvisor: 'ask',
        },
      }),
    );

    await migrateApprovalDefaultsToFullAccess();

    expect((await readPreferences(tempDir)).approvalDefaults).toEqual({
      worktree: 'full-access',
      cowork: 'full-access',
      appAdvisor: 'full-access',
    });
  });
});
