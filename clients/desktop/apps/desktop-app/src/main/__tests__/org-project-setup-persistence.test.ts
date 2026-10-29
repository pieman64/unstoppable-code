import {
  readOrgProjectLinks,
  writeOrgProjectLinks,
  dismissOrgProjectLink,
} from '../lib/org-project-links';
import type * as Paths from '../lib/paths';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildOrgProjectCloneUrl } from '../lib/org-project-clone-url';
import {
  readInstallationGeneration,
  bumpInstallationGeneration,
} from '../lib/installation-generation';
import {
  normalizeSetupJournal,
  parseOrgProjectSetupPause,
} from '../lib/org-project-setup-journal';
import { normalizePreferences } from '../lib/preferences-store';
import type { OrgProjectRepository } from '@canopy/protocol/org-projects';
let mockRoot: string;
jest.mock('../lib/paths', () => ({
  ...jest.requireActual<typeof Paths>('../lib/paths'),
  getOrgProjectLinksFilePath: (): string =>
    join(mockRoot, 'nested', 'org-project-links.json'),
  getInstallationGenerationFilePath: (): string =>
    join(mockRoot, 'installation-generation.json'),
}));
const repository: OrgProjectRepository = {
  provider: 'github',
  host: 'github.example.com',
  owner: 'team',
  name: 'repo',
  defaultBranch: 'main',
  providerRepoId: null,
  verification: 'VERIFIED',
};
beforeEach(async (): Promise<void> => {
  mockRoot = await mkdtemp(join(tmpdir(), 'setup-persistence-'));
});
afterEach(async (): Promise<void> => {
  await rm(mockRoot, { recursive: true, force: true });
});
it('creates generation zero, detects device replacement, and serializes bumps', async (): Promise<void> => {
  expect(await readInstallationGeneration('first')).toBe(0);
  expect(await readInstallationGeneration('first')).toBe(0);
  expect(await readInstallationGeneration('second')).toBe(1);
  expect(
    await Promise.all([
      bumpInstallationGeneration(),
      bumpInstallationGeneration(),
    ]),
  ).toEqual([2, 3]);
  expect(
    JSON.parse(
      await readFile(join(mockRoot, 'installation-generation.json'), 'utf8'),
    ),
  ).toEqual({ version: 1, generation: 3, deviceId: 'second' });
});
it('recovers from a corrupt generation without ever reusing zero', async (): Promise<void> => {
  // Rethrowing left setup impossible until the file was deleted by hand, and
  // nothing in the app said so. Reusing zero is equally wrong: the server may
  // hold an instance recorded under generation zero for this device. So the
  // device takes a generation it demonstrably has not used.
  await writeFile(join(mockRoot, 'installation-generation.json'), '{');
  const generation = await readInstallationGeneration('device');
  expect(generation).toBeGreaterThan(0);
  // The server stores this in a 32-bit signed column and rejects anything
  // larger, so a fallback that does not fit is a 400, not a recovery.
  expect(generation).toBeLessThanOrEqual(2147483647);
  // And it sticks: the next read does not keep inventing new ones.
  await expect(readInstallationGeneration('device')).resolves.toBe(generation);
});
it('builds token-free https and ssh URLs and a local fixture URL', (): void => {
  expect(buildOrgProjectCloneUrl(repository, 'https')).toBe(
    'https://github.example.com/team/repo.git',
  );
  expect(buildOrgProjectCloneUrl(repository, 'ssh')).toBe(
    'git@github.example.com:team/repo.git',
  );
  expect(
    buildOrgProjectCloneUrl(repository, 'https', 'file:///fixtures/'),
  ).toBe('file:///fixtures/team/repo.git');
  expect(buildOrgProjectCloneUrl(repository, 'ssh', '/fixtures')).toBe(
    '/fixtures/team/repo.git',
  );
  expect(() =>
    buildOrgProjectCloneUrl(
      { ...repository, host: 'token@github.com' },
      'https',
    ),
  ).toThrow();
  expect(() =>
    buildOrgProjectCloneUrl(repository, 'https', 'https://example.com'),
  ).toThrow();
});
const operationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
/** The smallest journal that passes, so rejections can be shown one at a time. */
const validJournal = {
  version: 1,
  projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  organizationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  operationId,
  idempotencyKey: 'a'.repeat(64),
  attemptNonce: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  fencingGeneration: 1,
  localWorkspaceId: 'repo',
  destinationRoot: '/destination',
  finalPath: '/destination/repo',
  stagingPath: `/destination/.canopy-setup-${operationId}`,
  phase: 'claimed',
  updatedAt: new Date().toISOString(),
};

it('normalizes hidden preferences and rejects malformed journals', (): void => {
  expect(
    normalizePreferences({
      orgProjectDefaultDestinationRoot: ' /repos ',
      orgProjectCloneProtocol: 'ssh',
    }),
  ).toMatchObject({
    orgProjectDefaultDestinationRoot: '/repos',
    orgProjectCloneProtocol: 'ssh',
  });
  expect(normalizePreferences({}).orgProjectCloneProtocol).toBe('https');
  expect(
    normalizeSetupJournal({ version: 1, operationId: '../escape' }),
  ).toBeNull();
  // `dirname('/root/..')` is '/root', so a lexical parent check alone would
  // accept a final path the filesystem resolves to the root's parent.
  expect(
    normalizeSetupJournal({ ...validJournal, finalPath: '/destination/..' }),
  ).toBeNull();
  expect(
    normalizeSetupJournal({
      ...validJournal,
      finalPath: '/destination/./repo',
    }),
  ).toBeNull();
  expect(normalizeSetupJournal(validJournal)).not.toBeNull();
});

it('names a journal by its own id, which a reclaim never changes (CAN-3129)', (): void => {
  const journalId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  const reclaimed = {
    ...validJournal,
    journalId,
    // A reclaim replaced the claim this journal was created under.
    operationId: '12121212-1212-4212-8212-121212121212',
    fencingGeneration: 2,
    stagingPath: `/destination/.canopy-setup-${journalId}`,
    phase: 'reclaiming',
    errorCode: 'claim-expired',
  };
  expect(normalizeSetupJournal(reclaimed)).toMatchObject({
    journalId,
    operationId: reclaimed.operationId,
    phase: 'reclaiming',
  });
  // Written before the field existed: its file and staging directory were
  // named after the operation, which is therefore its identity.
  expect(normalizeSetupJournal(validJournal)).toMatchObject({
    journalId: operationId,
  });
  expect(
    normalizeSetupJournal({ ...reclaimed, journalId: '../escape' }),
  ).toBeNull();
  // Staging is derived from the journal's identity, not the operation's.
  expect(
    normalizeSetupJournal({
      ...reclaimed,
      stagingPath: `/destination/.canopy-setup-${reclaimed.operationId}`,
    }),
  ).toBeNull();
});

it('normalizes relationship decisions on write and read and isolates accounts', async (): Promise<void> => {
  await writeOrgProjectLinks({
    version: 1,
    byAccount: {
      first: {
        'project:personal': 'dismissed',
        'bad/key': 'dismissed',
        'other:personal': 'view',
      },
      second: { 'project:personal': 'dismissed' },
      invalid: [],
    },
  });
  const expected = {
    version: 1,
    byAccount: {
      first: { 'project:personal': 'dismissed' },
      second: { 'project:personal': 'dismissed' },
    },
  };
  expect(await readOrgProjectLinks()).toEqual(expected);
  const file = join(mockRoot, 'nested', 'org-project-links.json');
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(expected);
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      byAccount: { first: { 'project:personal': 'dismissed', junk: true } },
    }),
  );
  expect(await readOrgProjectLinks()).toEqual({
    version: 1,
    byAccount: { first: { 'project:personal': 'dismissed' } },
  });
  await dismissOrgProjectLink('second', 'another', 'personal');
  expect(await readOrgProjectLinks()).toEqual({
    version: 1,
    byAccount: {
      first: { 'project:personal': 'dismissed' },
      second: { 'another:personal': 'dismissed' },
    },
  });
});
it('silently recovers missing and corrupt relationship files', async (): Promise<void> => {
  expect(await readOrgProjectLinks()).toEqual({ version: 1, byAccount: {} });
  await writeOrgProjectLinks({ version: 1, byAccount: {} });
  await writeFile(join(mockRoot, 'nested', 'org-project-links.json'), '{');
  expect(await readOrgProjectLinks()).toEqual({ version: 1, byAccount: {} });
});
it('serializes simultaneous decisions without losing another account', async (): Promise<void> => {
  await Promise.all([
    dismissOrgProjectLink('first', 'project', 'personal'),
    dismissOrgProjectLink('second', 'project', 'personal'),
  ]);
  expect(await readOrgProjectLinks()).toEqual({
    version: 1,
    byAccount: {
      first: { 'project:personal': 'dismissed' },
      second: { 'project:personal': 'dismissed' },
    },
  });
});

it('advances a restored installation beyond the server collision floor', async (): Promise<void> => {
  await readInstallationGeneration('restored');
  await expect(bumpInstallationGeneration(20)).resolves.toBe(20);
  await expect(readInstallationGeneration('restored')).resolves.toBe(20);
  await expect(bumpInstallationGeneration(10)).resolves.toBe(21);
});

it('reads the QA pause only as a known phase and a bounded number of seconds', (): void => {
  expect(parseOrgProjectSetupPause('completing:90')).toEqual({
    phase: 'completing',
    ms: 90_000,
  });
  expect(parseOrgProjectSetupPause(' bound:5 ')).toEqual({
    phase: 'bound',
    ms: 5_000,
  });
  for (const value of [
    undefined,
    '',
    'completing',
    'nonsense:5',
    'completing:-1',
    'completing:99999',
  ])
    expect(parseOrgProjectSetupPause(value)).toBeNull();
});
