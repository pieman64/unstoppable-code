import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';

jest.mock('../shared-containers/run-env-store', () => ({
  readSharedContainerRunEnvironment: jest.fn(() => Promise.resolve([])),
}));

import { getSharedContainerRunRepoDir } from '../lib/paths';
import { resolveScriptExecutionPlace } from '../lib/script-execution-place';

describe('shared-container script places', () => {
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  let dataDir = '';

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'script-place-data-'));
    process.env.CANOPY_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  it('runs a single-repository container in its workspace-root run copy', async () => {
    const cwd = getSharedContainerRunRepoDir(
      'container-1',
      WORKSPACE_ROOT_REPO_ID,
    );
    await mkdir(cwd, { recursive: true });

    const place = await resolveScriptExecutionPlace(
      {
        workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
        worktreeId: 'container-1',
      },
      {
        kind: 'shared-container',
        repoId: WORKSPACE_ROOT_REPO_ID,
        environmentKeys: [],
      },
    );

    expect(place.cwd).toBe(cwd);
  });

  it('refuses a repository ID that cannot name a run copy', async () => {
    await expect(
      resolveScriptExecutionPlace(
        {
          workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
          worktreeId: 'container-1',
        },
        { kind: 'shared-container', repoId: '../escape', environmentKeys: [] },
      ),
    ).rejects.toMatchObject({
      payload: { code: 'worker.script.contextUnavailable' },
    });
  });
});
