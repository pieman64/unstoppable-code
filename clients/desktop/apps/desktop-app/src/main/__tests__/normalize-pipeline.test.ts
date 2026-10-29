jest.mock('@electron-toolkit/utils', () => ({
  is: { dev: true },
}));

import { normalizePipeline } from '@canopy/desktop-shared/node/pipelines/executor';
import {
  MAX_ITERATIONS_LIMIT,
  MAX_RETRIES_LIMIT,
} from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import type { Pipeline } from '@canopy/desktop-shared/types/pipeline';

describe('normalize-pipeline', () => {
  it('resolves pipeline and job run defaults', () => {
    const pipeline: Pipeline = {
      name: 'Defaults',
      on: 'dispatch',
      defaults: {
        run: {
          shell: 'sh',
          working_directory: 'pipeline-dir',
        },
      },
      jobs: {
        build: {
          defaults: {
            run: {
              shell: 'node',
              working_directory: 'job-dir',
            },
          },
          steps: [
            {
              id: 'pipeline_defaults',
              run: 'echo pipeline',
              shell: 'bash',
            },
            {
              id: 'job_defaults',
              run: 'console.log("job")',
            },
          ],
        },
      },
    };

    const normalized = normalizePipeline(pipeline);

    expect(normalized.jobs.build.steps[0]).toMatchObject({
      id: 'pipeline_defaults',
      shell: 'bash',
      working_directory: 'job-dir',
    });
    expect(normalized.jobs.build.steps[1]).toMatchObject({
      id: 'job_defaults',
      shell: 'node',
      working_directory: 'job-dir',
      continue_on_error: false,
      timeout_minutes: 360,
    });
    expect(normalized.jobs.build.max_retries).toBe(0);
  });

  it('assigns deterministic auto-generated step ids and avoids collisions', () => {
    const normalized = normalizePipeline({
      name: 'Auto IDs',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [
            { id: '__auto_step_0', run: 'echo collision' },
            { run: 'echo one' },
            { run: 'echo two' },
          ],
        },
      },
    });

    expect(normalized.jobs.build.steps.map((step) => step.id)).toEqual([
      '__auto_step_0',
      '__auto_step_1',
      '__auto_step_2',
    ]);
  });

  it('rejects invalid step definitions', () => {
    expect(() =>
      normalizePipeline({
        name: 'Broken',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [{ id: 'bad', run: 'echo hi', uses: 'builtin/discovery' }],
          },
        },
      }),
    ).toThrow(/exactly one of run or uses/);

    expect(() =>
      normalizePipeline({
        name: 'Broken',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [
              {
                id: 'absolute_dir',
                run: 'echo hi',
                working_directory: '/tmp',
              },
            ],
          },
        },
      }),
    ).toThrow(/working_directory must be relative/);

    expect(() =>
      normalizePipeline({
        name: 'Broken',
        on: 'dispatch',
        jobs: {
          build: {
            steps: [
              {
                id: 'windows_absolute_dir',
                run: 'echo hi',
                working_directory: 'C:\\\\tmp',
              },
            ],
          },
        },
      }),
    ).toThrow(/working_directory must be relative/);

    expect(() =>
      normalizePipeline(
        parsePipelineText(`
name: Broken
on: dispatch
jobs:
  build:
    steps:
      - id: invalid_hint
        uses: builtin/discovery
        log_format_hint: custom
`),
      ),
    ).toThrow(/log_format_hint "custom" is not supported/);

    expect(() =>
      normalizePipeline(
        parsePipelineText(`
name: Broken
on: dispatch
jobs:
  build:
    steps:
      - id: run_hint
        run: echo hi
        log_format_hint: agent
`),
      ),
    ).toThrow(/cannot define log_format_hint on run steps/);
  });

  it('normalizes valid action step log_format_hint values', () => {
    const normalized = normalizePipeline(
      parsePipelineText(`
name: Hints
on: dispatch
jobs:
  build:
    steps:
      - id: discover
        uses: builtin/discovery
        log_format_hint: agent
`),
    );

    expect(normalized.jobs.build.steps[0].log_format_hint).toBe('agent');
  });

  it('normalizes and validates max_retries', () => {
    const normalized = normalizePipeline({
      name: 'Retries',
      on: 'dispatch',
      jobs: {
        build: {
          max_retries: 2,
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(normalized.jobs.build.max_retries).toBe(2);

    expect(() =>
      normalizePipeline({
        name: 'Broken retries',
        on: 'dispatch',
        jobs: {
          build: {
            max_retries: -1,
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/max_retries/);

    expect(() =>
      normalizePipeline({
        name: 'Broken retries',
        on: 'dispatch',
        jobs: {
          build: {
            max_retries: MAX_RETRIES_LIMIT + 1,
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/max_retries/);

    expect(() =>
      normalizePipeline({
        name: 'Broken retries',
        on: 'dispatch',
        jobs: {
          build: {
            max_retries: 1.5,
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/max_retries/);
  });

  it('normalizes and validates max_iterations', () => {
    const normalized = normalizePipeline({
      name: 'Iterations',
      on: 'dispatch',
      jobs: {
        build: {
          max_iterations: 3,
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(normalized.jobs.build.max_iterations).toBe(3);

    const omitted = normalizePipeline({
      name: 'Omitted iterations',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(omitted.jobs.build.max_iterations).toBeUndefined();

    const skip = normalizePipeline({
      name: 'Skip iterations',
      on: 'dispatch',
      jobs: {
        build: {
          max_iterations: 0,
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(skip.jobs.build.max_iterations).toBe(0);

    expect(() =>
      normalizePipeline({
        name: 'Broken iterations',
        on: 'dispatch',
        jobs: {
          build: {
            max_iterations: -1,
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/max_iterations/);

    expect(() =>
      normalizePipeline({
        name: 'Broken iterations',
        on: 'dispatch',
        jobs: {
          build: {
            max_iterations: MAX_ITERATIONS_LIMIT + 1,
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/max_iterations/);

    const dynamic = normalizePipeline({
      name: 'Dynamic iterations',
      on: 'dispatch',
      jobs: {
        build: {
          max_iterations: '${{ needs.plan.outputs.iterations }}',
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(dynamic.jobs.build.max_iterations).toBeUndefined();
    expect(dynamic.jobs.build.max_iterations_expression).toBe(
      '${{ needs.plan.outputs.iterations }}',
    );

    expect(() =>
      normalizePipeline({
        name: 'Broken iterations',
        on: 'dispatch',
        jobs: {
          build: {
            max_iterations: 'later',
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/max_iterations/);
  });

  it('normalizes and validates pipeline inputs', () => {
    const normalized = normalizePipeline({
      name: 'Inputs',
      on: {
        dispatch: {
          inputs: {
            greeting: {
              required: true,
            },
            retries: {
              type: 'number',
              default: 2,
              min: 1,
              max: 5,
            },
            enabled: {
              type: 'boolean',
              default: false,
            },
            mode: {
              type: 'choice',
              options: ['fast', 'safe'],
              default: 'safe',
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(normalized.inputs).toEqual({
      greeting: {
        required: true,
        type: 'string',
        description: undefined,
        default: undefined,
        options: undefined,
      },
      retries: {
        type: 'number',
        default: 2,
        min: 1,
        max: 5,
        description: undefined,
        options: undefined,
        required: undefined,
      },
      enabled: {
        type: 'boolean',
        default: false,
        description: undefined,
        options: undefined,
        required: undefined,
      },
      mode: {
        type: 'choice',
        options: ['fast', 'safe'],
        default: 'safe',
        description: undefined,
        required: undefined,
      },
    });

    expect(() =>
      normalizePipeline({
        name: 'Broken inputs',
        on: {
          dispatch: {
            inputs: {
              'bad-name': { required: true },
            },
          },
        },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/Invalid pipeline input name/);

    expect(() =>
      normalizePipeline({
        name: 'Broken choice',
        on: {
          dispatch: {
            inputs: {
              mode: {
                type: 'choice',
              },
            },
          },
        },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/must define a non-empty options array/);

    expect(() =>
      normalizePipeline({
        name: 'Broken default',
        on: {
          dispatch: {
            inputs: {
              retries: {
                type: 'number',
                default: 'oops',
              },
            },
          },
        },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/invalid default value/);

    expect(() =>
      normalizePipeline({
        name: 'Duplicate options',
        on: {
          dispatch: {
            inputs: {
              mode: {
                type: 'choice',
                options: ['fast', 'fast'],
              },
            },
          },
        },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/duplicate choice option/);

    expect(() =>
      normalizePipeline({
        name: 'Options on non-choice',
        on: {
          dispatch: {
            inputs: {
              greeting: {
                type: 'string',
                options: ['hi', 'hello'],
              },
            },
          },
        },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/may only define options when type is "choice"/);

    expect(() =>
      normalizePipeline({
        name: 'Broken numeric config',
        on: {
          dispatch: {
            inputs: {
              retries: {
                type: 'number',
                min: 10,
                max: 1,
              },
            },
          },
        },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/min cannot be greater than max/);

    expect(() =>
      normalizePipeline({
        name: 'Broken range type',
        on: {
          dispatch: {
            inputs: {
              greeting: {
                type: 'string',
                min: 1,
              },
            },
          },
        },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/may only define min\/max when type is "number"/);

    expect(() =>
      normalizePipeline({
        name: 'Non-boolean required',
        on: {
          dispatch: {
            inputs: {
              greeting: {
                required: 'false' as unknown as boolean,
              },
            },
          },
        },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      }),
    ).toThrow(/invalid required value: expected a boolean/);
  });

  it('normalizes and validates pipeline input UI visibility hints', () => {
    const normalized = normalizePipeline({
      name: 'Input hints',
      on: {
        dispatch: {
          inputs: {
            artifact_file: {
              description: 'Generated file path',
              required: false,
              'hint-hide-ui-option': true,
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(
      normalized.trigger_inputs?.dispatch?.artifact_file['hint-hide-ui-option'],
    ).toBe(true);

    const invalidHintPipeline = parsePipelineText(`
name: Broken input hint
on:
  dispatch:
    inputs:
      artifact_file:
        hint-hide-ui-option: "true"
jobs:
  build:
    steps:
      - id: one
        run: echo ok
`);

    expect(() => normalizePipeline(invalidHintPipeline)).toThrow(
      /invalid hint-hide-ui-option value: expected a boolean/,
    );
  });

  it('requires an on field on the pipeline', () => {
    const raw = {
      name: 'Missing on',
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    };
    expect(() => normalizePipeline(raw as unknown as Pipeline)).toThrow(
      /must define an "on" field/,
    );
  });

  it('rejects top-level inputs field with updated error message', () => {
    const raw = {
      name: 'Old style',
      on: 'dispatch',
      inputs: {
        greeting: { required: true },
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    };
    expect(() => normalizePipeline(raw as unknown as Pipeline)).toThrow(
      /top-level "inputs" which is no longer supported.*on\.<trigger>\.inputs/,
    );
  });

  it('accepts shorthand on: dispatch string', () => {
    const normalized = normalizePipeline({
      name: 'Shorthand',
      on: 'dispatch',
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });
    expect(normalized.inputs).toBeUndefined();
  });

  it('accepts plan_ready trigger', () => {
    const normalized = normalizePipeline({
      name: 'Plan Ready',
      on: 'plan_ready',
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(normalized.inputs).toBeUndefined();
    expect(normalized.trigger_inputs).toBeUndefined();
  });

  it('accepts task_ready trigger', () => {
    const normalized = normalizePipeline({
      name: 'Task Ready',
      on: 'task_ready',
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(normalized.inputs).toBeUndefined();
    expect(normalized.trigger_inputs).toBeUndefined();
  });

  it('accepts object form with dispatch.inputs', () => {
    const normalized = normalizePipeline({
      name: 'Object form',
      on: {
        dispatch: {
          inputs: {
            name: {
              type: 'string',
              required: true,
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });
    expect(normalized.inputs).toBeDefined();
    expect(normalized.inputs?.name.type).toBe('string');
    expect(normalized.trigger_inputs?.dispatch?.name.type).toBe('string');
    expect(normalized.trigger_inputs?.plan_ready).toBeUndefined();
  });

  it('accepts object form with plan_ready trigger', () => {
    const normalized = normalizePipeline({
      name: 'Plan Ready Object',
      on: {
        plan_ready: {},
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });
    expect(normalized.inputs).toBeUndefined();
    expect(normalized.trigger_inputs).toBeUndefined();
  });

  it('accepts object form with task_ready trigger', () => {
    const normalized = normalizePipeline({
      name: 'Task Ready Object',
      on: {
        task_ready: {},
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });
    expect(normalized.inputs).toBeUndefined();
    expect(normalized.trigger_inputs).toBeUndefined();
  });

  it('accepts dispatch with no inputs in object form', () => {
    const normalized = normalizePipeline({
      name: 'Empty dispatch',
      on: { dispatch: {} },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });
    expect(normalized.inputs).toBeUndefined();
  });

  it('rejects malformed on.dispatch values', () => {
    // dispatch: "yes" (string primitive)
    expect(() =>
      normalizePipeline({
        name: 'Bad dispatch string',
        on: { dispatch: 'yes' },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      } as unknown as Pipeline),
    ).toThrow(/on\.dispatch.*must be a plain object/);

    // dispatch: true (boolean primitive)
    expect(() =>
      normalizePipeline({
        name: 'Bad dispatch bool',
        on: { dispatch: true },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      } as unknown as Pipeline),
    ).toThrow(/on\.dispatch.*must be a plain object/);

    // dispatch: [] (array)
    expect(() =>
      normalizePipeline({
        name: 'Bad dispatch array',
        on: { dispatch: [1, 2, 3] },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      } as unknown as Pipeline),
    ).toThrow(/on\.dispatch.*must be a plain object/);

    // dispatch: 42 (number)
    expect(() =>
      normalizePipeline({
        name: 'Bad dispatch number',
        on: { dispatch: 42 },
        jobs: {
          build: {
            steps: [{ id: 'one', run: 'echo ok' }],
          },
        },
      } as unknown as Pipeline),
    ).toThrow(/on\.dispatch.*must be a plain object/);
  });

  it('rejects unknown trigger types', () => {
    const raw = {
      name: 'Unknown trigger',
      on: 'push',
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    };
    expect(() => normalizePipeline(raw as unknown as Pipeline)).toThrow(
      /Unsupported trigger type "push"/,
    );

    const rawObj = {
      name: 'Unknown trigger obj',
      on: { schedule: { cron: '0 * * * *' } },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    };
    expect(() => normalizePipeline(rawObj as unknown as Pipeline)).toThrow(
      /Unsupported trigger type "schedule"/,
    );
  });

  it('normalizes plan_ready.inputs correctly', () => {
    const normalized = normalizePipeline({
      name: 'Plan Ready Inputs',
      on: {
        plan_ready: {
          inputs: {
            auto_approve: {
              type: 'boolean',
              default: false,
              description: 'Auto-approve the plan',
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(normalized.trigger_inputs?.plan_ready).toEqual({
      auto_approve: {
        type: 'boolean',
        default: false,
        description: 'Auto-approve the plan',
        required: undefined,
        options: undefined,
        min: undefined,
        max: undefined,
      },
    });
    // inputs remains dispatch-only — no dispatch trigger defined
    expect(normalized.inputs).toBeUndefined();
    // dispatch slot absent
    expect(normalized.trigger_inputs?.dispatch).toBeUndefined();
  });

  it('normalizes task_ready.inputs correctly', () => {
    const normalized = normalizePipeline({
      name: 'Task Ready Inputs',
      on: {
        task_ready: {
          inputs: {
            audience: {
              type: 'choice',
              options: ['engineer', 'designer'],
              default: 'engineer',
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    expect(normalized.trigger_inputs?.task_ready).toEqual({
      audience: {
        type: 'choice',
        options: ['engineer', 'designer'],
        default: 'engineer',
        description: undefined,
        required: undefined,
        min: undefined,
        max: undefined,
      },
    });
    expect(normalized.inputs).toBeUndefined();
  });

  it('normalizes mixed-trigger pipelines with distinct input maps', () => {
    const normalized = normalizePipeline({
      name: 'Mixed Triggers',
      on: {
        dispatch: {
          inputs: {
            greeting: {
              type: 'string',
              required: true,
            },
          },
        },
        plan_ready: {
          inputs: {
            auto_approve: {
              type: 'boolean',
              default: true,
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    // trigger_inputs has both triggers
    expect(normalized.trigger_inputs?.dispatch).toEqual({
      greeting: {
        type: 'string',
        required: true,
        description: undefined,
        default: undefined,
        options: undefined,
        min: undefined,
        max: undefined,
      },
    });
    expect(normalized.trigger_inputs?.plan_ready).toEqual({
      auto_approve: {
        type: 'boolean',
        default: true,
        description: undefined,
        required: undefined,
        options: undefined,
        min: undefined,
        max: undefined,
      },
    });

    // compatibility alias: inputs === dispatch inputs
    expect(normalized.inputs).toEqual(normalized.trigger_inputs?.dispatch);
  });

  it('rejects malformed on.plan_ready values', () => {
    expect(() =>
      normalizePipeline(
        parsePipelineText(`
name: Bad plan_ready string
on:
  plan_ready: yes
jobs:
  build:
    steps:
      - id: one
        run: echo ok
`),
      ),
    ).toThrow(/on\.plan_ready.*must be a plain object/);

    expect(() =>
      normalizePipeline(
        parsePipelineText(`
name: Bad plan_ready bool
on:
  plan_ready: true
jobs:
  build:
    steps:
      - id: one
        run: echo ok
`),
      ),
    ).toThrow(/on\.plan_ready.*must be a plain object/);

    expect(() =>
      normalizePipeline(
        parsePipelineText(`
name: Bad plan_ready array
on:
  plan_ready:
    - 1
    - 2
jobs:
  build:
    steps:
      - id: one
        run: echo ok
`),
      ),
    ).toThrow(/on\.plan_ready.*must be a plain object/);
  });

  it('populates trigger_inputs.plan_ready while inputs remains dispatch-only', () => {
    const normalized = normalizePipeline({
      name: 'Plan Only Inputs',
      on: {
        plan_ready: {
          inputs: {
            strategy: {
              type: 'choice',
              options: ['aggressive', 'conservative'],
              default: 'conservative',
            },
          },
        },
      },
      jobs: {
        build: {
          steps: [{ id: 'one', run: 'echo ok' }],
        },
      },
    });

    // plan_ready inputs are in trigger_inputs
    expect(normalized.trigger_inputs?.plan_ready?.strategy.type).toBe('choice');
    // compatibility alias (dispatch-only) is undefined
    expect(normalized.inputs).toBeUndefined();
  });

  it('backward compat: string shorthand triggers produce no trigger_inputs', () => {
    const dispatchNorm = normalizePipeline({
      name: 'Dispatch Shorthand',
      on: 'dispatch',
      jobs: { build: { steps: [{ id: 'one', run: 'echo ok' }] } },
    });
    expect(dispatchNorm.trigger_inputs).toBeUndefined();
    expect(dispatchNorm.inputs).toBeUndefined();

    const planReadyNorm = normalizePipeline({
      name: 'Plan Ready Shorthand',
      on: 'plan_ready',
      jobs: { build: { steps: [{ id: 'one', run: 'echo ok' }] } },
    });
    expect(planReadyNorm.trigger_inputs).toBeUndefined();
    expect(planReadyNorm.inputs).toBeUndefined();

    const taskReadyNorm = normalizePipeline({
      name: 'Task Ready Shorthand',
      on: 'task_ready',
      jobs: { build: { steps: [{ id: 'one', run: 'echo ok' }] } },
    });
    expect(taskReadyNorm.trigger_inputs).toBeUndefined();
    expect(taskReadyNorm.inputs).toBeUndefined();
  });

  it('backward compat: empty plan_ready object produces no trigger_inputs entry', () => {
    const normalized = normalizePipeline({
      name: 'Empty Plan Ready',
      on: { plan_ready: {} },
      jobs: { build: { steps: [{ id: 'one', run: 'echo ok' }] } },
    });
    expect(normalized.trigger_inputs).toBeUndefined();
    expect(normalized.inputs).toBeUndefined();
  });

  it('backward compat: mixed triggers with no plan_ready.inputs', () => {
    const normalized = normalizePipeline({
      name: 'Mixed No Plan Inputs',
      on: {
        dispatch: {
          inputs: {
            name: { type: 'string', required: true },
          },
        },
        plan_ready: {},
      },
      jobs: { build: { steps: [{ id: 'one', run: 'echo ok' }] } },
    });

    expect(normalized.trigger_inputs?.dispatch).toBeDefined();
    expect(normalized.trigger_inputs?.plan_ready).toBeUndefined();
    expect(normalized.inputs).toEqual(normalized.trigger_inputs?.dispatch);
  });

  it('normalizes pipeline plugin collections and validates step references', () => {
    const normalized = normalizePipeline({
      name: 'Plugin Collections',
      on: 'dispatch',
      plugin_collections: [
        {
          id: 'implementer_plugins',
          name: 'Implementer plugins',
          defaults: [
            {
              type: 'skill',
              source: { type: 'github', repo: 'OWNER/Skills' },
              skill_name: 'code-review',
            },
            {
              type: 'claude_plugin',
              marketplace: { type: 'github', repo: 'OWNER/Marketplace' },
              plugin_name: 'browser',
              required: true,
            },
          ],
        },
      ],
      jobs: {
        build: {
          steps: [
            {
              id: 'agent',
              uses: 'builtin/agent-prompt',
              with: { plugin_collection_id: 'implementer_plugins' },
            },
          ],
        },
      },
    });

    expect(normalized.plugin_collections?.[0].defaults).toMatchObject([
      {
        type: 'skill',
        source: { type: 'github', repo: 'owner/skills' },
        skill_name: 'code-review',
        required: false,
      },
      {
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'owner/marketplace' },
        plugin_name: 'browser',
        required: true,
      },
    ]);
  });

  it('rejects bundle defaults and unknown plugin collection references', () => {
    expect(() =>
      normalizePipeline(
        parsePipelineText(`
name: Bundle Default
on: dispatch
plugin_collections:
  - id: plugins
    name: Plugins
    defaults:
      - type: bundle
        bundle_id: local
jobs:
  build:
    steps:
      - id: one
        run: echo ok
`),
      ),
    ).toThrow(/Collections are local-only in pipeline defaults/);

    expect(() =>
      normalizePipeline({
        name: 'Unknown Collection',
        on: 'dispatch',
        plugin_collections: [
          {
            id: 'known',
            name: 'Known',
            defaults: [],
          },
        ],
        jobs: {
          build: {
            steps: [
              {
                id: 'agent',
                uses: 'builtin/agent-resume',
                with: { plugin_collection_id: 'missing' },
              },
            ],
          },
        },
      }),
    ).toThrow(/unknown plugin_collection_id "missing"/);

    expect(() =>
      normalizePipeline(
        parsePipelineText(`
name: Extra Plugin Field
on: dispatch
plugin_collections:
  - id: plugins
    name: Plugins
    defaults:
      - type: claude_plugin
        marketplace: { type: github, repo: owner/marketplace }
        plugin_name: browser
        config_name: local-only
jobs:
  build:
    steps:
      - id: one
        run: echo ok
`),
      ),
    ).toThrow(/unexpected field "config_name"/);
  });
});
