jest.mock('../../node/lib/workspace-service', () => ({
  getWorkspaceItem: jest.fn(),
}));

jest.mock('../../node/lib/worktree-service', () => ({
  createMultiRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
  getWorktreeCliRecord: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getWorkspaceItem } from '../../node/lib/workspace-service';
import {
  createMultiRepoWorktree,
  createSingleRepoWorktree,
  getWorktreeCliRecord,
} from '../../node/lib/worktree-service';
import { runCreateWorktreeAction } from '../create-worktree/runner';

const mockedGetWorkspaceItem = jest.mocked(getWorkspaceItem);
const mockedCreateMultiRepoWorktree = jest.mocked(createMultiRepoWorktree);
const mockedCreateSingleRepoWorktree = jest.mocked(createSingleRepoWorktree);
const mockedGetWorktreeCliRecord = jest.mocked(getWorktreeCliRecord);

function readOutputs(filePath: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe('create-worktree action', () => {
  let tempDir: string;
  let outputFile: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-create-wt-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
    mockedGetWorktreeCliRecord.mockResolvedValue({
      workspaceId: 'ws1',
      workspaceName: 'Workspace',
      workspaceType: 'multi-repo',
      id: 'feature-x',
      branchName: 'feature/x',
      createdAt: '2026-06-20T12:00:00.000Z',
      path: path.join(tempDir, 'worktrees', 'feature-x'),
      stats: { insertions: 0, deletions: 0 },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates a multi-repo project worktree and emits the created id', async () => {
    mockedGetWorkspaceItem.mockResolvedValue({
      id: 'ws1',
      type: 'multi-repo',
      name: 'Workspace',
    } as never);
    mockedCreateMultiRepoWorktree.mockResolvedValue({
      id: 'feature-x',
      branchName: 'feature/x',
      createdAt: '2026-06-20T12:00:00.000Z',
    });

    await runCreateWorktreeAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_WORKSPACE_ID: 'ws1',
      INPUT_BRANCH: 'feature/x',
      INPUT_BASE_BRANCH: 'main',
      INPUT_REPAIR: 'true',
      INPUT_RESTORE_CLAUDE_MD: 'false',
    });

    expect(mockedCreateMultiRepoWorktree).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      branchName: 'feature/x',
      baseBranch: 'main',
      repairWorkspaceRoot: true,
      restoreClaudeMd: false,
      startPostCreateSetup: false,
    });
    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedGetWorktreeCliRecord).toHaveBeenCalledWith('ws1', 'feature-x');

    expect(readOutputs(outputFile)).toEqual({
      worktree_id: 'feature-x',
      workspace_id: 'ws1',
      path: path.join(tempDir, 'worktrees', 'feature-x'),
      branch_name: 'feature/x',
      created_at: '2026-06-20T12:00:00.000Z',
    });
  });

  it('creates a single-repo project worktree without multi-repo repair inputs', async () => {
    mockedGetWorkspaceItem.mockResolvedValue({
      id: 'ws1',
      type: 'single-repo',
      name: 'Workspace',
    } as never);
    mockedCreateSingleRepoWorktree.mockResolvedValue({
      id: 'feature-x',
      branchName: 'feature/x',
      createdAt: '2026-06-20T12:00:00.000Z',
    });

    await runCreateWorktreeAction({
      CANOPY_OUTPUT: outputFile,
      INPUT_WORKSPACE_ID: 'ws1',
      INPUT_BRANCH: 'feature/x',
      INPUT_BASE_BRANCH: 'main',
      INPUT_REPAIR: 'true',
      INPUT_RESTORE_CLAUDE_MD: 'false',
    });

    expect(mockedCreateSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      branchName: 'feature/x',
      baseBranch: 'main',
      startPostCreateSetup: false,
    });
    expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
  });

  it('rejects missing workspace_id and invalid boolean inputs', async () => {
    await expect(
      runCreateWorktreeAction({ CANOPY_OUTPUT: outputFile }),
    ).rejects.toThrow('create-worktree requires input "workspace_id"');

    await expect(
      runCreateWorktreeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_WORKSPACE_ID: 'ws1',
        INPUT_REPAIR: 'yes',
      }),
    ).rejects.toThrow('create-worktree input "repair" must be true or false');
  });
});
