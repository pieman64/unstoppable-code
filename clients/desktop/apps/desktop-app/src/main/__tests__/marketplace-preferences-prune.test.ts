import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovalRule,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import * as atomicFile from '@canopy/desktop-shared/node/lib/rename-with-retry';
import {
  DEFAULT_PREFERENCES,
  flushPreferencesWrites,
  peekPreferencesLoadError,
  readPreferencesFile,
  resetPreferencesLoadErrorForTests,
} from '../lib/preferences-store';
import { pruneMarketplaceRefsFromPreferences } from '../plugins/marketplace-preferences-prune';
import { getGlobalPluginDefaultsRevision } from '../plugins/plugin-defaults-revision';
import type * as paths from '../lib/paths';

let mockPreferencesPath: string;
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof paths>('../lib/paths'),
  getPreferencesFilePath: (): string => mockPreferencesPath,
}));

// Every top-level preference that saves plugin selections, so a selection
// key added to the defaults gets a prune case without editing this list.
const SELECTION_KEYS = Object.entries(DEFAULT_PREFERENCES)
  .filter(
    ([, value]: [string, unknown]) =>
      typeof value === 'object' &&
      value !== null &&
      'pluginRefs' in value &&
      Array.isArray(value.pluginRefs),
  )
  .map(([key]) => key);

const MARKETPLACE_ID = 'acme/plugins';
const acme = { marketplaceId: MARKETPLACE_ID, pluginName: 'shared' };
const other = { marketplaceId: 'other/plugins', pluginName: 'other' };
const grant: ApprovalRule = {
  id: 'R',
  behavior: 'allow',
  origin: 'prompt',
  createdAt: '2026-10-27T00:00:00.000Z',
  target: { kind: 'file-write', path: 'allowed/**' },
};
const planModeHint = {
  version: 1,
  generation: 3,
  dismissedAt: '2026-10-20T00:00:00.000Z',
} as const;

let root: string;
let lastGoodPath: string;

function selections(
  ...pluginRefs: ChatTabPluginSelections['pluginRefs']
): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs };
}

function document(keys: readonly string[]): string {
  const preferences: Record<string, unknown> = {
    sidebarCollapsed: true,
    worktreePanelPercent: 48,
    globalApprovalRules: [grant],
    planModeHint,
  };
  for (const key of SELECTION_KEYS) {
    preferences[key] = keys.includes(key)
      ? selections(acme, other)
      : selections(other);
  }
  return JSON.stringify({ version: 1, preferences });
}

function namesMarketplace(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(namesMarketplace);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (key === 'marketplaceId' && child === MARKETPLACE_ID) ||
      namesMarketplace(child),
  );
}

async function persisted(filePath: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('preferences' in parsed) ||
    typeof parsed.preferences !== 'object' ||
    parsed.preferences === null
  ) {
    throw new Error(`Expected a preferences document at ${filePath}`);
  }
  return { ...parsed.preferences };
}

async function inventory(): Promise<Record<string, string>> {
  const entries = await fs.readdir(root);
  return Object.fromEntries(
    await Promise.all(
      entries
        .sort()
        .map(
          async (name): Promise<[string, string]> => [
            name,
            (await fs.readFile(join(root, name))).toString('base64'),
          ],
        ),
    ),
  );
}

async function expectPruned(): Promise<void> {
  // Last-good is refreshed after the save is acknowledged.
  await flushPreferencesWrites();
  for (const filePath of [mockPreferencesPath, lastGoodPath]) {
    const value = await persisted(filePath);
    expect(namesMarketplace(value)).toBe(false);
    for (const key of SELECTION_KEYS) {
      expect(value[key]).toMatchObject({ pluginRefs: [other] });
    }
    expect(value).toMatchObject({
      sidebarCollapsed: true,
      worktreePanelPercent: 48,
      globalApprovalRules: [grant],
      planModeHint,
    });
  }
}

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'marketplace-preferences-prune-'));
  mockPreferencesPath = join(root, 'preferences.json');
  lastGoodPath = join(root, 'preferences.last-good.json');
  resetPreferencesLoadErrorForTests();
});

afterEach(async () => {
  await flushPreferencesWrites();
  jest.restoreAllMocks();
  resetPreferencesLoadErrorForTests();
  await fs.rm(root, { recursive: true, force: true });
});

describe('Marketplace prune through the real preferences store', () => {
  it('finds the plugin selections in the defaults', () => {
    expect(SELECTION_KEYS).toEqual(
      expect.arrayContaining([
        'globalPluginSelections',
        'appAdvisorPluginSelections',
        'worktreeSummaryPluginSelections',
      ]),
    );
  });

  it('prunes every selection key from readable preferences', async () => {
    await fs.writeFile(mockPreferencesPath, document(SELECTION_KEYS));
    const before = getGlobalPluginDefaultsRevision();
    await pruneMarketplaceRefsFromPreferences(MARKETPLACE_ID);
    await expectPruned();
    expect(getGlobalPluginDefaultsRevision()).toBe(before + 1);
    expect(peekPreferencesLoadError()).toBeNull();
  });

  it.each(['missing', 'corrupt'])(
    'commits after the prune itself recovers a %s primary from last-good',
    async (state) => {
      if (state === 'corrupt') await fs.writeFile(mockPreferencesPath, '{torn');
      await fs.writeFile(lastGoodPath, document(SELECTION_KEYS));
      const before = getGlobalPluginDefaultsRevision();
      await pruneMarketplaceRefsFromPreferences(MARKETPLACE_ID);
      await expectPruned();
      expect(getGlobalPluginDefaultsRevision()).toBe(before + 1);
      // The recovery notice stays pending for the renderer to surface.
      expect(peekPreferencesLoadError()).not.toBeNull();
      if (state === 'corrupt') {
        const evidence = (await fs.readdir(root)).filter((name) =>
          name.startsWith('preferences.backup-'),
        );
        expect(evidence).toHaveLength(1);
        const backup: unknown = JSON.parse(
          await fs.readFile(join(root, evidence[0]), 'utf8'),
        );
        expect(backup).toMatchObject({ rawContent: '{torn' });
      }
    },
  );

  it.each(SELECTION_KEYS)(
    'prunes only %s while an earlier recovery notice is still pending',
    async (key) => {
      await fs.writeFile(lastGoodPath, document([key]));
      await readPreferencesFile();
      expect(peekPreferencesLoadError()).not.toBeNull();
      const before = getGlobalPluginDefaultsRevision();
      await pruneMarketplaceRefsFromPreferences(MARKETPLACE_ID);
      await expectPruned();
      expect(getGlobalPluginDefaultsRevision()).toBe(
        before + (key === 'globalPluginSelections' ? 1 : 0),
      );
      expect(peekPreferencesLoadError()).not.toBeNull();
    },
  );

  it('writes nothing and keeps the revision when no selection names the marketplace', async () => {
    await fs.writeFile(mockPreferencesPath, document([]));
    await fs.writeFile(lastGoodPath, document([]));
    const before = await inventory();
    const revision = getGlobalPluginDefaultsRevision();
    await pruneMarketplaceRefsFromPreferences(MARKETPLACE_ID);
    expect(await inventory()).toEqual(before);
    expect(getGlobalPluginDefaultsRevision()).toBe(revision);
  });

  it('refuses after a failed recovery and preserves every file', async () => {
    await fs.writeFile(mockPreferencesPath, '{torn');
    await fs.writeFile(lastGoodPath, document(SELECTION_KEYS));
    const rename = atomicFile.renameWithRetry;
    jest
      .spyOn(atomicFile, 'renameWithRetry')
      .mockImplementation(async (source, target) => {
        if (target === mockPreferencesPath)
          throw new Error('primary unavailable');
        return rename(source, target);
      });
    const revision = getGlobalPluginDefaultsRevision();
    await expect(
      pruneMarketplaceRefsFromPreferences(MARKETPLACE_ID),
    ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
    const afterFailure = await inventory();
    expect(afterFailure['preferences.json']).toBe(
      Buffer.from('{torn').toString('base64'),
    );
    expect(afterFailure['preferences.last-good.json']).toBe(
      Buffer.from(document(SELECTION_KEYS)).toString('base64'),
    );
    await expect(
      pruneMarketplaceRefsFromPreferences(MARKETPLACE_ID),
    ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
    expect(await inventory()).toEqual(afterFailure);
    expect(getGlobalPluginDefaultsRevision()).toBe(revision);
  });

  it('refuses without writing when neither file is usable', async () => {
    await fs.writeFile(mockPreferencesPath, '{torn');
    await fs.writeFile(lastGoodPath, '{also torn');
    const before = await inventory();
    const revision = getGlobalPluginDefaultsRevision();
    await expect(
      pruneMarketplaceRefsFromPreferences(MARKETPLACE_ID),
    ).rejects.toMatchObject({ code: 'PREFERENCES_RECOVERY_REQUIRED' });
    expect(await inventory()).toEqual(before);
    expect(getGlobalPluginDefaultsRevision()).toBe(revision);
  });
});
