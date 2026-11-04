import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetResolvedCanopyDataDirForTests } from '../../../../canopy-paths';
import { savePipelineModelAliasPreferences } from '../../plugin-collection-store';
import { createInitialState } from '../pipeline-executor';
import type { ExecutionRuntime, NormalizedPipeline } from '../types';

function createRuntime(rootDir: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(rootDir, 'executions'),
    tempRootDir: path.join(rootDir, 'tmp'),
    bundledActionsDir: path.join(rootDir, 'actions'),
    getProjectActionsDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath: string): string =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

const pipeline: NormalizedPipeline = {
  name: 'Model Alias Overlay',
  scope: ['directory'],
  jobs: {
    test: {
      name: 'test',
      needs: [],
      timeout_minutes: 1,
      max_retries: 0,
      continue_on_error: false,
      steps: [
        {
          id: 'step',
          uses: 'builtin/agent-prompt',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 1,
          skip_on_missing_action: false,
          with: { model: 'reviewer' },
        },
      ],
    },
  },
  model_aliases: [
    {
      id: 'reviewer',
      name: 'Reviewer',
      defaults: { base: 'claude-default' },
    },
    {
      id: 'reset_me',
      name: 'Reset Me',
      defaults: { base: 'claude-default' },
    },
    {
      id: 'absent',
      name: 'Absent',
      defaults: { base: 'claude-default' },
    },
  ],
};

describe('pipeline executor model alias preferences', () => {
  let tempDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canopy-pipeline-alias-prefs-'),
    );
    previousDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = path.join(tempDir, 'data');
    resetResolvedCanopyDataDirForTests();
  });

  afterEach(() => {
    if (previousDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = previousDataDir;
    }
    resetResolvedCanopyDataDirForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('overlays stored and draft preferences while preserving reset markers', async () => {
    const locator = { type: 'file' as const, value: '/tmp/pipeline.yaml' };
    await savePipelineModelAliasPreferences(
      locator,
      {
        reviewer: { mode: 'inline', base: 'claude-stored' },
        reset_me: { mode: 'inline', base: 'claude-stored' },
        absent: { mode: 'agent', agent_id: 'agent_model_absent' },
        removed: { mode: 'inline', base: 'claude-removed' },
      },
      'desktop_cli',
    );

    const state = createInitialState(
      pipeline,
      {
        cwd: tempDir,
        pipelineId: 'pipeline',
        env: {},
        runtime: createRuntime(tempDir),
        pipelinePreferenceLocator: locator,
        modelAliasPreferences: {
          reviewer: { mode: 'inline', base: 'claude-override' },
          reset_me: { mode: 'reset' },
        },
      },
      'exec-1',
    );

    expect(state.model_alias_preferences).toEqual({
      reviewer: { mode: 'inline', base: 'claude-override' },
      reset_me: { mode: 'reset' },
      absent: { mode: 'agent', agent_id: 'agent_model_absent' },
    });
  });
});
