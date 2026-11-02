import {
  COMPACT_QUEUE_EXPERIMENT,
  SMOOTH_STREAMING_EXPERIMENT,
  EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS,
  labsExperimentChoicesSchema,
  migrateExtractedLabsChoices,
  isLabsExperimentId,
  parseLabsExperimentAvailability,
  resolveLabsExperiment,
  LABS_EXPERIMENT_AVAILABILITIES,
  WEB_LABS_EXPERIMENTS,
} from '..';
import {
  CLIENT_FEATURE_FLAGS,
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS,
  CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
  isLabsExperimentFlagKey,
  LABS_EXPERIMENT_FLAG_KEYS,
} from '../../feature-flags';

describe('Labs resolution', () => {
  for (const requiresEarlyAccess of [false, true])
    for (const availability of LABS_EXPERIMENT_AVAILABILITIES)
      for (const choice of [null, true, false])
        for (const earlyAccessEnabled of [false, true]) {
          it(`${requiresEarlyAccess}/${availability}/${choice}/${earlyAccessEnabled}`, () => {
            const listed =
              availability !== 'hidden' &&
              (!requiresEarlyAccess || earlyAccessEnabled);
            expect(
              resolveLabsExperiment({
                availability,
                choice,
                earlyAccessEnabled,
                requiresEarlyAccess,
              }),
            ).toEqual({
              listed,
              enabled:
                listed &&
                (availability === 'on' ? choice !== false : choice === true),
            });
          });
        }
  it('enables an independent experiment while Early access is off', () => {
    expect(
      resolveLabsExperiment({
        availability: 'offered',
        choice: true,
        earlyAccessEnabled: false,
        requiresEarlyAccess: false,
      }),
    ).toEqual({ listed: true, enabled: true });
  });
  it('refuses a hidden experiment regardless of Early access', () => {
    for (const requiresEarlyAccess of [false, true])
      for (const earlyAccessEnabled of [false, true])
        expect(
          resolveLabsExperiment({
            availability: 'hidden',
            choice: true,
            earlyAccessEnabled,
            requiresEarlyAccess,
          }),
        ).toEqual({ listed: false, enabled: false });
  });
  it.each([true, false, null, 1, {}, [], 'enabled', 'ON', ' offered'])(
    'uses an explicit fallback for %p',
    (value) => {
      expect(parseLabsExperimentAvailability(value, 'offered')).toBe('offered');
      expect(parseLabsExperimentAvailability(value, 'hidden')).toBe('hidden');
    },
  );
  it('validates stable ids and bounds', () => {
    for (const id of ['early-access', '0', 'a'.repeat(64)])
      expect(isLabsExperimentId(id)).toBe(true);
    for (const id of [
      '',
      '-a',
      'A',
      'a_b',
      'a/b',
      'a'.repeat(65),
      null,
      '__proto__',
    ])
      expect(isLabsExperimentId(id)).toBe(false);
  });
  it('completes both typed default maps with offered', () => {
    expect([...LABS_EXPERIMENT_FLAG_KEYS]).toEqual([
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key,
      ...['sidebar', 'activity-card', 'minimal-layout', 'comet-spinners'].map(
        (id) => `canopy-desktop-labs-${id}`,
      ),
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatTabPreviews.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSubagentsView.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsArchivedChatsCard.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsProxyAccountCards.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsPrHoverCards.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsDaemonFilesReads.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsChatAutomationPipelines.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsOverviewPage.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsKanbanPage.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsStatisticsPage.key,
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsAuditTrailPage.key,
    ]);
    for (const { key } of Object.values(CLIENT_FEATURE_FLAGS).filter((flag) =>
      isLabsExperimentFlagKey(flag.key),
    )) {
      expect(CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS[key]).toBe(
        'offered',
      );
      expect(
        CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS[key],
      ).toBe('offered');
    }
    expect(
      isLabsExperimentFlagKey(
        CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key,
      ),
    ).toBe(false);
    for (const defaults of [
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_DISABLED_DEFAULTS,
      CLIENT_FEATURE_FLAG_LAUNCHDARKLY_ENABLED_UNAVAILABLE_DEFAULTS,
    ])
      expect(Object.keys(defaults).sort()).toEqual(
        Object.values(CLIENT_FEATURE_FLAGS)
          .map((flag) => flag.key)
          .sort(),
      );
  });
});

it('retains the 100-choice budget when the extracted notification choice is added', () => {
  const choices = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`retained-${index}`, true]),
  );
  expect(
    labsExperimentChoicesSchema.safeParse({
      ...choices,
      'stacked-notifications': true,
    }).success,
  ).toBe(true);
  expect(
    labsExperimentChoicesSchema.safeParse({ ...choices, unrelated: true })
      .success,
  ).toBe(false);
});

it('migrates only own legacy choices, retains explicit choices and is idempotent', () => {
  const migrated = migrateExtractedLabsChoices({
    'early-access': true,
    retired: false,
  });
  expect(migrated).toEqual({
    'early-access': true,
    retired: false,
    ...Object.fromEntries(
      EXTRACTED_EARLY_ACCESS_EXPERIMENT_IDS.map((id) => [id, true]),
    ),
  });
  expect(
    migrateExtractedLabsChoices({ ...migrated, 'early-access': false }),
  ).toEqual({ ...migrated, 'early-access': false });
  expect(
    migrateExtractedLabsChoices({
      'early-access': true,
      'stacked-notifications': false,
    })['stacked-notifications'],
  ).toBe(false);
  const inherited: Record<string, boolean> = {};
  Object.setPrototypeOf(inherited, { 'early-access': true });
  expect(migrateExtractedLabsChoices(inherited)['stacked-notifications']).toBe(
    false,
  );
});

describe('shared Labs experiments', () => {
  it('names each web Labs experiment by its registered flag', () => {
    expect(SMOOTH_STREAMING_EXPERIMENT.flagKey).toBe(
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsSmoothStreaming.key,
    );
    expect(COMPACT_QUEUE_EXPERIMENT.flagKey).toBe(
      CLIENT_FEATURE_FLAGS.canopyDesktopLabsCompactQueue.key,
    );
    // Clean chat graduated on 2026-10-27 and left Labs.
    expect(WEB_LABS_EXPERIMENTS).toEqual([]);
  });
});
