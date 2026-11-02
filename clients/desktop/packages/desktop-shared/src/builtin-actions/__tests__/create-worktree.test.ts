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
import { emptyCreateWorktreeOutputs } from '../../pipelines/host-create-worktree';
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
      stats: {
        projectId: 'project-id',
        worktreeId: 'feature-x',
        insertions: 0,
        deletions: 0,
      },
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
      ...emptyCreateWorktreeOutputs(),
      project_id: 'ws1',
      workspace_id: 'ws1',
      task_id: 'feature-x',
      worktree_id: 'feature-x',
      path: path.join(tempDir, 'worktrees', 'feature-x'),
      branch_name: 'feature/x',
      created_at: '2026-06-20T12:00:00.000Z',
      setup_state: 'skipped',
      failure_reason: '',
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

  it('accepts project_id in place of workspace_id', async () => {
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
      INPUT_PROJECT_ID: 'ws1',
      INPUT_WORKTREE_SETUP: 'skip',
    });

    expect(mockedGetWorkspaceItem).toHaveBeenCalledWith('ws1');
    expect(mockedCreateSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: 'ws1',
      branchName: undefined,
      baseBranch: undefined,
      startPostCreateSetup: false,
    });
    expect(readOutputs(outputFile)).toMatchObject({
      project_id: 'ws1',
      workspace_id: 'ws1',
      task_id: 'feature-x',
      worktree_id: 'feature-x',
      failure_reason: '',
    });
  });

  it('rejects invalid inputs with validation_failed before any read', async () => {
    await expect(
      runCreateWorktreeAction({ CANOPY_OUTPUT: outputFile }),
    ).rejects.toThrow(
      'create-worktree requires "project_id" or "workspace_id"',
    );
    expect(readOutputs(outputFile)).toMatchObject({
      failure_reason: 'validation_failed',
      task_id: '',
      grouped: 'false',
    });

    await expect(
      runCreateWorktreeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_WORKSPACE_ID: 'ws1',
        INPUT_REPAIR: 'yes',
      }),
    ).rejects.toThrow('create-worktree input "repair" must be true or false');
    await expect(
      runCreateWorktreeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_WORKSPACE_ID: '../ws1',
      }),
    ).rejects.toThrow(
      'create-worktree "workspace_id" must be lowercase alphanumeric with hyphens',
    );
    expect(mockedGetWorkspaceItem).not.toHaveBeenCalled();
  });

  it.each([
    ['existing_branch', { INPUT_EXISTING_BRANCH: 'release' }],
    ['base_task_id', { INPUT_BASE_TASK_ID: 'wt-1' }],
    ['base_worktree_id', { INPUT_BASE_WORKTREE_ID: 'wt-1' }],
    ['group', { INPUT_GROUP: 'Reviews' }],
    ['worktree_setup', { INPUT_WORKTREE_SETUP: 'run' }],
    ['worktree_setup', { INPUT_WORKTREE_SETUP: 'run_and_wait' }],
  ])(
    'refuses %s with needs_desktop before reading the workspace',
    async (input, extra) => {
      await expect(
        runCreateWorktreeAction({
          CANOPY_OUTPUT: outputFile,
          INPUT_WORKSPACE_ID: 'ws1',
          ...extra,
        }),
      ).rejects.toThrow(`create-worktree "${input}" needs the desktop app.`);
      expect(readOutputs(outputFile)).toMatchObject({
        failure_reason: 'needs_desktop',
        task_id: '',
      });
      expect(mockedGetWorkspaceItem).not.toHaveBeenCalled();
      expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
      expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
    },
  );

  it('names the first desktop-only input in the documented order', async () => {
    await expect(
      runCreateWorktreeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_WORKSPACE_ID: 'ws1',
        INPUT_WORKTREE_SETUP: 'run',
        INPUT_GROUP: 'Reviews',
        INPUT_BASE_TASK_ID: 'wt-1',
      }),
    ).rejects.toThrow('create-worktree "base_task_id" needs the desktop app.');
    await expect(
      runCreateWorktreeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_WORKSPACE_ID: 'ws1',
        INPUT_WORKTREE_SETUP: 'run',
        INPUT_GROUP: 'Reviews',
      }),
    ).rejects.toThrow('create-worktree "group" needs the desktop app.');
  });

  it('refuses a cowork project with unsupported_action', async () => {
    mockedGetWorkspaceItem.mockResolvedValue({
      id: 'ws1',
      type: 'cowork',
      name: 'Workspace',
    } as never);

    await expect(
      runCreateWorktreeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_WORKSPACE_ID: 'ws1',
      }),
    ).rejects.toThrow(
      "Project `ws1` doesn't support worktrees. Use create-project-entry.",
    );
    expect(readOutputs(outputFile)).toMatchObject({
      failure_reason: 'unsupported_action',
    });
    expect(mockedCreateSingleRepoWorktree).not.toHaveBeenCalled();
    expect(mockedCreateMultiRepoWorktree).not.toHaveBeenCalled();
  });
});
