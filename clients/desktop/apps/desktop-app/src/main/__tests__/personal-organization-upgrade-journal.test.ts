import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalOrganizationUpgradeJournal } from '../lib/personal-organization-upgrade-journal';
import type { PersonalProjectOperation } from '@canopy/protocol/organizations';
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'can3706-journal-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const operation: PersonalProjectOperation = {
  operationId: '11111111-1111-4111-8111-111111111111',
  accountId: 'account-a',
  organizationId: '22222222-2222-4222-8222-222222222222',
  selection: ['repo'],
  projects: [{ workspaceId: 'repo', stage: 'queued', outcome: 'pending' }],
  updatedAt: '2026-10-08T00:00:00.000Z',
};
it('refuses a well-formed journal whose stages expand the authorized selection', async (): Promise<void> => {
  const path = join(directory, 'journal.json');
  const store = createPersonalOrganizationUpgradeJournal(() => path);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      operations: [
        {
          ...operation,
          projects: [
            ...operation.projects,
            { workspaceId: 'unticked', stage: 'queued', outcome: 'pending' },
          ],
        },
      ],
    }),
  );
  await expect(store.read()).rejects.toThrow('unreadable');
  await expect(store.update(operation)).rejects.toThrow('unreadable');
});
it('serializes concurrent account-scoped updates and retains active operations', async () => {
  const store = createPersonalOrganizationUpgradeJournal(() =>
    join(directory, 'journal.json'),
  );
  expect(await store.read()).toEqual([]);
  await Promise.all([
    store.update(operation),
    store.update({ ...operation, accountId: 'account-b' }),
  ]);
  expect((await store.read()).map((entry) => entry.accountId)).toEqual([
    'account-a',
    'account-b',
  ]);
});
it('does not overwrite corrupt persistence or restart a selection from guesses', async () => {
  const path = join(directory, 'journal.json');
  await writeFile(path, '{');
  const store = createPersonalOrganizationUpgradeJournal(() => path);
  await expect(store.read()).rejects.toThrow();
  await expect(store.update(operation)).rejects.toThrow();
});

it('merges simultaneous writes from independent journal instances', async () => {
  const path = (): string => join(directory, 'journal.json');
  const first = createPersonalOrganizationUpgradeJournal(path);
  const second = createPersonalOrganizationUpgradeJournal(path);
  await Promise.all([
    first.update(operation),
    second.update({ ...operation, accountId: 'account-b' }),
  ]);
  expect((await first.read()).map((entry) => entry.accountId).sort()).toEqual([
    'account-a',
    'account-b',
  ]);
});
