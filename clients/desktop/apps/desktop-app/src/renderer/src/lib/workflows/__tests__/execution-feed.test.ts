import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import { patchExecution, useExecutionFeedStore } from '../execution-feed';

jest.mock('@/stores/pipelineRunsStore', () => ({
  // The events here carry a summary as their state.
  summaryFromState: (state: unknown): unknown => state,
}));

function execution(
  id: string,
  overrides: Partial<ExecutionSummary> = {},
): ExecutionSummary {
  return {
    id,
    pipeline_id: 'p',
    pipeline_name: 'Pipeline',
    status: 'running',
    started_at: '2026-10-12T10:00:00.000Z',
    cwd: '/tmp',
    ...overrides,
  };
}

describe('patchExecution', () => {
  it('patches one entry in place and keeps the order of the rest', () => {
    const list = [execution('a'), execution('b'), execution('c')];
    const next = patchExecution(
      list,
      execution('b', {
        status: 'success',
        completed_at: '2026-10-12T10:05:00.000Z',
      }),
    );

    expect(next.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(next[1]?.status).toBe('success');
    // The untouched entries are the same objects, so their rows do not redraw.
    expect(next[0]).toBe(list[0]);
    expect(next[2]).toBe(list[2]);
  });

  it('puts an execution it has not seen first', () => {
    const list = [execution('a')];
    expect(
      patchExecution(list, execution('new')).map((entry) => entry.id),
    ).toEqual(['new', 'a']);
  });

  it('returns the same list when nothing the feed shows changed', () => {
    const list = [execution('a'), execution('b')];
    // Step output arrives as events that carry an unchanged summary.
    expect(patchExecution(list, execution('b'))).toBe(list);
  });

  it('notices a hidden, report or pause-reason change', () => {
    const list = [execution('a')];
    expect(patchExecution(list, execution('a', { hidden: true }))).not.toBe(
      list,
    );
    expect(patchExecution(list, execution('a', { has_report: true }))).not.toBe(
      list,
    );
  });

  it('patches one entry of a 1,000-execution list without re-sorting it', () => {
    const list = Array.from({ length: 1000 }, (_unused, index) =>
      execution(`e-${String(index)}`),
    );
    const started = performance.now();
    let current: readonly ExecutionSummary[] = list;
    for (let index = 0; index < 200; index += 1) {
      current = patchExecution(
        current,
        execution(`e-${String(index * 5)}`, { status: 'success' }),
      );
    }
    const elapsed = performance.now() - started;

    expect(current.map((entry) => entry.id)).toEqual(
      list.map((entry) => entry.id),
    );
    // 200 event patches on 1,000 rows stay far inside one frame's budget
    // each; a re-sort per event would not.
    expect(elapsed).toBeLessThan(250);
  });
});

describe('load', () => {
  let resolveList: (entries: ExecutionSummary[]) => void = () => undefined;

  beforeEach(() => {
    const listed = new Promise<ExecutionSummary[]>((resolve) => {
      resolveList = resolve;
    });
    Reflect.set(globalThis, 'window', {
      pipelines: {
        listExecutions: async () => ({ success: true, data: await listed }),
      },
    });
    useExecutionFeedStore.setState({
      executions: [],
      loaded: false,
      loading: false,
      error: null,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  it('replaces what an earlier visit left with the fresh listing', async () => {
    // The run finished, and another was removed, while nothing subscribed.
    useExecutionFeedStore.setState({
      executions: [execution('a'), execution('gone')],
    });

    const loading = useExecutionFeedStore.getState().load();
    resolveList([execution('a', { status: 'success' })]);
    await loading;

    const { executions } = useExecutionFeedStore.getState();
    expect(executions.map((entry) => entry.id)).toEqual(['a']);
    expect(executions[0]?.status).toBe('success');
  });

  it('keeps an event that arrived while the list was loading', async () => {
    useExecutionFeedStore.setState({ executions: [execution('a')] });

    const loading = useExecutionFeedStore.getState().load();
    const store = useExecutionFeedStore.getState();
    Reflect.apply(store.applyEvent, store, [
      { state: execution('a', { status: 'failure' }) },
    ]);
    Reflect.apply(store.applyEvent, store, [{ state: execution('new') }]);
    // The listing was read before either event.
    resolveList([execution('a')]);
    await loading;

    const { executions } = useExecutionFeedStore.getState();
    expect(executions.map((entry) => entry.id)).toEqual(['new', 'a']);
    expect(executions[1]?.status).toBe('failure');
  });
});
