import * as fs from 'node:fs/promises';
import type * as FileSystemPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockRoot: string;
let mockFailRename = false;
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof FileSystemPromises>('node:fs/promises');
  return {
    ...actual,
    rename: (source: string, destination: string): Promise<void> =>
      mockFailRename
        ? Promise.reject(new Error('disk full'))
        : actual.rename(source, destination),
  };
});
jest.mock('../lib/paths', () => ({
  getActivationJourneyFilePath: (): string =>
    join(mockRoot, 'activation-journey.json'),
  getLegacyOnboardingChecklistFilePath: (): string =>
    join(mockRoot, 'onboarding-checklist.json'),
}));

import { migrateLegacyChecklistSignals } from '../notifications/campaigns/legacy-checklist-migration';
import {
  drainActivationJourneyWrites,
  latchActivationSignal,
  latchCampaignSent,
  readActivationJourneyState,
  recordActivity,
  resetActivationJourneyStateForTests,
} from '../notifications/campaigns/journey-state';
import { resolvePromotionalCapLiftsAt } from '../notifications/campaigns/campaign-config';

const AT = '2026-10-20T00:00:00.000Z';
const legacy = {
  version: 1,
  completedItems: {
    'start-chat': AT,
    'connect-accounts': AT,
    'add-capability': AT,
    'create-account': AT,
    unknown: AT,
  },
  dismissedAt: AT,
  providersNotUsed: ['claude'],
};

beforeEach(async () => {
  mockRoot = await fs.mkdtemp(join(tmpdir(), 'can-4010-'));
  resetActivationJourneyStateForTests();
  mockFailRename = false;
});
afterEach(async () => {
  await drainActivationJourneyWrites();
  jest.restoreAllMocks();
  resetActivationJourneyStateForTests();
  await fs.rm(mockRoot, { recursive: true, force: true });
});

async function seed(value: unknown): Promise<void> {
  await fs.writeFile(
    join(mockRoot, 'onboarding-checklist.json'),
    JSON.stringify(value),
  );
}

it('atomically merges only known completions with concurrent independent mutations', async () => {
  await seed(legacy);
  await Promise.all([
    migrateLegacyChecklistSignals(),
    migrateLegacyChecklistSignals(),
    latchActivationSignal('mobile-paired', AT),
    latchCampaignSent('activation-mobile', AT),
  ]);
  await drainActivationJourneyWrites();
  const state = await readActivationJourneyState();
  expect(state.signals).toEqual({
    'first-task-submitted': AT,
    'tool-connected': AT,
    'capability-installed': AT,
    'mobile-paired': AT,
  });
  expect(state.legacyChecklistMigrationVersion).toBe(1);
  const disk: unknown = JSON.parse(
    await fs.readFile(join(mockRoot, 'activation-journey.json'), 'utf8'),
  );
  expect(disk).toHaveProperty('signals', state.signals);
  expect(disk).toHaveProperty('legacyChecklistMigrationVersion', 1);
  expect(disk).toHaveProperty(['campaigns', 'activation-mobile', 'sentAt'], AT);
  expect(
    JSON.parse(
      await fs.readFile(join(mockRoot, 'onboarding-checklist.json'), 'utf8'),
    ),
  ).toEqual(legacy);
});

it('does not reread processed history and preserves first observations across restart', async () => {
  await seed(legacy);
  const earlier = '2026-10-19T00:00:00.000Z';
  await latchActivationSignal('first-task-submitted', earlier);
  await migrateLegacyChecklistSignals();
  await drainActivationJourneyWrites();
  await fs.writeFile(join(mockRoot, 'onboarding-checklist.json'), '{broken');
  resetActivationJourneyStateForTests();
  await migrateLegacyChecklistSignals();
  expect(
    (await readActivationJourneyState()).signals['first-task-submitted'],
  ).toBe(earlier);
  await recordActivity(AT);
  await drainActivationJourneyWrites();
  expect(
    JSON.parse(
      await fs.readFile(join(mockRoot, 'activation-journey.json'), 'utf8'),
    ),
  ).toHaveProperty('legacyChecklistMigrationVersion', 1);
});

it('marks a missing file complete without inventing activation', async () => {
  await migrateLegacyChecklistSignals();
  expect(await readActivationJourneyState()).toMatchObject({
    legacyChecklistMigrationVersion: 1,
    signals: {},
  });
});

it.each([
  '{bad',
  JSON.stringify({ version: 2, completedItems: {} }),
  'null',
  '[]',
  JSON.stringify({ version: 1, completedItems: [] }),
  'x'.repeat(65537),
])('leaves unreadable or unsupported data retryable', async (raw) => {
  await fs.writeFile(join(mockRoot, 'onboarding-checklist.json'), raw);
  await expect(migrateLegacyChecklistSignals()).rejects.toThrow();
  expect(
    (await readActivationJourneyState()).legacyChecklistMigrationVersion,
  ).toBeUndefined();
  await seed(legacy);
  await expect(migrateLegacyChecklistSignals()).resolves.toBeUndefined();
});

it('retries I/O errors instead of treating them as a missing file', async () => {
  await fs.mkdir(join(mockRoot, 'onboarding-checklist.json'));
  await expect(migrateLegacyChecklistSignals()).rejects.toThrow();
  expect(
    (await readActivationJourneyState()).legacyChecklistMigrationVersion,
  ).toBeUndefined();
  await fs.rmdir(join(mockRoot, 'onboarding-checklist.json'));
  await seed(legacy);
  await migrateLegacyChecklistSignals();
});

it('drops invalid timestamps and does not treat provider opt-outs as activation', async () => {
  await seed({
    ...legacy,
    completedItems: {
      'start-chat': 'invalid',
      'connect-accounts': null,
      'add-capability': [],
    },
  });
  await migrateLegacyChecklistSignals();
  expect((await readActivationJourneyState()).signals).toEqual({});
});

it('keeps suppression safe after a failed atomic write, retries on mutation and rereads after restart', async () => {
  await seed(legacy);
  mockFailRename = true;
  await migrateLegacyChecklistSignals();
  await drainActivationJourneyWrites();
  expect(
    (await readActivationJourneyState()).signals['capability-installed'],
  ).toBe(AT);
  await expect(
    fs.readFile(join(mockRoot, 'activation-journey.json')),
  ).rejects.toThrow();
  resetActivationJourneyStateForTests();
  await migrateLegacyChecklistSignals();
  await drainActivationJourneyWrites();
  mockFailRename = false;
  await recordActivity(AT);
  await drainActivationJourneyWrites();
  resetActivationJourneyStateForTests();
  await fs.writeFile(join(mockRoot, 'onboarding-checklist.json'), '{bad');
  await expect(migrateLegacyChecklistSignals()).resolves.toBeUndefined();
});

it('preserves the daily cap from recent legacy sends across ordinary saves and restart', async () => {
  await fs.writeFile(
    join(mockRoot, 'activation-journey.json'),
    JSON.stringify({
      version: 1,
      gettingStarted: {
        steps: { 'start-chat': { sentAt: AT, clickedAt: AT } },
      },
    }),
  );
  await recordActivity(AT);
  await drainActivationJourneyWrites();
  resetActivationJourneyStateForTests();
  const state = await readActivationJourneyState();
  const lifts = resolvePromotionalCapLiftsAt(state);
  expect(lifts).toBe(Date.parse(AT) + 86400000);
  expect(Date.parse(AT) + 3600000).toBeLessThan(lifts ?? 0);
  expect(Date.parse(AT) + 2 * 86400000).toBeGreaterThan(lifts ?? 0);
  expect(state.gettingStarted).toEqual({
    steps: { 'start-chat': { sentAt: AT } },
  });
});
