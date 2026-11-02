import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validatePipelineScopes } from '../pipeline-scope-validation';
import type { ExecutionRuntime } from '../types';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';

function writeAction(root: string, name: string, body: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'action.yml'), body, 'utf8');
}

function createRuntime(root: string): ExecutionRuntime {
  return {
    // Pipeline fixtures do not enforce an org model policy.
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir: path.join(root, 'executions'),
    tempRootDir: path.join(root, 'tmp'),
    bundledActionsDir: path.join(root, 'actions'),
    getProjectActionsDir: (repoPath) =>
      path.join(repoPath, '.canopy', 'actions'),
    getProjectPipelinesDir: (repoPath) =>
      path.join(repoPath, '.canopy', 'pipelines'),
  };
}

function pipelineWithStep(
  step: Pipeline['jobs'][string]['steps'][number],
): Pipeline {
  return {
    name: 'Parent',
    on: 'dispatch',
    jobs: {
      test: {
        steps: [step],
      },
    },
  };
}

describe('validatePipelineScopes', () => {
  let tempDir: string;
  let runtime: ExecutionRuntime;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-scope-'));
    runtime = createRuntime(tempDir);
    fs.mkdirSync(runtime.bundledActionsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows compatible directory action scopes', async () => {
    writeAction(
      runtime.bundledActionsDir,
      'directory-action',
      [
        'name: Directory Action',
        'scope: directory',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
    );

    await expect(
      validatePipelineScopes({
        pipeline: pipelineWithStep({
          id: 'use_action',
          uses: 'builtin/directory-action',
        }),
        pipelineId: 'parent',
        cwd: tempDir,
        runtime,
      }),
    ).resolves.toBeUndefined();
  });

  it('allows legacy directory pipelines to use worktree-only actions statically', async () => {
    writeAction(
      runtime.bundledActionsDir,
      'worktree-action',
      [
        'name: Worktree Action',
        'scope: worktree',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
    );

    await expect(
      validatePipelineScopes({
        pipeline: pipelineWithStep({
          id: 'use_action',
          uses: 'builtin/worktree-action',
        }),
        pipelineId: 'parent',
        cwd: tempDir,
        runtime,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects actions with no reachable execution context overlap', async () => {
    writeAction(
      runtime.bundledActionsDir,
      'worktree-action',
      [
        'name: Worktree Action',
        'scope: worktree',
        'runs:',
        '  using: node',
        '  main: index.js',
      ].join('\n'),
    );

    await expect(
      validatePipelineScopes({
        pipeline: {
          ...pipelineWithStep({
            id: 'use_action',
            uses: 'builtin/worktree-action',
          }),
          scope: 'global',
        },
        pipelineId: 'parent',
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow(
      'Step "use_action" in job "test" uses action "builtin/worktree-action"',
    );
  });

  it('rejects target on non-pipeline actions', async () => {
    writeAction(
      runtime.bundledActionsDir,
      'node-action',
      ['name: Node Action', 'runs:', '  using: node', '  main: index.js'].join(
        '\n',
      ),
    );

    await expect(
      validatePipelineScopes({
        pipeline: pipelineWithStep({
          id: 'bad_target',
          uses: 'builtin/node-action',
          target: { scope: 'directory', path: tempDir },
        }),
        pipelineId: 'parent',
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow(
      'Step "bad_target" in job "test" defines target but action "builtin/node-action" is not a workflow action',
    );
  });

  it('validates run-pipeline inherit parent/child compatibility', async () => {
    writeAction(
      runtime.bundledActionsDir,
      'run-pipeline',
      ['name: Run Pipeline', 'runs:', '  using: pipeline'].join('\n'),
    );

    await expect(
      validatePipelineScopes({
        pipeline: {
          ...pipelineWithStep({
            id: 'child',
            uses: 'builtin/run-pipeline',
            with: {
              pipeline_yaml: [
                'pipeline:',
                '  name: Child',
                '  scope: global',
                '  on: dispatch',
                '  jobs:',
                '    child:',
                '      steps:',
                '        - id: ok',
                '          run: echo ok',
              ].join('\n'),
            },
          }),
          scope: 'worktree',
        },
        pipelineId: 'parent',
        cwd: tempDir,
        runtime,
      }),
    ).rejects.toThrow(
      'Step "child" in job "test" targets scope "inherit" but child workflow "inline-pipeline" supports [global]',
    );
  });

  it('skips missing actions when skip_on_missing_action is true', async () => {
    await expect(
      validatePipelineScopes({
        pipeline: pipelineWithStep({
          id: 'missing',
          uses: 'builtin/missing',
          skip_on_missing_action: true,
        }),
        pipelineId: 'parent',
        cwd: tempDir,
        runtime,
      }),
    ).resolves.toBeUndefined();
  });
});
