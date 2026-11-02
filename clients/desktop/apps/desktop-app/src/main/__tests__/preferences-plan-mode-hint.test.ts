import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlanModeHintRecord } from '@canopy/protocol/onboarding';
// The shared durable writer installs through this module's rename.
import * as renameModule from '@canopy/desktop-shared/node/lib/rename-with-retry';

let preferencesPath: string;
jest.mock('../lib/paths', () => ({
  getPreferencesFilePath: (): string => preferencesPath,
}));

import {
  flushPreferencesWrites,
  normalizePreferences,
  readPreferencesFile,
  readPreferencesFileForRenderer,
  resetPreferencesLoadErrorForTests,
  writePreferencesFile,
} from '../lib/preferences-store';

const AT = '2026-10-13T12:00:00.000Z';
const LATER = '2026-10-13T13:00:00.000Z';
const INITIAL: PlanModeHintRecord = { version: 1, generation: 0 };

describe('plan-mode hint preference normalization', () => {
  it('initializes a durable marker without retirement or an impression', () => {
    expect(normalizePreferences({}).planModeHint).toEqual(INITIAL);
  });

  it('keeps known fields and canonicalizes valid ISO timestamps', () => {
    expect(
      normalizePreferences({
        planModeHint: {
          version: 1,
          generation: 2,
          shownAt: '2026-10-13T08:00:00-04:00',
          dismissedAt: 'not a timestamp',
          triedAt: AT,
          extra: 'discard',
        },
      }).planModeHint,
    ).toEqual({ version: 1, generation: 2, shownAt: AT, triedAt: AT });
  });

  it.each([null, [], 'bad', { version: 2 }, { version: 1, generation: -1 }])(
    'does not initialize or remigrate a malformed/unsupported record: %p',
    (planModeHint) => {
      expect(
        normalizePreferences({
          planModeHint,
          homeOnboardingSuggestions: {
            entries: { 'plan-mode': { completedAt: AT } },
          },
        }).planModeHint,
      ).toBeUndefined();
    },
  );

  it('reads legacy completion/dismissal before checklist normalization', () => {
    // No startedAt: ordinary checklist normalization discards this record.
    expect(
      normalizePreferences({
        homeOnboardingSuggestions: {
          entries: { 'plan-mode': { completedAt: AT, dismissedAt: LATER } },
        },
      }).planModeHint,
    ).toEqual({ ...INITIAL, triedAt: AT, dismissedAt: LATER });
  });

  it('does not migrate partial progress or malformed legacy timestamps', () => {
    expect(
      normalizePreferences({
        homeOnboardingSuggestions: {
          entries: {
            'plan-mode': { completedAt: 'bad', latchedSteps: ['enable'] },
          },
        },
      }).planModeHint,
    ).toEqual(INITIAL);
  });

  it('honors an initialized/reset record over legacy progress', () => {
    expect(
      normalizePreferences({
        planModeHint: { version: 1, generation: 1 },
        homeOnboardingSuggestions: {
          entries: { 'plan-mode': { completedAt: AT } },
        },
      }).planModeHint,
    ).toEqual({ version: 1, generation: 1 });
  });
});

describe('authoritative plan-mode hint writes', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'canopy-plan-mode-hint-'));
    preferencesPath = join(directory, 'preferences.json');
    resetPreferencesLoadErrorForTests();
    await seed({ planModeHint: INITIAL, sidebarWidth: 320 });
  });

  afterEach(async () => {
    await flushPreferencesWrites();
    resetPreferencesLoadErrorForTests();
    await rm(directory, { recursive: true, force: true });
  });

  async function seed(preferences: Record<string, unknown>): Promise<void> {
    await writeFile(
      preferencesPath,
      JSON.stringify({ version: 1, preferences }),
    );
  }

  it('preserves retirement across concurrent stale impressions and unrelated writes', async () => {
    await Promise.all([
      writePreferencesFile({ planModeHint: { ...INITIAL, dismissedAt: AT } }),
      writePreferencesFile({ sidebarWidth: 400 }),
      writePreferencesFile({ planModeHint: { ...INITIAL, shownAt: LATER } }),
      writePreferencesFile({ planModeHint: { ...INITIAL, triedAt: LATER } }),
    ]);
    expect(await readPreferencesFile()).toMatchObject({
      sidebarWidth: 400,
      planModeHint: {
        ...INITIAL,
        dismissedAt: AT,
        triedAt: LATER,
        shownAt: LATER,
      },
    });
  });

  it('fences older pending writes after reset and stays reset on reload', async () => {
    await seed({
      homeOnboardingSuggestions: {
        startedAt: AT,
        entries: { 'plan-mode': { completedAt: AT } },
      },
    });
    const reset: PlanModeHintRecord = { version: 1, generation: 1 };
    await Promise.all([
      writePreferencesFile({ planModeHint: reset }),
      writePreferencesFile({
        planModeHint: { ...INITIAL, dismissedAt: LATER },
      }),
      writePreferencesFile({ planModeHint: { ...INITIAL, shownAt: LATER } }),
    ]);
    resetPreferencesLoadErrorForTests();
    expect((await readPreferencesFile()).planModeHint).toEqual(reset);
  });

  it('merges initial migration with a first impression and persists before checklist cleanup', async () => {
    await seed({
      homeOnboardingSuggestions: {
        startedAt: AT,
        entries: { 'plan-mode': { dismissedAt: AT } },
      },
    });
    await writePreferencesFile({
      planModeHint: { ...INITIAL, shownAt: LATER },
      homeOnboardingSuggestions: { startedAt: AT, entries: {} },
    });
    resetPreferencesLoadErrorForTests();
    expect((await readPreferencesFile()).planModeHint).toEqual({
      ...INITIAL,
      dismissedAt: AT,
      shownAt: LATER,
    });
  });

  it('does not let undefined or invalid patches erase initialized state', async () => {
    await writePreferencesFile({ planModeHint: { ...INITIAL, triedAt: AT } });
    await expect(
      writePreferencesFile({ planModeHint: undefined }),
    ).rejects.toThrow();
    expect((await readPreferencesFile()).planModeHint?.triedAt).toBe(AT);
  });

  it('refuses hint writes after a degraded read, then permits retry after recovery', async () => {
    // A directory at the file path forces an I/O failure rather than ENOENT.
    await rm(preferencesPath);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(preferencesPath);
    expect((await readPreferencesFileForRenderer()).__error).toBeDefined();
    await expect(
      writePreferencesFile({ planModeHint: { ...INITIAL, dismissedAt: AT } }),
    ).rejects.toThrow(/read/i);
    await rm(preferencesPath, { recursive: true });
    await seed({ planModeHint: INITIAL });
    resetPreferencesLoadErrorForTests();
    await writePreferencesFile({
      planModeHint: { ...INITIAL, dismissedAt: AT },
    });
    expect((await readPreferencesFile()).planModeHint?.dismissedAt).toBe(AT);
  });

  it('surfaces a corrupt hint record and refuses overwriting it with defaults', async () => {
    await seed({ planModeHint: { version: 99, generation: 0 } });
    const before = await readFile(preferencesPath, 'utf8');
    const error = (await readPreferencesFileForRenderer()).__error;
    expect(error).toBeDefined();
    expect(error?.backupPath).toBeUndefined();
    await expect(
      writePreferencesFile({ planModeHint: INITIAL }),
    ).rejects.toThrow();
    expect(await readFile(preferencesPath, 'utf8')).toBe(before);
  });

  it('does not drop a corrupt hint during an unrelated preference save', async () => {
    await seed({
      planModeHint: { version: 99, generation: 0 },
      sidebarWidth: 320,
    });
    const before = await readFile(preferencesPath, 'utf8');
    await expect(writePreferencesFile({ sidebarWidth: 400 })).rejects.toThrow();
    expect(await readFile(preferencesPath, 'utf8')).toBe(before);
  });

  it('does not acknowledge a failed save and lets the same generation retry', async () => {
    const rename = jest
      .spyOn(renameModule, 'renameWithRetry')
      .mockRejectedValueOnce(new Error('disk full'));
    try {
      await expect(
        writePreferencesFile({ planModeHint: { ...INITIAL, triedAt: AT } }),
      ).rejects.toThrow('disk full');
      expect((await readPreferencesFile()).planModeHint).toEqual(INITIAL);
      await writePreferencesFile({ planModeHint: { ...INITIAL, triedAt: AT } });
      expect((await readPreferencesFile()).planModeHint?.triedAt).toBe(AT);
    } finally {
      rename.mockRestore();
    }
  });
});
