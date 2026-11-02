// W6f2: host admission and ordered plain-data decisions through fake X3/X4.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';

jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../git', () => ({
  initGitRepo: jest.fn(() => Promise.resolve()),
  stageAllChanges: jest.fn(() => Promise.resolve()),
  commitWithLocalIdentity: jest.fn(() => Promise.resolve()),
  getRemoteUrl: jest.fn(() => Promise.resolve(null)),
  getRepoRootFromWorktree: jest.fn((path: string) => Promise.resolve(path)),
}));
jest.mock('../workspace-record-decision-port', () => ({
  applyWorkspaceManifestDecision: jest.fn(() => Promise.resolve()),
  applyWorkspaceIndexDecision: jest.fn(() => Promise.resolve()),
}));
import { initializeWorkspaceSourceRepo } from '../workspace-source-control';
import { convertWorkspaceType } from '../workspace-type-conversion';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { WorkspaceConfigUnreadableError } from '../workspace-persistence';
import {
  getPrimaryProjectConfigFilePath,
  getProjectConfigFileCandidates,
} from '../canopy-json';
import {
  applyWorkspaceManifestDecision,
  applyWorkspaceIndexDecision,
} from '../workspace-record-decision-port';
import type { W5RecordDecisionPort } from '../worktree-record-decisions';

const fake: Pick<
  W5RecordDecisionPort,
  'applyWorkspaceManifestDecision' | 'applyWorkspaceIndexDecision'
> = {
  applyWorkspaceManifestDecision,
  applyWorkspaceIndexDecision,
};
let dir: string;
let root: string;
let repo: string;
let originalDataDir: string | undefined;
const events: unknown[] = [];
beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  jest.clearAllMocks();
  events.length = 0;
  jest
    .mocked(fake.applyWorkspaceManifestDecision)
    .mockImplementation((id, decision) => {
      events.push(JSON.parse(JSON.stringify([id, decision])));
      return Promise.resolve();
    });
  jest
    .mocked(fake.applyWorkspaceIndexDecision)
    .mockImplementation((decision) => {
      events.push(JSON.parse(JSON.stringify(decision)));
      return Promise.resolve();
    });
});
afterEach(() => {
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});
const sourceRequest = {
  workspaceId: 'a',
  source: 'workspace_settings',
} as const;
const conversionRequest = {
  ...sourceRequest,
  targetType: 'multi-repo',
  claudeMdMode: 'unchanged',
} as const;
function multiRepo(): void {
  writeFileSync(
    join(root, 'a/workspace.json'),
    JSON.stringify({ version: 1, type: 'multi-repo', repos: [] }),
  );
}
it('routes conversion index then manifest only after repository effects and encodes cleared fields', async () => {
  const before = readFileSync(join(root, 'a/workspace.json'), 'utf8');
  await convertWorkspaceType(conversionRequest);
  const cleared: unknown = expect.arrayContaining([
    'repoPath',
    'hooks',
    'scripts',
    'owner',
    'temporary',
  ]);
  expect(events).toEqual([
    {
      kind: 'workspace.conversion.index',
      workspaceId: 'a',
      type: 'multi-repo',
    },
    [
      'a',
      {
        kind: 'workspace.conversion.manifest',
        config: {
          version: 1,
          type: 'multi-repo',
          repos: [],
          sourceRepoPath: repo,
          itemSortMode: 'manual',
        },
        clear: cleared,
      },
    ],
  ]);
  expect(readFileSync(getPrimaryProjectConfigFilePath(repo), 'utf8')).toContain(
    '"repos": []',
  );
  expect(readFileSync(join(root, 'a/workspace.json'), 'utf8')).toBe(before);
});
it('routes source initialization after provisioning, without a receipt decision in the record port', async () => {
  multiRepo();
  const result = await initializeWorkspaceSourceRepo(sourceRequest);
  expect(events).toEqual([
    [
      'a',
      {
        kind: 'workspace.source.initialize',
        repositories: [],
        sourceRepoPath: result.sourceRepoPath,
      },
    ],
  ]);
  expect(
    existsSync(getPrimaryProjectConfigFilePath(result.sourceRepoPath)),
  ).toBe(true);
});
it.each(['source', 'conversion'] as const)(
  'refuses missing %s before the port or repository effects',
  async (kind) => {
    rmSync(join(root, 'a/workspace.json'));
    const pending =
      kind === 'source'
        ? initializeWorkspaceSourceRepo(sourceRequest)
        : convertWorkspaceType(conversionRequest);
    await expect(pending).rejects.toMatchObject({ reason: 'not-found' });
    expect(events).toEqual([]);
    expect(
      getProjectConfigFileCandidates(repo).filter((path) => existsSync(path)),
    ).toEqual([]);
  },
);
it('preserves the source unreadable-record translation and keeps the provisioned folder', async () => {
  multiRepo();
  jest
    .mocked(fake.applyWorkspaceManifestDecision)
    .mockRejectedValueOnce(new WorkspaceConfigUnreadableError());
  await expect(
    initializeWorkspaceSourceRepo(sourceRequest),
  ).rejects.toMatchObject({
    name: 'WorkspaceSourceRepoRefusedError',
    reason: 'configuration-unavailable',
  });
  expect(
    existsSync(
      getPrimaryProjectConfigFilePath(join(dir, 'data/repos/original')),
    ),
  ).toBe(true);
});
it('propagates a conversion port failure after effects without attempting its manifest decision', async () => {
  const error = new Error('write failed');
  jest.mocked(fake.applyWorkspaceIndexDecision).mockRejectedValueOnce(error);
  await expect(convertWorkspaceType(conversionRequest)).rejects.toBe(error);
  expect(fake.applyWorkspaceManifestDecision).not.toHaveBeenCalled();
  expect(existsSync(getPrimaryProjectConfigFilePath(repo))).toBe(true);
});
