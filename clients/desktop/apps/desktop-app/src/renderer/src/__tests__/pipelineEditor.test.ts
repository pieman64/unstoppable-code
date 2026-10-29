import type {
  Pipeline,
  Job,
  Step,
} from '@canopy/desktop-shared/types/pipeline';
import {
  MAX_ITERATIONS_LIMIT,
  MAX_RETRIES_LIMIT,
} from '@canopy/desktop-shared/pipelines/normalize-pipeline';
import {
  initClaudeModels,
  initModelAliases,
} from '@canopy/desktop-shared/types';
import {
  isValidPipelineIdentifier,
  createJobId,
  createStepId,
  renameJobId,
  isPipelineSelectionValid,
  getDraftValidation,
  getSafeJobOrder,
} from '../lib/pipelineEditor';

function makeStep(overrides: Partial<Step> = {}): Step {
  return { name: 'test', run: 'echo hi', ...overrides };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return { steps: [makeStep()], ...overrides };
}

function makePipeline(
  jobs: Record<string, Job>,
  overrides: Partial<Pipeline> = {},
): Pipeline {
  return {
    name: 'test-pipeline',
    version: '1',
    on: 'dispatch',
    jobs,
    ...overrides,
  };
}

function isPipelineFixture(value: unknown): value is Pipeline {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseUncheckedPipelineFixture(value: unknown): Pipeline {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isPipelineFixture(parsed)) {
    throw new Error('Expected pipeline fixture');
  }
  return parsed;
}

describe('isValidPipelineIdentifier', () => {
  it('accepts valid identifiers', () => {
    expect(isValidPipelineIdentifier('job_1')).toBe(true);
    expect(isValidPipelineIdentifier('_private')).toBe(true);
    expect(isValidPipelineIdentifier('Build')).toBe(true);
    expect(isValidPipelineIdentifier('a')).toBe(true);
  });

  it('rejects invalid identifiers', () => {
    expect(isValidPipelineIdentifier('1bad')).toBe(false);
    expect(isValidPipelineIdentifier('has-dash')).toBe(false);
    expect(isValidPipelineIdentifier('has space')).toBe(false);
    expect(isValidPipelineIdentifier('')).toBe(false);
    expect(isValidPipelineIdentifier('has.dot')).toBe(false);
  });
});

describe('createJobId', () => {
  it('returns job_1 when no existing IDs', () => {
    expect(createJobId([])).toBe('job_1');
  });

  it('skips existing IDs', () => {
    expect(createJobId(['job_1'])).toBe('job_2');
    expect(createJobId(['job_1', 'job_2'])).toBe('job_3');
  });

  it('returns a valid identifier', () => {
    const id = createJobId(['job_1', 'job_2', 'job_3']);
    expect(isValidPipelineIdentifier(id)).toBe(true);
  });
});

describe('createStepId', () => {
  it('returns step_1 when no existing IDs', () => {
    expect(createStepId([])).toBe('step_1');
  });

  it('skips existing IDs', () => {
    expect(createStepId(['step_1'])).toBe('step_2');
  });

  it('returns a valid identifier', () => {
    const id = createStepId(['step_1']);
    expect(isValidPipelineIdentifier(id)).toBe(true);
  });
});

describe('renameJobId', () => {
  it('renames the job key', () => {
    const pipeline = makePipeline({ build: makeJob() });
    const result = renameJobId(pipeline, 'build', 'compile');
    expect(result.jobs['compile']).toBeDefined();
    expect(result.jobs['build']).toBeUndefined();
  });

  it('preserves key order', () => {
    const pipeline = makePipeline({
      first: makeJob(),
      second: makeJob(),
      third: makeJob(),
    });
    const result = renameJobId(pipeline, 'second', 'middle');
    expect(Object.keys(result.jobs)).toEqual(['first', 'middle', 'third']);
  });

  it('updates string needs references', () => {
    const pipeline = makePipeline({
      build: makeJob(),
      test: makeJob({ needs: 'build' }),
    });
    const result = renameJobId(pipeline, 'build', 'compile');
    expect(result.jobs['test'].needs).toBe('compile');
  });

  it('updates array needs references', () => {
    const pipeline = makePipeline({
      build: makeJob(),
      lint: makeJob(),
      test: makeJob({ needs: ['build', 'lint'] }),
    });
    const result = renameJobId(pipeline, 'build', 'compile');
    expect(result.jobs['test'].needs).toEqual(['compile', 'lint']);
  });
});

describe('isPipelineSelectionValid', () => {
  it('accepts no selection', () => {
    const pipeline = makePipeline({ build: makeJob() });
    expect(isPipelineSelectionValid(pipeline, { type: 'none' })).toBe(true);
  });

  it('accepts existing job and step selections', () => {
    const pipeline = makePipeline({
      build: makeJob({ steps: [makeStep(), makeStep()] }),
    });

    expect(
      isPipelineSelectionValid(pipeline, { type: 'job', jobId: 'build' }),
    ).toBe(true);
    expect(
      isPipelineSelectionValid(pipeline, {
        type: 'step',
        jobId: 'build',
        stepIndex: 1,
      }),
    ).toBe(true);
  });

  it('rejects selections for removed jobs', () => {
    const pipeline = makePipeline({ build: makeJob() });

    expect(
      isPipelineSelectionValid(pipeline, { type: 'job', jobId: 'missing' }),
    ).toBe(false);
    expect(
      isPipelineSelectionValid(pipeline, {
        type: 'step',
        jobId: 'missing',
        stepIndex: 0,
      }),
    ).toBe(false);
  });

  it('rejects stale step indexes', () => {
    const pipeline = makePipeline({ build: makeJob({ steps: [makeStep()] }) });

    expect(
      isPipelineSelectionValid(pipeline, {
        type: 'step',
        jobId: 'build',
        stepIndex: -1,
      }),
    ).toBe(false);
    expect(
      isPipelineSelectionValid(pipeline, {
        type: 'step',
        jobId: 'build',
        stepIndex: 1,
      }),
    ).toBe(false);
  });
});

describe('getDraftValidation', () => {
  it('returns no issues for a valid pipeline', () => {
    const pipeline = makePipeline({
      build: makeJob({
        steps: [makeStep({ id: 'step_1', run: 'echo build' })],
      }),
    });
    const issues = getDraftValidation(pipeline);
    expect(issues.filter((i) => i.type === 'error')).toHaveLength(0);
  });

  it('flags invalid job IDs', () => {
    const pipeline = makePipeline({
      'bad-id': makeJob(),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some((i) => i.type === 'error' && i.message.includes('bad-id')),
    ).toBe(true);
  });

  it('flags invalid step IDs', () => {
    const pipeline = makePipeline({
      build: makeJob({ steps: [makeStep({ id: '1bad' })] }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some((i) => i.type === 'error' && i.message.includes('1bad')),
    ).toBe(true);
  });

  it('flags duplicate step IDs within a job', () => {
    const pipeline = makePipeline({
      build: makeJob({
        steps: [
          makeStep({ id: 'dup', run: 'echo 1' }),
          makeStep({ id: 'dup', run: 'echo 2' }),
        ],
      }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some((i) => i.type === 'error' && i.message.includes('Duplicate')),
    ).toBe(true);
  });

  it('flags steps with both run and uses', () => {
    const pipeline = makePipeline({
      build: makeJob({
        steps: [{ run: 'echo hi', uses: 'builtin/test' }],
      }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) =>
          i.type === 'error' && i.message.includes('both "run" and "uses"'),
      ),
    ).toBe(true);
  });

  it('warns on steps with neither run nor uses', () => {
    const pipeline = makePipeline({
      build: makeJob({ steps: [{ name: 'empty' }] }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) =>
          i.type === 'warning' &&
          i.message.includes('neither "run" nor "uses"'),
      ),
    ).toBe(true);
  });

  it('flags unknown dependencies', () => {
    const pipeline = makePipeline({
      build: makeJob({ needs: 'nonexistent' }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'error' && i.message.includes('nonexistent'),
      ),
    ).toBe(true);
  });

  it('flags invalid max_retries values', () => {
    const pipeline = makePipeline({
      build: makeJob({ max_retries: -1 }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'error' && i.message.includes('max_retries'),
      ),
    ).toBe(true);
  });

  it('flags max_retries exceeding the upper bound', () => {
    const pipeline = makePipeline({
      build: makeJob({ max_retries: MAX_RETRIES_LIMIT + 1 }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'error' && i.message.includes('max_retries'),
      ),
    ).toBe(true);
  });

  it('flags invalid max_iterations values', () => {
    const pipeline = makePipeline({
      build: makeJob({ max_iterations: -1 }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'error' && i.message.includes('max_iterations'),
      ),
    ).toBe(true);
  });

  it('flags max_iterations exceeding the upper bound', () => {
    const pipeline = makePipeline({
      build: makeJob({ max_iterations: MAX_ITERATIONS_LIMIT + 1 }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'error' && i.message.includes('max_iterations'),
      ),
    ).toBe(true);
  });

  it('allows max_iterations expressions', () => {
    const pipeline = makePipeline({
      build: makeJob({
        max_iterations: '${{ needs.complexity.outputs.qa_max_iterations }}',
      }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'error' && i.message.includes('max_iterations'),
      ),
    ).toBe(false);
  });

  it('flags cyclic dependencies', () => {
    const pipeline = makePipeline({
      a: makeJob({ needs: 'b' }),
      b: makeJob({ needs: 'a' }),
    });
    const issues = getDraftValidation(pipeline);
    expect(issues.some((i) => i.type === 'error' && i.path === 'jobs')).toBe(
      true,
    );
  });

  it('warns on absolute working_directory', () => {
    const pipeline = makePipeline({
      build: makeJob({
        steps: [makeStep({ working_directory: '/usr/local' })],
      }),
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'warning' && i.message.includes('Absolute'),
      ),
    ).toBe(true);
  });

  it('accepts a missing pipeline scope (defaults to directory)', () => {
    const pipeline = makePipeline({ build: makeJob() });
    const issues = getDraftValidation(pipeline);
    expect(issues.some((i) => i.path === 'scope')).toBe(false);
  });

  it('accepts valid pipeline scope declarations', () => {
    const single = getDraftValidation(
      makePipeline({ build: makeJob() }, { scope: 'worktree' }),
    );
    expect(single.some((i) => i.path === 'scope')).toBe(false);
    const multi = getDraftValidation(
      makePipeline({ build: makeJob() }, { scope: ['global', 'directory'] }),
    );
    expect(multi.some((i) => i.path === 'scope')).toBe(false);
  });

  it('flags an unsupported pipeline scope', () => {
    const pipeline = parseUncheckedPipelineFixture({
      ...makePipeline({ build: makeJob() }),
      scope: 'chat-project',
    });
    const issues = getDraftValidation(pipeline);
    expect(issues.some((i) => i.type === 'error' && i.path === 'scope')).toBe(
      true,
    );
  });

  it('accepts a valid run-pipeline target', () => {
    const pipeline = makePipeline({
      build: makeJob({
        steps: [
          {
            uses: 'builtin/run-pipeline',
            target: {
              scope: 'worktree',
              workspace_id: 'ws',
              worktree: { id: 'wt' },
            },
          },
        ],
      }),
    });
    const issues = getDraftValidation(pipeline);
    expect(issues.filter((i) => i.type === 'error')).toHaveLength(0);
  });

  it('flags a camelCase worktree target field', () => {
    const pipeline = parseUncheckedPipelineFixture({
      ...makePipeline({ build: makeJob() }),
      jobs: {
        build: {
          steps: [
            {
              uses: 'builtin/run-pipeline',
              // camelCase `workspaceId` is rejected — snake_case only.
              target: {
                scope: 'worktree',
                workspaceId: 'ws',
              },
            },
          ],
        },
      },
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'error' && i.message.toLowerCase().includes('target'),
      ),
    ).toBe(true);
  });

  it('flags an unsupported target scope', () => {
    const pipeline = parseUncheckedPipelineFixture({
      ...makePipeline({ build: makeJob() }),
      jobs: {
        build: {
          steps: [
            {
              uses: 'builtin/run-pipeline',
              target: { scope: 'chat-project' },
            },
          ],
        },
      },
    });
    const issues = getDraftValidation(pipeline);
    expect(
      issues.some(
        (i) => i.type === 'error' && i.message.toLowerCase().includes('target'),
      ),
    ).toBe(true);
  });
});

describe('getSafeJobOrder', () => {
  it('returns topological order for a valid graph', () => {
    const pipeline = makePipeline({
      build: makeJob(),
      test: makeJob({ needs: 'build' }),
    });
    const result = getSafeJobOrder(pipeline);
    expect(result.order).toEqual(['build', 'test']);
    expect(result.error).toBeUndefined();
  });

  it('falls back to Object.keys order on cycle', () => {
    const pipeline = makePipeline({
      a: makeJob({ needs: 'b' }),
      b: makeJob({ needs: 'a' }),
    });
    const result = getSafeJobOrder(pipeline);
    expect(result.order).toEqual(['a', 'b']);
    expect(result.error).toBeDefined();
  });
});

describe('getDraftValidation — model aliases', () => {
  it('accepts an alias with no defaults (required at dispatch)', () => {
    const pipeline = makePipeline(
      { build: makeJob() },
      { model_aliases: [{ id: 'writer', name: 'Writer' }] },
    );
    const errors = getDraftValidation(pipeline).filter(
      (i) => i.type === 'error',
    );
    expect(errors).toHaveLength(0);
  });

  it('flags a blank alias id', () => {
    const pipeline = makePipeline(
      { build: makeJob() },
      { model_aliases: [{ id: '', name: 'Writer' }] },
    );
    expect(
      getDraftValidation(pipeline).some(
        (i) =>
          i.type === 'error' && /Model alias ID is required/.test(i.message),
      ),
    ).toBe(true);
  });

  it('flags a duplicate alias id', () => {
    const pipeline = makePipeline(
      { build: makeJob() },
      {
        model_aliases: [
          { id: 'writer', name: 'A' },
          { id: 'writer', name: 'B' },
        ],
      },
    );
    expect(
      getDraftValidation(pipeline).some(
        (i) => i.type === 'error' && /Duplicate model alias ID/.test(i.message),
      ),
    ).toBe(true);
  });

  it.each(['has spaces', '-bad', '_bad'])(
    'flags an invalid alias id pattern: %s',
    (id) => {
      const pipeline = makePipeline(
        { build: makeJob() },
        { model_aliases: [{ id, name: 'A' }] },
      );
      expect(
        getDraftValidation(pipeline).some(
          (i) =>
            i.type === 'error' &&
            /Invalid model alias ID/.test(i.message) &&
            /start with a letter or number/.test(i.message),
        ),
      ).toBe(true);
    },
  );

  it('accepts an alias id that starts with a digit', () => {
    const pipeline = makePipeline(
      { build: makeJob() },
      { model_aliases: [{ id: '1-reviewer', name: 'A' }] },
    );
    expect(
      getDraftValidation(pipeline).some(
        (i) => i.type === 'error' && /Invalid model alias ID/.test(i.message),
      ),
    ).toBe(false);
  });

  it('flags an inline default with an empty base model', () => {
    const pipeline = makePipeline(
      { build: makeJob() },
      { model_aliases: [{ id: 'writer', name: 'A', defaults: { base: '' } }] },
    );
    expect(
      getDraftValidation(pipeline).some(
        (i) =>
          i.type === 'error' &&
          /inline default must set a base model/.test(i.message),
      ),
    ).toBe(true);
  });

  it('warns on a model-aware step whose with.model matches no alias or model', () => {
    const pipeline = makePipeline(
      {
        build: makeJob({
          steps: [
            makeStep({
              run: undefined,
              uses: 'builtin/agent-prompt',
              with: { model: 'totally-made-up-alias' },
            }),
          ],
        }),
      },
      { model_aliases: [{ id: 'reviewer', name: 'Reviewer' }] },
    );
    expect(
      getDraftValidation(pipeline).some(
        (i) =>
          i.type === 'warning' &&
          /matches no defined model alias/.test(i.message),
      ),
    ).toBe(true);
  });

  it('warns on an agent-resume step whose with.model matches no alias or model', () => {
    const pipeline = makePipeline(
      {
        build: makeJob({
          steps: [
            makeStep({
              run: undefined,
              uses: 'builtin/agent-resume',
              with: { model: 'totally-made-up-alias' },
            }),
          ],
        }),
      },
      { model_aliases: [{ id: 'reviewer', name: 'Reviewer' }] },
    );
    expect(
      getDraftValidation(pipeline).some(
        (i) =>
          i.type === 'warning' &&
          /matches no defined model alias/.test(i.message),
      ),
    ).toBe(true);
  });

  it.each(['builtin/agent-prompt', 'builtin/agent-resume'])(
    'accepts built-in model aliases in %s without changing the authored value',
    (uses) => {
      for (const model of ['$cheap', '$fast', '$default-codex', '  $cheap  ']) {
        const pipeline = makePipeline({
          build: makeJob({
            steps: [makeStep({ run: undefined, uses, with: { model } })],
          }),
        });
        expect(
          getDraftValidation(pipeline).filter((issue) =>
            /matches no defined model alias/.test(issue.message),
          ),
        ).toEqual([]);
        expect(pipeline.jobs.build?.steps[0]?.with?.model).toBe(model);
      }
    },
  );

  it.each(['builtin/agent-prompt', 'builtin/agent-resume'])(
    'still warns about an unknown built-in model alias in %s',
    (uses) => {
      const pipeline = makePipeline({
        build: makeJob({
          steps: [
            makeStep({ run: undefined, uses, with: { model: '$unknown' } }),
          ],
        }),
      });
      expect(
        getDraftValidation(pipeline).some(
          (issue) =>
            issue.type === 'warning' &&
            issue.message.includes('Step model "$unknown"'),
        ),
      ).toBe(true);
    },
  );

  it.each(['constructor', 'toString', '__proto__'])(
    'does not recognize inherited object properties as built-in aliases: %s',
    (model) => {
      const pipeline = makePipeline({
        build: makeJob({
          steps: [
            makeStep({
              run: undefined,
              uses: 'builtin/agent-prompt',
              with: { model },
            }),
          ],
        }),
      });
      expect(
        getDraftValidation(pipeline).some(
          (issue) =>
            issue.type === 'warning' &&
            issue.message.includes(`Step model "${model}"`),
        ),
      ).toBe(true);
    },
  );

  it('does not warn when with.model references a defined alias id', () => {
    const pipeline = makePipeline(
      {
        build: makeJob({
          steps: [
            makeStep({
              run: undefined,
              uses: 'builtin/agent-prompt',
              with: { model: 'reviewer' },
            }),
          ],
        }),
      },
      { model_aliases: [{ id: 'reviewer', name: 'Reviewer' }] },
    );
    expect(
      getDraftValidation(pipeline).some(
        (i) =>
          i.type === 'warning' &&
          /matches no defined model alias/.test(i.message),
      ),
    ).toBe(false);
  });

  it('does not warn when with.model references a configured runtime alias', () => {
    initClaudeModels([{ id: 'opus[1m]', label: 'Opus 1M' }]);
    initModelAliases({ opus: 'opus[1m]' });

    try {
      const pipeline = makePipeline({
        build: makeJob({
          steps: [
            makeStep({
              run: undefined,
              uses: 'builtin/agent-prompt',
              with: { model: 'opus' },
            }),
          ],
        }),
      });
      expect(
        getDraftValidation(pipeline).some(
          (i) =>
            i.type === 'warning' &&
            /matches no defined model alias/.test(i.message),
        ),
      ).toBe(false);
    } finally {
      initModelAliases({});
      initClaudeModels([]);
    }
  });
});

describe('matrix editor validation', () => {
  function matrixIssues(job: Partial<Job> | Record<string, unknown>): string[] {
    const pipeline = parseUncheckedPipelineFixture({
      ...makePipeline({ build: makeJob() }),
      jobs: { build: { ...makeJob(), ...job } },
    });
    return getDraftValidation(pipeline)
      .filter((issue) => issue.type === 'error')
      .map((issue) => issue.message);
  }

  it('accepts static and dynamic matrix definitions', () => {
    expect(
      matrixIssues({ strategy: { matrix: { os: ['mac', 'win'] } } }),
    ).toEqual([]);
    expect(
      matrixIssues({ strategy: { matrix: '${{ inputs.targets }}' } }),
    ).toEqual([]);
  });

  it('rejects the removed PR 2047 fields', () => {
    expect(matrixIssues({ foreach: ['a'] })).toContain(
      'Job "build" uses removed field "foreach". Replace it with "strategy.matrix"',
    );
    expect(matrixIssues({ max_parallel: 3 })).toContain(
      'Job "build" defines legacy top-level "max_parallel". Move it to "strategy.max_parallel"',
    );
  });

  it('validates max_parallel inside strategy', () => {
    expect(
      matrixIssues({
        strategy: { matrix: { target: ['a'] }, max_parallel: 3 },
      }),
    ).toEqual([]);
    expect(
      matrixIssues({
        strategy: { matrix: { target: ['a'] }, max_parallel: 0 },
      }),
    ).toContain(
      'Job "build" strategy.max_parallel must be an integer from 1 through 256',
    );
  });
});
