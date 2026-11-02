jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

import {
  buildExpressionContext,
  cascadeEnv,
  interpolateExpression,
  getNormalizedTriggerInputDefs,
  inputsToEnv,
  mergePipelineInputs,
  normalizePipeline,
  parseOutputFile,
  rehydrateJobContext,
  resolvePipelineInputs,
} from '@canopy/desktop-shared/node/pipelines/executor';
import { buildExpressionCanopyIdentity } from '@canopy/desktop-shared/node/pipelines/executor/execution-context';
import type {
  JobResult,
  NormalizedJob,
} from '@canopy/desktop-shared/node/pipelines/executor/types';

describe('execution-context', () => {
  it('cascades env layers and stringifies scalars', () => {
    expect(
      cascadeEnv({ FOO: 'one', COUNT: 1 }, { COUNT: '2', ENABLED: true }),
    ).toEqual({
      FOO: 'one',
      COUNT: '2',
      ENABLED: 'true',
    });
  });

  it('converts action inputs to env vars', () => {
    expect(inputsToEnv({ repo_path: '/tmp/repo', retries: 2 })).toEqual({
      INPUT_REPO_PATH: '/tmp/repo',
      INPUT_RETRIES: '2',
    });
  });

  it('resolves pipeline inputs as typed scalars', () => {
    expect(
      resolvePipelineInputs(
        {
          greeting: { type: 'string', required: true },
          retries: { type: 'number', default: 2, min: 1, max: 5 },
          enabled: { type: 'boolean', default: false },
          mode: { type: 'choice', options: ['fast', 'safe'], default: 'safe' },
        },
        {
          greeting: 'hello',
          retries: '3',
          enabled: 'TRUE',
          mode: 'fast',
        },
      ),
    ).toEqual({
      greeting: 'hello',
      retries: 3,
      enabled: true,
      mode: 'fast',
    });
  });

  it('resolves model aliases for choice-typed model inputs before choice validation', () => {
    // Choice options on a `model` input are normalized to concrete model ids
    // at pipeline-normalization time, so a dispatch-supplied alias like
    // `$cheap` must be resolved the same way before it is compared against
    // the options list — and the resolved id is what flows downstream.
    expect(
      resolvePipelineInputs(
        {
          model: { type: 'choice', options: ['sonnet', 'opus'] },
        },
        { model: '$cheap' },
      ),
    ).toEqual({ model: 'sonnet' });
  });

  it('rejects a model alias resolving to a model outside the choice options', () => {
    expect(() =>
      resolvePipelineInputs(
        {
          model: { type: 'choice', options: ['sonnet', 'opus'] },
        },
        { model: '$fast' },
      ),
    ).toThrow(/Workflow input "model" must be one of: sonnet, opus/);
  });

  it('resolves model aliases in choice-typed resume-time model overrides', () => {
    expect(
      mergePipelineInputs(
        {
          model: { type: 'choice', options: ['sonnet', 'opus'] },
        },
        { model: 'opus' },
        { model: '$cheap' },
      ),
    ).toEqual({ model: 'sonnet' });
  });

  it('selects dispatch and plan_ready input definitions by active trigger', () => {
    const normalized = normalizePipeline({
      name: 'triggered-inputs',
      on: {
        dispatch: {
          inputs: {
            greeting: { type: 'string', required: true },
          },
        },
        plan_ready: {
          inputs: {
            max_iterations: { type: 'number', default: 2, min: 1, max: 10 },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'run', run: 'echo ready' }],
        },
      },
    });

    expect(getNormalizedTriggerInputDefs(normalized, 'dispatch')).toEqual({
      greeting: { type: 'string', required: true },
    });
    expect(getNormalizedTriggerInputDefs(normalized, 'plan_ready')).toEqual({
      max_iterations: { type: 'number', default: 2, min: 1, max: 10 },
    });
  });

  it('does not reuse dispatch input definitions for plan_ready runs', () => {
    const normalized = normalizePipeline({
      name: 'dispatch-input-fallback',
      on: {
        dispatch: {
          inputs: {
            greeting: { type: 'string', required: true },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'run', run: 'echo ready' }],
        },
      },
    });

    expect(
      getNormalizedTriggerInputDefs(normalized, 'plan_ready'),
    ).toBeUndefined();
  });

  it('uses the legacy dispatch compat alias when trigger_inputs are absent', () => {
    const normalized = normalizePipeline({
      name: 'legacy-dispatch-inputs',
      on: {
        dispatch: {
          inputs: {
            greeting: { type: 'string', required: true },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'run', run: 'echo ready' }],
        },
      },
    });

    delete normalized.trigger_inputs;

    expect(getNormalizedTriggerInputDefs(normalized, 'dispatch')).toEqual({
      greeting: { type: 'string', required: true },
    });
    expect(
      getNormalizedTriggerInputDefs(normalized, 'plan_ready'),
    ).toBeUndefined();
  });

  it('omits non-required inputs with no default and no provided value', () => {
    expect(
      resolvePipelineInputs(
        {
          greeting: { type: 'string', required: true },
          optional_note: { type: 'string' },
        },
        { greeting: 'hi' },
      ),
    ).toEqual({ greeting: 'hi' });
  });

  it('aggregates undeclared, missing, and invalid pipeline inputs', () => {
    try {
      resolvePipelineInputs(
        {
          enabled: { type: 'boolean' },
          required_name: { type: 'string', required: true },
          retries: { type: 'number', min: 1, max: 3 },
        },
        {
          enabled: 'not-bool',
          retries: '99',
          extra: '1',
        },
      );
      throw new Error('expected pipeline input validation to fail');
    } catch (error) {
      expect(String(error)).toContain('Workflow input validation failed');
      expect(String(error)).toContain('Workflow input "extra" is not declared');
      expect(String(error)).toContain(
        'Workflow input "enabled" must be "true" or "false"',
      );
      expect(String(error)).toContain(
        'Workflow input "required_name" is required',
      );
      expect(String(error)).toContain(
        'Workflow input "retries" must be less than or equal to 3',
      );
    }
  });

  it('merges stored inputs with resume-time overrides', () => {
    expect(
      mergePipelineInputs(
        {
          greeting: { type: 'string', required: true },
          retries: { type: 'number', default: 2, min: 1, max: 5 },
          enabled: { type: 'boolean', default: false },
        },
        {
          greeting: 'hello',
          retries: 2,
        },
        {
          retries: '4',
          enabled: 'true',
        },
      ),
    ).toEqual({
      greeting: 'hello',
      retries: 4,
      enabled: true,
    });
  });

  it('validates resume-time input overrides', () => {
    expect(() =>
      mergePipelineInputs(
        {
          greeting: { type: 'string', required: true },
          enabled: { type: 'boolean' },
        },
        {
          greeting: 'hello',
        },
        {
          enabled: 'not-bool',
          extra: '1',
        },
      ),
    ).toThrow(/Workflow input validation failed/);
    expect(() =>
      mergePipelineInputs(
        {
          greeting: { type: 'string', required: true },
        },
        {},
        {},
      ),
    ).toThrow(/Workflow input "greeting" is required/);
  });

  it('preserves stored inputs when resuming without declarations', () => {
    expect(
      mergePipelineInputs(
        undefined,
        {
          reviewer: 'opus',
          max_iterations: 2,
        },
        undefined,
      ),
    ).toEqual({
      reviewer: 'opus',
      max_iterations: 2,
    });
  });

  it('rejects resume-time overrides when declarations are unavailable', () => {
    expect(() =>
      mergePipelineInputs(
        undefined,
        {
          reviewer: 'opus',
        },
        {
          reviewer: 'sonnet',
        },
      ),
    ).toThrow(/Workflow input "reviewer" is not declared/);
  });

  it('parses simple key=value output files', () => {
    expect(parseOutputFile('one=1\ntwo=hello=world\n')).toEqual({
      one: '1',
      two: 'hello=world',
    });
    expect(() => parseOutputFile('=nope')).toThrow(/Invalid output line/);
  });

  it('rehydrates prior step outputs and cumulative dynamic env', () => {
    const job: NormalizedJob = {
      name: 'build',
      needs: [],
      timeout_minutes: 360,
      max_retries: 0,
      continue_on_error: false,
      steps: [
        {
          id: 'first',
          run: 'echo first',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
        {
          id: 'second',
          run: 'echo second',
          shell: 'bash',
          continue_on_error: false,
          timeout_minutes: 360,
          skip_on_missing_action: false,
        },
      ],
    };
    const jobResult: JobResult = {
      status: 'running',
      outputs: {},
      steps: {
        first: {
          status: 'success',
          conclusion: 'success',
          outcome: 'success',
          outputs: { artifact: 'a' },
          dynamic_env: { VERSION: '1.0.0' },
        },
        second: {
          status: 'success',
          conclusion: 'success',
          outcome: 'success',
          outputs: { image: 'ok' },
          dynamic_env: { CHANNEL: 'stable' },
        },
      },
    };

    expect(rehydrateJobContext(job, jobResult)).toEqual({
      steps: {
        first: {
          outputs: { artifact: 'a' },
          outcome: 'success',
          conclusion: 'success',
        },
        second: {
          outputs: { image: 'ok' },
          outcome: 'success',
          conclusion: 'success',
        },
      },
      dynamicEnv: {
        VERSION: '1.0.0',
        CHANNEL: 'stable',
      },
    });
  });

  it('builds expression contexts with sane defaults', () => {
    expect(buildExpressionContext({ env: { FOO: 'bar' } })).toEqual({
      env: { FOO: 'bar' },
      inputs: {},
      steps: {},
      needs: {},
      job: {
        is_retry: false,
        retry_count: 0,
        max_retries: 0,
      },
      canopy: {
        event_name: 'dispatch',
        event: {},
        project_id: '',
        task_id: '',
        owner: 'personal',
        initiator: { kind: 'user' },
      },
    });
  });

  it('projects run identity into canopy fields', () => {
    expect(
      buildExpressionCanopyIdentity({
        projectId: 'project-1',
        worktreeId: 'task-1',
        executionContext: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        initiator: {
          kind: 'agent',
          chat: { projectId: 'project-1', worktreeId: 'task-1', chatId: 'c' },
        },
      }),
    ).toEqual({
      project_id: 'project-1',
      task_id: 'task-1',
      owner: 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      initiator: {
        kind: 'agent',
        project_id: 'project-1',
        task_id: 'task-1',
        chat_id: 'c',
      },
    });
    expect(
      buildExpressionCanopyIdentity({
        initiator: {
          kind: 'automation',
          automationId: 'auto-1',
          automationName: 'Nightly',
        },
      }).initiator,
    ).toEqual({
      kind: 'automation',
      automation_id: 'auto-1',
      automation_name: 'Nightly',
    });
    expect(
      buildExpressionCanopyIdentity({ initiator: { kind: 'app_advisor' } })
        .initiator,
    ).toEqual({ kind: 'app_advisor' });
  });

  it('reads canopy identity fields in expressions', () => {
    const context = buildExpressionContext({
      canopy: {
        event_name: 'dispatch',
        event: {},
        ...buildExpressionCanopyIdentity({
          initiator: { kind: 'hook' },
          executionContext: 'personal',
        }),
      },
    });
    expect(
      interpolateExpression(
        '${{ canopy.owner }}/${{ canopy.initiator.kind }}/${{ canopy.project_id }}',
        context,
      ),
    ).toBe('personal/hook/');
    expect(
      interpolateExpression('${{ toJson(canopy.initiator) }}', context),
    ).toBe('{"kind":"hook"}');
  });
});
