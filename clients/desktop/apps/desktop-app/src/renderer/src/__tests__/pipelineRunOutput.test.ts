import type { StepOutputEvent } from '@canopy/desktop-shared/types/pipeline';
import {
  appendStepOutputEvent,
  appendStepOutputEvents,
  clearExecutionStepOutput,
  getStepOutputLines,
  mergeStepOutputLines,
  type StepOutputBuffer,
} from '../lib/pipelineRunOutput';

function makeEvent(overrides: Partial<StepOutputEvent> = {}): StepOutputEvent {
  return {
    executionId: 'exec-1',
    jobId: 'job-1',
    jobName: 'Job 1',
    stepId: 'step-1',
    stepName: 'Step 1',
    attempt: 0,
    stream: 'stdout',
    data: '',
    ...overrides,
  };
}

describe('pipelineRunOutput', () => {
  it('folds a batch with the same ordering and output as individual events', () => {
    const events = [
      makeEvent({
        stepId: 'nested/child',
        data: 'stdout partial',
        stream: 'stdout',
      }),
      makeEvent({
        stepId: 'nested/child',
        data: 'stderr partial',
        stream: 'stderr',
      }),
      makeEvent({
        stepId: 'nested/child',
        data: ' complete\nnext\n',
        stream: 'stdout',
      }),
      makeEvent({
        stepId: 'nested/child',
        data: ' complete\n',
        stream: 'stderr',
      }),
    ];
    const individually = events.reduce(appendStepOutputEvent, {});
    const batched = appendStepOutputEvents({}, events);

    expect(batched).toEqual(individually);
    expect(
      getStepOutputLines(batched, 'exec-1', 'job-1', 'nested/child', 0),
    ).toEqual(['stdout partial complete', 'next', 'stderr partial complete']);
    expect(getStepOutputLines(batched, 'exec-1', 'job-1', 'nested', 0)).toEqual(
      ['stdout partial complete', 'next', 'stderr partial complete'],
    );
  });

  it('joins stdout chunks across events without breaking partial lines', () => {
    let buffer: StepOutputBuffer = {};
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ data: 'hello wor', stream: 'stdout' }),
    );
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ data: 'ld\nnext line\n', stream: 'stdout' }),
    );

    expect(getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0)).toEqual([
      'hello world',
      'next line',
    ]);
  });

  it('keeps stdout and stderr remainders separate', () => {
    let buffer: StepOutputBuffer = {};
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ data: 'std', stream: 'stdout' }),
    );
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ data: 'err', stream: 'stderr' }),
    );

    expect(getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0)).toEqual([
      'std',
      'err',
    ]);
  });

  it('isolates retry attempts with the same step id', () => {
    let buffer: StepOutputBuffer = {};
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ attempt: 0, data: 'attempt-0\n' }),
    );
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ attempt: 1, data: 'attempt-1\n' }),
    );

    expect(getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0)).toEqual([
      'attempt-0',
    ]);
    expect(getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 1)).toEqual([
      'attempt-1',
    ]);
  });

  it('isolates iteration outputs with the same step and attempt', () => {
    let buffer: StepOutputBuffer = {};
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ attempt: 0, iteration: 1, data: 'iter-1\n' }),
    );
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ attempt: 0, iteration: 2, data: 'iter-2\n' }),
    );

    expect(
      getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0, 1),
    ).toEqual(['iter-1']);
    expect(
      getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0, 2),
    ).toEqual(['iter-2']);
  });

  it('defaults missing iteration context to pass 1 buffer keys', () => {
    let buffer: StepOutputBuffer = {};
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ attempt: 0, data: 'iter-1-default\n' }),
    );

    expect(getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0)).toEqual([
      'iter-1-default',
    ]);
    expect(
      getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0, 1),
    ).toEqual(['iter-1-default']);
  });

  it('isolates recovery output from the original attempt buffer', () => {
    let buffer: StepOutputBuffer = {};
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ data: 'original failure\n' }),
    );
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ recovery: 1, data: 'recovery output\n' }),
    );

    expect(getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0)).toEqual([
      'original failure',
    ]);
    expect(
      getStepOutputLines(buffer, 'exec-1', 'job-1', 'step-1', 0, 1, 1),
    ).toEqual(['recovery output']);
  });

  it('aggregates nested step output into ancestor step buffers', () => {
    let buffer: StepOutputBuffer = {};
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({
        stepId: 'nested/child/echo',
        stepName: 'nested/child/echo',
        data: 'child line\n',
      }),
    );

    expect(
      getStepOutputLines(buffer, 'exec-1', 'job-1', 'nested/child/echo', 0),
    ).toEqual(['child line']);
    expect(
      getStepOutputLines(buffer, 'exec-1', 'job-1', 'nested/child', 0),
    ).toEqual(['child line']);
    expect(getStepOutputLines(buffer, 'exec-1', 'job-1', 'nested', 0)).toEqual([
      'child line',
    ]);
  });

  it('clears every buffered step for one execution before an external retry', () => {
    let buffer: StepOutputBuffer = {};
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({ executionId: 'retry-me', data: 'old attempt\n' }),
    );
    buffer = appendStepOutputEvent(
      buffer,
      makeEvent({
        executionId: 'keep-me',
        stepId: 'other',
        data: 'unrelated\n',
      }),
    );

    const cleared = clearExecutionStepOutput(buffer, 'retry-me');
    expect(
      getStepOutputLines(cleared, 'retry-me', 'job-1', 'step-1', 0),
    ).toEqual([]);
    expect(getStepOutputLines(cleared, 'keep-me', 'job-1', 'other', 0)).toEqual(
      ['unrelated'],
    );
  });

  it('merges persisted and buffered step output without duplicating overlap', () => {
    expect(
      mergeStepOutputLines(
        ['first line', 'second line'],
        ['second line', 'third line'],
      ),
    ).toEqual(['first line', 'second line', 'third line']);
  });

  it('preserves buffered output when no persisted overlap exists', () => {
    expect(
      mergeStepOutputLines(['first line'], ['second line', 'third line']),
    ).toEqual(['first line', 'second line', 'third line']);
  });

  it('does not append buffered lines already present in the persisted log', () => {
    expect(
      mergeStepOutputLines(
        ['first line', 'second line'],
        ['first line', 'second line'],
      ),
    ).toEqual(['first line', 'second line']);
  });

  it('uses the complete live buffer when persisted output is an earlier prefix', () => {
    expect(
      mergeStepOutputLines(
        ['first line', 'second line'],
        ['first line', 'second line', 'third line'],
      ),
    ).toEqual(['first line', 'second line', 'third line']);
  });

  it('deduplicates full buffer overlap even when longer than the search window', () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
    expect(mergeStepOutputLines(lines, lines)).toEqual(lines);
  });

  describe('matrix variant isolation', () => {
    it('keeps variant output separate when both run the same step id', () => {
      let buffer: StepOutputBuffer = {};
      buffer = appendStepOutputEvent(
        buffer,
        makeEvent({ jobId: 'job-1--matrix-0', data: 'from variant 0\n' }),
      );
      buffer = appendStepOutputEvent(
        buffer,
        makeEvent({ jobId: 'job-1--matrix-1', data: 'from variant 1\n' }),
      );

      expect(
        getStepOutputLines(buffer, 'exec-1', 'job-1--matrix-0', 'step-1', 0),
      ).toEqual(['from variant 0']);
      expect(
        getStepOutputLines(buffer, 'exec-1', 'job-1--matrix-1', 'step-1', 0),
      ).toEqual(['from variant 1']);
    });

    it('leaves ordinary job keys unchanged', () => {
      let buffer: StepOutputBuffer = {};
      buffer = appendStepOutputEvent(buffer, makeEvent({ data: 'plain\n' }));

      expect(Object.keys(buffer)).toEqual([
        ['exec-1', 'job-1', 'step-1', '0', '1', '0'].join('\0'),
      ]);
    });

    it('clears every variant buffer for an execution at once', () => {
      let buffer: StepOutputBuffer = {};
      buffer = appendStepOutputEvent(
        buffer,
        makeEvent({ jobId: 'job-1--matrix-0', data: 'a\n' }),
      );
      buffer = appendStepOutputEvent(
        buffer,
        makeEvent({ jobId: 'job-1--matrix-1', data: 'b\n' }),
      );

      expect(clearExecutionStepOutput(buffer, 'exec-1')).toEqual({});
    });
  });
});
