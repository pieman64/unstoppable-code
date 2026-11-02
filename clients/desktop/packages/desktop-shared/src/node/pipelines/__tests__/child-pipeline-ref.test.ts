import { resolveChildPipelineRef } from '../child-pipeline-ref';

const workerId = '5b0f4c3e-2a1d-4e6f-9c8b-7a6d5e4f3a2b';

describe('resolveChildPipelineRef', () => {
  it('returns a literal ref trimmed', () => {
    expect(resolveChildPipelineRef({ ref: `  ${workerId}\n` })).toEqual({
      kind: 'literal',
      raw: workerId,
    });
  });

  it('resolves an env-only ref from the pipeline env', () => {
    expect(
      resolveChildPipelineRef({
        ref: '${{ env.WORKER_PIPELINE }}',
        pipelineEnv: { WORKER_PIPELINE: workerId },
      }),
    ).toEqual({
      kind: 'resolved',
      raw: '${{ env.WORKER_PIPELINE }}',
      evaluated: workerId,
    });
  });

  it('trims a padded env value the way the run-time resolver trims', () => {
    expect(
      resolveChildPipelineRef({
        ref: " ${{ env['WORKER_PIPELINE'] }} ",
        pipelineEnv: { WORKER_PIPELINE: `  ${workerId}  ` },
      }),
    ).toEqual({
      kind: 'resolved',
      raw: "${{ env['WORKER_PIPELINE'] }}",
      evaluated: workerId,
    });
  });

  it('lets a literal job env value override the pipeline value', () => {
    expect(
      resolveChildPipelineRef({
        ref: '${{ env.WORKER_PIPELINE }}',
        pipelineEnv: { WORKER_PIPELINE: 'pipeline-level' },
        jobEnv: { WORKER_PIPELINE: workerId },
      }),
    ).toEqual({
      kind: 'resolved',
      raw: '${{ env.WORKER_PIPELINE }}',
      evaluated: workerId,
    });
  });

  it('is unresolved when a job env expression overrides a literal pipeline value', () => {
    expect(
      resolveChildPipelineRef({
        ref: '${{ env.WORKER_PIPELINE }}',
        pipelineEnv: { WORKER_PIPELINE: workerId },
        jobEnv: { WORKER_PIPELINE: '${{ inputs.worker }}' },
      }),
    ).toEqual({
      kind: 'unresolved',
      raw: '${{ env.WORKER_PIPELINE }}',
      reason: 'expression_env_value',
    });
  });

  it('is unresolved when the env value nests an expression', () => {
    expect(
      resolveChildPipelineRef({
        ref: '${{ env.WORKER_PIPELINE }}',
        pipelineEnv: {
          WORKER_PIPELINE: 'worker-${{ env.SUFFIX }}',
          SUFFIX: 'a',
        },
      }),
    ).toMatchObject({ kind: 'unresolved', reason: 'expression_env_value' });
  });

  it('is unresolved for an inputs ref', () => {
    expect(resolveChildPipelineRef({ ref: '${{ inputs.target }}' })).toEqual({
      kind: 'unresolved',
      raw: '${{ inputs.target }}',
      reason: 'non_env_reference',
    });
  });

  it('is unresolved for a step output ref and for an env ref combined with one', () => {
    expect(
      resolveChildPipelineRef({ ref: '${{ steps.pick.outputs.id }}' }),
    ).toMatchObject({ kind: 'unresolved', reason: 'non_env_reference' });
    expect(
      resolveChildPipelineRef({
        ref: "${{ env.WORKER_PIPELINE || 'fallback' }}",
        pipelineEnv: { WORKER_PIPELINE: workerId },
      }),
    ).toMatchObject({ kind: 'unresolved', reason: 'non_env_reference' });
  });

  it('is unresolved for a name only the run environment can supply', () => {
    expect(
      resolveChildPipelineRef({ ref: '${{ env.WORKER_PIPELINE }}' }),
    ).toMatchObject({ kind: 'unresolved', reason: 'runtime_env' });
  });

  it('is unresolved for a name defined on the step, which `with` never sees', () => {
    expect(
      resolveChildPipelineRef({
        ref: '${{ env.WORKER_PIPELINE }}',
        pipelineEnv: { WORKER_PIPELINE: workerId },
        stepEnv: { WORKER_PIPELINE: 'step-level' },
      }),
    ).toMatchObject({ kind: 'unresolved', reason: 'step_env' });
  });

  it('is unresolved for an expression the run would leave as authored', () => {
    expect(
      resolveChildPipelineRef({
        ref: '${{ env.WORKER_PIPELINE',
        pipelineEnv: { WORKER_PIPELINE: workerId },
      }),
    ).toMatchObject({ kind: 'unresolved', reason: 'non_env_reference' });
  });

  it('is unresolved when the ref evaluates to nothing', () => {
    expect(
      resolveChildPipelineRef({
        ref: '${{ env.WORKER_PIPELINE }}',
        pipelineEnv: { WORKER_PIPELINE: '  ' },
      }),
    ).toMatchObject({ kind: 'unresolved', reason: 'empty' });
  });

  it('resolves a mixed literal-plus-expression ref', () => {
    expect(
      resolveChildPipelineRef({
        ref: 'workers/${{ env.WORKER }}-${{ env.VARIANT }}.yaml',
        pipelineEnv: { WORKER: 'review', VARIANT: 1 },
        jobEnv: { VARIANT: 'fast' },
      }),
    ).toEqual({
      kind: 'resolved',
      raw: 'workers/${{ env.WORKER }}-${{ env.VARIANT }}.yaml',
      evaluated: 'workers/review-fast.yaml',
    });
  });
});
