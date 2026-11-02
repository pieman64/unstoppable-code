jest.mock('../../node/lib/workspace-service', () => ({
  getWorkspaceItem: jest.fn(),
}));
jest.mock('../../node/lib/worktree-service', () => ({
  createMultiRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
  getWorktreeCliRecord: jest.fn(),
}));
jest.mock('../../node/w5-host-cohort', () => ({
  ...jest.requireActual<typeof Cohort>('../../node/w5-host-cohort'),
  registerW5Host: jest.fn(),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getCanopyDataDir } from '../../canopy-paths';
import { getWorkspaceItem } from '../../node/lib/workspace-service';
import type * as Cohort from '../../node/w5-host-cohort';
import {
  registerW5Host,
  W5HostCohortRefusedError,
} from '../../node/w5-host-cohort';
import { runCreateWorktreeAction } from '../create-worktree/runner';

const mockedRegister = jest.mocked(registerW5Host);
const mockedGetWorkspaceItem = jest.mocked(getWorkspaceItem);

describe('create-worktree host registration (CAN-3797)', () => {
  let tempDir: string;
  let outputFile: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-create-wt-'));
    outputFile = path.join(tempDir, 'canopy-output.txt');
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers this child for its data root before the first W5 read', async () => {
    mockedRegister.mockResolvedValue({ kind: 'registered' });
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
    ).rejects.toThrow("doesn't support worktrees");
    expect(mockedRegister).toHaveBeenCalledWith({
      dataRoot: getCanopyDataDir(),
      hostKind: 'create-worktree',
    });
    const [registered] = mockedRegister.mock.invocationCallOrder;
    const [read] = mockedGetWorkspaceItem.mock.invocationCallOrder;
    expect(registered).toBeLessThan(read ?? 0);
  });

  it('fails the step as target_not_ready while maintenance holds the root', async () => {
    mockedRegister.mockRejectedValue(
      new W5HostCohortRefusedError('maintenance-held'),
    );
    await expect(
      runCreateWorktreeAction({
        CANOPY_OUTPUT: outputFile,
        INPUT_WORKSPACE_ID: 'ws1',
      }),
    ).rejects.toThrow('Data maintenance is running.');
    expect(mockedGetWorkspaceItem).not.toHaveBeenCalled();
    expect(fs.readFileSync(outputFile, 'utf8')).toContain(
      'failure_reason=target_not_ready',
    );
  });
});
