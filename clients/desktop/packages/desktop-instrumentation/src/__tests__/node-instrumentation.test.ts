import {
  createNodeInstrumentation,
  type NodeInstrumentationRecord,
} from '../node';

describe('Node instrumentation entry', () => {
  it('drops records when the host supplies no sink', () => {
    const instrumentation = createNodeInstrumentation();
    expect(() => {
      instrumentation.startOperation('canopy.agent_task', {
        operationKey: 'op_1',
      });
      instrumentation.captureError(new Error('boom'));
    }).not.toThrow();
  });

  it('redacts contexts and drops PostHog identity before the sink', () => {
    const records: NodeInstrumentationRecord[] = [];
    const instrumentation = createNodeInstrumentation({
      sink: (record) => records.push(record),
    });
    instrumentation.startOperation('canopy.chat_turn', {
      operationKey: 'op_1',
      context: {
        model: 'gpt-6.1-sol',
        distinct_id: 'person',
        path: '/Users/someone/project/file.ts',
      },
    });
    instrumentation.failOperation('canopy.chat_turn', 'abandoned', {
      operationKey: 'op_1',
    });
    instrumentation.captureError(new Error('failed at /Users/someone/x'));

    expect(records.map((record) => record.kind)).toEqual([
      'operation_started',
      'operation_failed',
      'error',
    ]);
    const [started, failed, error] = records;
    if (started?.kind !== 'operation_started') throw new Error('no start');
    expect(started.context).not.toHaveProperty('distinct_id');
    expect(started.context?.model).toBe('gpt-6.1-sol');
    expect(started.context?.path).not.toContain('someone');
    expect(failed).toEqual({
      kind: 'operation_failed',
      name: 'canopy.chat_turn',
      failureReason: 'abandoned',
      operationKey: 'op_1',
    });
    if (error?.kind !== 'error') throw new Error('no error');
    expect(error.message).not.toContain('someone');
  });

  it('keeps the host path running when the sink throws', () => {
    const instrumentation = createNodeInstrumentation({
      sink: () => {
        throw new Error('sink failed');
      },
    });
    expect(() =>
      instrumentation.succeedOperation('canopy.app_diagnostic'),
    ).not.toThrow();
  });
});
