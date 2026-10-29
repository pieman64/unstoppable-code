jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

const mockUnregisterWorkItem = jest.fn();
const mockUnregisterProcess = jest.fn();
const mockRegisterWorkItem = jest.fn(() => ({
  update: jest.fn(),
  unregister: mockUnregisterWorkItem,
}));
const mockRegisterProcess = jest.fn(() => ({
  update: jest.fn(),
  unregister: mockUnregisterProcess,
}));

jest.mock(
  '../resource-monitor',
  (): {
    getResourceMonitorService: () => {
      registerWorkItem: typeof mockRegisterWorkItem;
      registerProcess: typeof mockRegisterProcess;
    };
  } => ({
    getResourceMonitorService: () => ({
      registerWorkItem: mockRegisterWorkItem,
      registerProcess: mockRegisterProcess,
    }),
  }),
);

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { executePipeline } from '@canopy/desktop-shared/node/pipelines/executor';
import type { ExecutionRuntime } from '@canopy/desktop-shared/node/pipelines/executor/types';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string) =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string) =>
      path.join(repoPath, '.canopy', 'pipelines'),
    resourceMonitor: {
      registerWorkItem: mockRegisterWorkItem,
      registerProcess: mockRegisterProcess,
    },
  };
}

describe('pipeline resource monitor integration', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pipeline-resource-monitor-'),
    );
    runtime = createRuntime(tempDir);
    fs.mkdirSync(runtime.bundledActionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('registers pipeline executions and step subprocesses as resource work', async () => {
    const pipeline: Pipeline = {
      name: 'Resource Monitor Pipeline',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            {
              id: 'first',
              run: 'echo done',
            },
          ],
        },
      },
    };

    const handle = await executePipeline(pipeline, {
      cwd: tempDir,
      pipelineId: 'resource-monitor-pipeline',
      runtime,
    });
    const state = await handle.waitForCompletion();
    const expectedStepPipeline: unknown = expect.objectContaining({
      executionId: state.id,
      pipelineId: 'resource-monitor-pipeline',
      pipelineName: 'Resource Monitor Pipeline',
      jobId: 'build',
      stepId: 'first',
    });

    expect(state.status).toBe('success');
    expect(mockRegisterWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: `pipeline-execution:${state.id}`,
        groupId: 'pipelines',
        kind: 'pipeline-execution',
        label: 'Resource Monitor Pipeline',
        metadata: {
          type: 'pipeline',
          pipeline: {
            executionId: state.id,
            pipelineId: 'resource-monitor-pipeline',
            pipelineName: 'Resource Monitor Pipeline',
          },
        },
      }),
    );
    expect(mockRegisterProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        groupId: 'pipelines',
        kind: 'pipeline-step',
        label: 'build / first',
        metadata: {
          type: 'pipeline',
          pipeline: expectedStepPipeline,
        },
      }),
    );
    expect(mockUnregisterProcess).toHaveBeenCalledTimes(1);
    expect(mockUnregisterWorkItem).toHaveBeenCalledTimes(1);
  });
});
