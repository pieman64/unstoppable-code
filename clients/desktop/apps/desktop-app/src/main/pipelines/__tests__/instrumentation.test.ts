jest.mock('@canopy/desktop-instrumentation', () => ({
  createDesktopInstrumentationOperationKey: jest.fn(
    (seed: string) => `operation:${seed}`,
  ),
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  failDesktopOperation: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import {
  finishPipelineExecutionTelemetry,
  withPipelineCrudTelemetry,
} from '../instrumentation';
import type { ExecutionState } from '@canopy/desktop-shared/node/pipelines/executor/types';

const mockedFailDesktopOperation = jest.mocked(failDesktopOperation);
const mockedStartDesktopOperation = jest.mocked(startDesktopOperation);
const mockedSucceedDesktopOperation = jest.mocked(succeedDesktopOperation);

function buildExecutionState(status: ExecutionState['status']): ExecutionState {
  return {
    id: 'execution-1',
    status,
    event_name: 'dispatch',
    pipeline_snapshot: {
      jobs: {
        job: {
          steps: [{ id: 'step-1' }],
        },
      },
    },
    jobs: {
      job: {
        status,
        conclusion: status,
      },
    },
    started_at: '2026-05-27T00:00:00.000Z',
    completed_at: '2026-05-27T00:00:01.000Z',
  } as unknown as ExecutionState;
}

describe('pipeline instrumentation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks pipeline CRUD telemetry as succeeded when operation succeeds', async () => {
    await expect(
      withPipelineCrudTelemetry({ action: 'list', source: 'user' }, () => ({
        success: true,
        data: ['pipeline-1'],
      })),
    ).resolves.toEqual({ success: true, data: ['pipeline-1'] });

    expect(mockedStartDesktopOperation).toHaveBeenCalledWith(
      'canopy.pipeline_crud',
      expect.any(Object),
    );
    expect(mockedSucceedDesktopOperation.mock.calls[0]?.[0]).toBe(
      'canopy.pipeline_crud',
    );
    expect(mockedSucceedDesktopOperation.mock.calls[0]?.[1]).toMatchObject({
      context: {
        action: 'list',
        source: 'user',
        status: 'success',
        result_count: 1,
      },
    });
  });

  it('marks pipeline CRUD telemetry as failed for unsuccessful IPC results', async () => {
    await expect(
      withPipelineCrudTelemetry({ action: 'get', hasPipelineId: true }, () => ({
        success: false,
        error: 'missing',
      })),
    ).resolves.toEqual({ success: false, error: 'missing' });

    expect(mockedFailDesktopOperation.mock.calls[0]?.[0]).toBe(
      'canopy.pipeline_crud',
    );
    expect(mockedFailDesktopOperation.mock.calls[0]?.[1]).toBe('error');
    expect(mockedFailDesktopOperation.mock.calls[0]?.[2]).toMatchObject({
      context: {
        action: 'get',
        has_pipeline_id: true,
        status: 'failure',
      },
    });
  });

  it('records failure and rethrows when pipeline CRUD operation throws', async () => {
    await expect(
      withPipelineCrudTelemetry({ action: 'delete' }, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mockedFailDesktopOperation.mock.calls[0]?.[0]).toBe(
      'canopy.pipeline_crud',
    );
    expect(mockedFailDesktopOperation.mock.calls[0]?.[1]).toBe('error');
    expect(mockedFailDesktopOperation.mock.calls[0]?.[2]).toMatchObject({
      context: {
        action: 'delete',
        status: 'failure',
      },
    });
  });

  it('maps cancelled pipeline execution telemetry to abandoned failure reason', () => {
    finishPipelineExecutionTelemetry(buildExecutionState('cancelled'));

    expect(mockedFailDesktopOperation.mock.calls[0]?.[0]).toBe(
      'canopy.pipeline_execution',
    );
    expect(mockedFailDesktopOperation.mock.calls[0]?.[1]).toBe('abandoned');
    expect(mockedFailDesktopOperation.mock.calls[0]?.[2]).toMatchObject({
      context: {
        status: 'cancelled',
        duration_ms: 1000,
      },
    });
  });
});
