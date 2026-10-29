import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkEntry,
  readWorkEntriesFile,
} from '../lib/cowork-work-entries';
import {
  initializeSidebarItemGroups,
  sidebarItemGroupsService,
} from '../services/sidebar-item-groups-service';

let dataDir = '';
const previousDataDir = process.env.CANOPY_DATA_DIR;

beforeAll(() => initializeSidebarItemGroups());

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'app-advisor-prompt-groups-'));
  process.env.CANOPY_DATA_DIR = dataDir;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = previousDataDir;
});

it('uses the actual same-id reused App Advisor Work Entry for group assignment', async () => {
  const created = await createWorkEntry('app-advisor', {
    id: 'quick-prompt-entry',
    title: 'Review application',
  });
  const reused = await createWorkEntry('app-advisor', {
    id: 'quick-prompt-entry',
    title: 'Review application',
  });
  expect(reused.reusedExistingEmpty).toBe(true);

  const { group: createdGroup } =
    await sidebarItemGroupsService.assignItemToNamedGroup({
      scope: { appAdvisor: true },
      itemId: created.entry.id,
      name: 'Reviews',
    });
  const { group: reusedAssignment } =
    await sidebarItemGroupsService.assignItemToNamedGroup({
      scope: { appAdvisor: true },
      itemId: reused.entry.id,
      name: ' reviews ',
    });

  expect(reused.entry.id).toBe('quick-prompt-entry');
  expect(reusedAssignment).toMatchObject({
    id: createdGroup.id,
    name: 'Reviews',
    memberIds: ['quick-prompt-entry'],
  });
  expect((await readWorkEntriesFile('app-advisor')).entries).toHaveLength(1);
});
