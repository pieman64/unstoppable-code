jest.mock('electron', () => ({
  dialog: { showOpenDialog: jest.fn() },
}));
jest.mock('node:fs/promises');
jest.mock('../lib/plan-persistence');

import { dialog } from 'electron';
import { readFile } from 'node:fs/promises';
import { createTrackedPlan } from '../lib/plan-persistence';
import { importTrackedPlanFromFile } from '../ipc/plans';

/* eslint-disable @typescript-eslint/unbound-method */
const mockedShowOpenDialog = jest.mocked(dialog.showOpenDialog);
/* eslint-enable @typescript-eslint/unbound-method */
const mockedReadFile = jest.mocked(readFile);
const mockedCreate = jest.mocked(createTrackedPlan);

describe('importTrackedPlanFromFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('imports the chosen file as an imported plan', async () => {
    mockedShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/abs/plan.md'],
    });
    mockedReadFile.mockResolvedValue('# Plan\nbody');
    mockedCreate.mockResolvedValue({ id: 'new-id' });

    await importTrackedPlanFromFile({ projectId: 'p1', worktreeId: 'w1' });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        worktreeId: 'w1',
        source: 'imported',
        content: '# Plan\nbody',
        sourceFilePath: 'plan.md',
      }),
    );
  });

  it('returns null when the dialog is canceled', async () => {
    mockedShowOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const result = await importTrackedPlanFromFile({
      projectId: 'p1',
      worktreeId: 'w1',
    });
    expect(result.plan).toBeNull();
    expect(result.trackedPlanFilePath).toMatch(
      /[\\/]p1[\\/]plans[\\/]w1\.json$/,
    );
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it('throws a readable error when the file cannot be read', async () => {
    mockedShowOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ['/abs/plan.md'],
    });
    mockedReadFile.mockRejectedValue(new Error('EACCES'));
    await expect(
      importTrackedPlanFromFile({ projectId: 'p1', worktreeId: 'w1' }),
    ).rejects.toThrow('Could not read the selected file');
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});
