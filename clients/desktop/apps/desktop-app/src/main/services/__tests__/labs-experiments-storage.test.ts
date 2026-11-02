import { migrateExtractedLabsChoices } from '@canopy/protocol/experiments';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LabsAvailabilityState } from '../../feature-flags/labs-availability';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { LABS_EXPERIMENTS } from '@canopy/desktop-shared/lib/labs-experiments';
import {
  LabsExperimentsService,
  labsExperimentRegistry,
  labsExperimentStorageDependencies,
} from '../labs-experiments-service';

const key = CLIENT_FEATURE_FLAGS.canopyDesktopLabsEarlyAccess.key;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'canopy-labs-storage-'));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it.each([
  '{',
  '{"version":2,"accounts":{"local":{"early-access":true}}}',
  '{"version":1,"accounts":{"local":{"early-access":"true"}}}',
  ' '.repeat(512 * 1024 + 1),
])('ignores corrupt, unsupported and oversized disk choices', (contents) => {
  const storage = labsExperimentStorageDependencies();
  const choicesPath = join(directory, 'choices.json');
  writeFileSync(choicesPath, contents);
  const service = new LabsExperimentsService(
    {
      ...storage,
      choicesPath,
      pendingSyncPath: join(directory, 'pending-sync.json'),
      availabilityPath: join(directory, 'availability.json'),
      availability: (): LabsAvailabilityState => ({
        snapshot: getDefaultFeatureFlagSnapshot('not_configured'),
        contextIdentity: null,
        liveValues: {},
      }),
      fetchChoices: jest.fn(),
      putChoice: jest.fn(),
      diagnostic: jest.fn(),
      mirror: jest.fn(),
    },
    { scope: 'local', signedIn: false, ready: true },
  );
  expect(service.getSnapshot().earlyAccessEnabled).toBe(false);
});

it('durably writes nested canonical-format choices and restores them after restart', async () => {
  const storage = labsExperimentStorageDependencies();
  const choicesPath = join(directory, 'nested', 'choices.json');
  const dependencies = {
    ...storage,
    choicesPath,
    pendingSyncPath: join(directory, 'pending-sync.json'),
    availabilityPath: join(directory, 'availability.json'),
    availability: (): LabsAvailabilityState => ({
      snapshot: getDefaultFeatureFlagSnapshot('not_configured'),
      contextIdentity: null,
      liveValues: {},
    }),
    fetchChoices: jest.fn(),
    putChoice: jest.fn(),
    diagnostic: jest.fn(),
    mirror: jest.fn(),
  };
  const session = { scope: 'local', signedIn: false, ready: true };
  const first = new LabsExperimentsService(dependencies, session);
  await first.setChoice({ experimentId: 'early-access', enabled: true });
  await first.flush();
  expect(storage.read(choicesPath)).toEqual({
    version: 1,
    accounts: {
      local: { ...migrateExtractedLabsChoices({}), 'early-access': true },
    },
  });
  expect(
    new LabsExperimentsService(dependencies, session).getSnapshot()
      .earlyAccessEnabled,
  ).toBe(true);
});

it('bounds cached contexts and never stores malformed live availability', async () => {
  const storage = labsExperimentStorageDependencies();
  const availabilityPath = join(directory, 'availability.json');
  writeFileSync(
    availabilityPath,
    JSON.stringify({
      version: 1,
      contexts: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [
          index.toString(16).padStart(64, '0'),
          { [key]: 'on' },
        ]),
      ),
    }),
  );
  let live: unknown = 'hidden';
  const service = new LabsExperimentsService(
    {
      ...storage,
      choicesPath: join(directory, 'choices.json'),
      availabilityPath,
      availability: (): LabsAvailabilityState => ({
        snapshot: getDefaultFeatureFlagSnapshot('error'),
        contextIdentity: 'f'.repeat(64),
        liveValues: { [key]: live },
      }),
      fetchChoices: jest.fn(),
      putChoice: jest.fn(),
      diagnostic: jest.fn(),
      mirror: jest.fn(),
    },
    { scope: 'local', signedIn: false, ready: true },
  );
  service.availabilityChanged();
  await service.flush();
  const saved = storage.read(availabilityPath);
  expect(saved).toMatchObject({
    version: 1,
    contexts: { ['f'.repeat(64)]: { [key]: 'hidden' } },
  });
  expect(
    saved && typeof saved === 'object' && 'contexts' in saved
      ? Object.keys(saved.contexts ?? {})
      : [],
  ).toHaveLength(32);
  live = 'bad';
  service.availabilityChanged();
  await service.flush();
  expect(storage.read(availabilityPath)).toEqual(saved);
});

it('excludes fixture loading in production even when the fixture environment is malformed', () => {
  const previous = process.env.CANOPY_E2E_LABS_EXPERIMENTS;
  process.env.CANOPY_E2E_LABS_EXPERIMENTS = '{';
  Object.assign(globalThis, { __CANOPY_E2E__: false });
  try {
    expect(labsExperimentRegistry().map((entry) => entry.id)).toEqual(
      LABS_EXPERIMENTS.map((entry) => entry.id),
    );
    Object.assign(globalThis, { __CANOPY_E2E__: true });
    expect(() => labsExperimentRegistry()).toThrow();
  } finally {
    Object.assign(globalThis, { __CANOPY_E2E__: false });
    if (previous === undefined) delete process.env.CANOPY_E2E_LABS_EXPERIMENTS;
    else process.env.CANOPY_E2E_LABS_EXPERIMENTS = previous;
  }
});
