import {
  getNestedRootPipelineExecutionId,
  loadNestedRootPipelineExecutionId,
  resolveRootPipelineExecutionId,
} from '../root-pipeline-execution';

describe('resolveRootPipelineExecutionId', () => {
  it('resolves the complete parent chain to its root execution', () => {
    expect(
      resolveRootPipelineExecutionId(
        { id: 'child', parent_execution_id: 'parent' },
        [{ id: 'parent', parent_execution_id: 'root' }, { id: 'root' }],
      ),
    ).toBe('root');
  });

  it('returns the current execution id for a root execution', () => {
    expect(resolveRootPipelineExecutionId({ id: 'root' }, [])).toBe('root');
    expect(
      getNestedRootPipelineExecutionId({ id: 'root' }, []),
    ).toBeUndefined();
  });

  it('does not guess when a parent is missing or the chain cycles', () => {
    expect(
      resolveRootPipelineExecutionId(
        { id: 'child', parent_execution_id: 'missing' },
        [],
      ),
    ).toBeUndefined();
    expect(
      resolveRootPipelineExecutionId(
        { id: 'child', parent_execution_id: 'parent' },
        [
          { id: 'parent', parent_execution_id: 'child' },
          { id: 'child', parent_execution_id: 'parent' },
        ],
      ),
    ).toBeUndefined();
  });

  it('rejects an inconsistent parent chain instead of choosing an ancestor', () => {
    expect(
      resolveRootPipelineExecutionId(
        { id: 'child', parent_execution_id: 'parent' },
        [{ id: 'other' }],
      ),
    ).toBeUndefined();
  });

  it('loads and verifies each parent before returning a nested root id', async () => {
    const executionById = new Map([
      ['parent', { id: 'parent', parent_execution_id: 'root' }],
      ['root', { id: 'root' }],
    ]);

    await expect(
      loadNestedRootPipelineExecutionId(
        { id: 'child', parent_execution_id: 'parent' },
        (executionId) => Promise.resolve(executionById.get(executionId)),
      ),
    ).resolves.toBe('root');
    await expect(
      loadNestedRootPipelineExecutionId(
        { id: 'child', parent_execution_id: 'missing' },
        () => Promise.resolve(undefined),
      ),
    ).resolves.toBeUndefined();
    await expect(
      loadNestedRootPipelineExecutionId(
        { id: 'child', parent_execution_id: 'parent' },
        (executionId) =>
          Promise.resolve(
            executionId === 'parent'
              ? { id: 'parent', parent_execution_id: 'child' }
              : { id: 'child', parent_execution_id: 'parent' },
          ),
      ),
    ).resolves.toBeUndefined();
  });
});
