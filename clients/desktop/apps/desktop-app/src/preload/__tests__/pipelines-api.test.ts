const mockInvoke = jest.fn();

jest.mock('electron', () => ({
  ipcRenderer: {
    get invoke(): typeof mockInvoke {
      return mockInvoke;
    },
    on: jest.fn(),
    removeListener: jest.fn(),
  },
}));

import type { IPCResult } from '@canopy/desktop-shared/types/pipeline';
import type { ExecutionSummary } from '@canopy/desktop-shared/node/pipelines/executor/types';
import { PIPELINE_CHANNELS } from '@canopy/desktop-shared/constants/ipc-channels';
import { createPipelinesAPI } from '../api/pipelines-api';

describe('pipelines preload API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('keeps curated lists, selected content and hash-pinned import on separate IPC calls', async () => {
    mockInvoke.mockResolvedValue({ success: true });
    const api = createPipelinesAPI();
    await api.listCurated({ q: 'review', cursor: 'page2' });
    await api.getCurated('review');
    await api.importCurated({
      key: 'review',
      expectedContentHash: 'a'.repeat(64),
    });
    expect(mockInvoke.mock.calls).toEqual([
      [PIPELINE_CHANNELS.CURATED_LIST, { q: 'review', cursor: 'page2' }],
      [PIPELINE_CHANNELS.CURATED_GET, 'review'],
      [
        PIPELINE_CHANNELS.CURATED_IMPORT,
        { key: 'review', expectedContentHash: 'a'.repeat(64) },
      ],
    ]);
  });

  it('sends the step log read shape only when a caller asks for one', async () => {
    mockInvoke.mockResolvedValue({ success: true, data: { lines: [] } });
    const api = createPipelinesAPI();
    const locator = { executionId: 'exec-1', jobId: 'job-1', stepId: 'step' };
    await api.readStepLog(locator);
    await api.readStepLog(locator, { format: 'text' });
    expect(mockInvoke.mock.calls).toEqual([
      [PIPELINE_CHANNELS.READ_STEP_LOG, locator],
      [PIPELINE_CHANNELS.READ_STEP_LOG, locator, { format: 'text' }],
    ]);
  });

  it('shares only the in-flight execution-list request', async () => {
    let resolveList:
      | ((result: IPCResult<ExecutionSummary[]>) => void)
      | undefined;
    const pending = new Promise<IPCResult<ExecutionSummary[]>>((resolve) => {
      resolveList = resolve;
    });
    mockInvoke.mockReturnValueOnce(pending);
    const api = createPipelinesAPI();

    const first = api.listExecutions();
    const second = api.listExecutions();

    expect(first).toBe(second);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith(PIPELINE_CHANNELS.LIST_EXECUTIONS);
    if (!resolveList) {
      throw new Error('Expected list execution resolver to be set');
    }
    resolveList({ success: true, data: [] });
    await Promise.all([first, second]);

    mockInvoke.mockResolvedValueOnce({ success: true, data: [] });
    await api.listExecutions();
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('uses the automation-only resume channel for agent actions', async () => {
    mockInvoke.mockResolvedValue({ success: true, data: null });
    const api = createPipelinesAPI();

    await api.resumeAutomation('execution-1', {
      pauseResponses: [
        {
          checkpoint_id: 'checkpoint-1',
          job_id: 'review',
          step_id: 'approval',
          answers: { reviewer: 'Ada' },
        },
      ],
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      PIPELINE_CHANNELS.RESUME_AUTOMATION,
      'execution-1',
      expect.objectContaining({
        pauseResponses: [
          expect.objectContaining({ checkpoint_id: 'checkpoint-1' }),
        ],
      }),
    );
  });
});
