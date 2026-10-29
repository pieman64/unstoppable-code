import {
  canCancelMatrixVariant,
  canResumeExecution,
  canRetryExecution,
  canRetryAllMatrixVariants,
  canRetryFailedMatrixVariants,
  canRetryMatrixExpansion,
  canRetryMatrixJob,
  canRetryMatrixVariant,
  canRerunExecution,
  getRetryableMatrixVariantIds,
  isTerminalExecutionStatus,
  isTerminalMatrixVariantStatus,
  type MatrixJobActionSummary,
  type MatrixVariantActionSummary,
} from '../execution-actions';

const GATES: Readonly<
  Record<'resume' | 'retry' | 'rerun', typeof canResumeExecution>
> = {
  resume: canResumeExecution,
  retry: canRetryExecution,
  rerun: canRerunExecution,
};

interface GateCase {
  readonly gate: keyof typeof GATES;
  readonly status: string;
  readonly parent?: string;
  readonly expected: boolean;
}

const CASES: readonly GateCase[] = [
  // Resume only a paused root execution.
  { gate: 'resume', status: 'paused', expected: true },
  { gate: 'resume', status: 'running', expected: false },
  { gate: 'resume', status: 'success', expected: false },
  { gate: 'resume', status: 'failure', expected: false },
  { gate: 'resume', status: 'cancelled', expected: false },
  { gate: 'resume', status: 'paused', parent: 'parent', expected: false },
  // Retry a failed or cancelled root execution, never a child or a success.
  { gate: 'retry', status: 'failure', expected: true },
  { gate: 'retry', status: 'cancelled', expected: true },
  { gate: 'retry', status: 'success', expected: false },
  { gate: 'retry', status: 'cancelled', parent: 'parent', expected: false },
  // Rerun any settled root execution, cancelled included.
  { gate: 'rerun', status: 'success', expected: true },
  { gate: 'rerun', status: 'cancelled', expected: true },
];

describe('execution action gates', () => {
  it.each(CASES)(
    '$gate is $expected for a $status execution (parent: $parent)',
    ({ gate, status, parent, expected }) => {
      expect(GATES[gate]({ status, parent_execution_id: parent })).toBe(
        expected,
      );
    },
  );
});

function variant(job_id: string, status: string): MatrixVariantActionSummary {
  return { job_id, status };
}

const group: MatrixJobActionSummary = {
  kind: 'matrix',
  status: 'failure',
  expansion: 'expanded',
  variant_job_ids: ['v0', 'v1', 'v2', 'v3'],
};
const variants = {
  v0: variant('v0', 'success'),
  v1: variant('v1', 'failure'),
  v2: variant('v2', 'cancelled'),
  v3: variant('v3', 'skipped'),
};

describe('matrix execution action gates', () => {
  it('recognizes terminal execution and variant states', () => {
    expect(isTerminalExecutionStatus('failure')).toBe(true);
    expect(isTerminalExecutionStatus('paused')).toBe(false);
    expect(isTerminalMatrixVariantStatus('skipped')).toBe(true);
    expect(isTerminalMatrixVariantStatus('running')).toBe(false);
  });

  it('retries a matrix group only after execution and group settle', () => {
    expect(canRetryMatrixJob('running', group)).toBe(false);
    expect(canRetryMatrixJob('failure', group)).toBe(true);
    expect(canRetryMatrixJob('failure', { ...group, kind: 'single' })).toBe(
      false,
    );
    expect(canRetryMatrixJob('failure', { ...group, status: 'running' })).toBe(
      false,
    );
  });

  it('retries failed/cancelled variants and cancels only live variants', () => {
    expect(canRetryMatrixVariant(variants.v1)).toBe(true);
    expect(canRetryMatrixVariant(variants.v2)).toBe(true);
    expect(canRetryMatrixVariant(variants.v0)).toBe(false);
    expect(canCancelMatrixVariant('paused', variant('v4', 'paused'))).toBe(
      true,
    );
    expect(canCancelMatrixVariant('running', variant('v4', 'queued'))).toBe(
      true,
    );
    expect(canCancelMatrixVariant('failure', variant('v4', 'running'))).toBe(
      false,
    );
  });

  it('returns retryable physical IDs in persisted matrix order', () => {
    expect(getRetryableMatrixVariantIds(group, variants)).toEqual(['v1', 'v2']);
  });

  it('offers only matrix retry modes accepted by the backend', () => {
    expect(canRetryAllMatrixVariants('failure', group)).toBe(true);
    expect(canRetryFailedMatrixVariants('failure', group, variants)).toBe(true);
    expect(
      canRetryAllMatrixVariants('failure', {
        ...group,
        variant_job_ids: [],
      }),
    ).toBe(false);
    expect(
      canRetryFailedMatrixVariants('failure', group, {
        ...variants,
        v1: variant('v1', 'success'),
        v2: variant('v2', 'success'),
      }),
    ).toBe(false);
    expect(
      canRetryMatrixExpansion(
        'failure',
        { ...group, expansion: 'failure', variant_job_ids: [] },
        true,
      ),
    ).toBe(true);
    expect(
      canRetryMatrixExpansion(
        'failure',
        { ...group, expansion: 'failure', variant_job_ids: [] },
        false,
      ),
    ).toBe(false);
  });
});
