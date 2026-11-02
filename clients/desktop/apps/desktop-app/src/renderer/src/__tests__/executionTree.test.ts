import type { ExecutionSummary } from '@canopy/desktop-shared/types/pipeline';
import {
  buildExecutionTree,
  collectVisibleExecutionTreeNodes,
  pruneExpandedIdsToExpandableNodes,
} from '../lib/executionTree';

function makeSummary(
  overrides: Partial<ExecutionSummary> & { id: string },
): ExecutionSummary {
  return {
    pipeline_id: 'test',
    pipeline_name: overrides.id,
    status: 'success',
    started_at: new Date().toISOString(),
    cwd: '/tmp',
    ...overrides,
    status_reasons: overrides.status_reasons ?? [],
  };
}

describe('buildExecutionTree', () => {
  it('returns roots with no children for flat summaries', () => {
    const summaries = [makeSummary({ id: 'a' }), makeSummary({ id: 'b' })];
    const tree = buildExecutionTree(summaries);
    expect(tree).toHaveLength(2);
    expect(tree[0].children).toHaveLength(0);
    expect(tree[0].depth).toBe(0);
  });

  it('nests children under their parent', () => {
    const summaries = [
      makeSummary({ id: 'parent' }),
      makeSummary({
        id: 'child',
        parent_execution_id: 'parent',
        parent_step_id: 's1',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    expect(tree).toHaveLength(1);
    expect(tree[0].summary.id).toBe('parent');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].summary.id).toBe('child');
    expect(tree[0].children[0].depth).toBe(1);
  });

  it('handles deep nesting (grandchildren)', () => {
    const summaries = [
      makeSummary({ id: 'root' }),
      makeSummary({
        id: 'child',
        parent_execution_id: 'root',
        parent_step_id: 's1',
      }),
      makeSummary({
        id: 'grandchild',
        parent_execution_id: 'child',
        parent_step_id: 's2',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    expect(tree).toHaveLength(1);
    expect(tree[0].children[0].children[0].summary.id).toBe('grandchild');
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it('treats orphaned children as roots when parent is missing', () => {
    const summaries = [
      makeSummary({
        id: 'orphan',
        parent_execution_id: 'deleted-parent',
        parent_step_id: 's1',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    expect(tree).toHaveLength(1);
    expect(tree[0].summary.id).toBe('orphan');
    expect(tree[0].depth).toBe(0);
  });

  it('handles multiple children per parent', () => {
    const summaries = [
      makeSummary({ id: 'parent' }),
      makeSummary({
        id: 'c1',
        parent_execution_id: 'parent',
        parent_step_id: 's1',
      }),
      makeSummary({
        id: 'c2',
        parent_execution_id: 'parent',
        parent_step_id: 's2',
      }),
      makeSummary({
        id: 'c3',
        parent_execution_id: 'parent',
        parent_step_id: 's3',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toHaveLength(3);
  });
});

describe('pruneExpandedIdsToExpandableNodes', () => {
  it('keeps parent collapsed by default when a child is running', () => {
    const summaries = [
      makeSummary({ id: 'parent' }),
      makeSummary({
        id: 'child',
        parent_execution_id: 'parent',
        parent_step_id: 's1',
        status: 'running',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    const expanded = pruneExpandedIdsToExpandableNodes(tree, new Set());
    expect(expanded.size).toBe(0);
  });

  it('keeps ancestors collapsed by default when a grandchild fails', () => {
    const summaries = [
      makeSummary({ id: 'root' }),
      makeSummary({
        id: 'child',
        parent_execution_id: 'root',
        parent_step_id: 's1',
      }),
      makeSummary({
        id: 'grandchild',
        parent_execution_id: 'child',
        parent_step_id: 's2',
        status: 'failure',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    const expanded = pruneExpandedIdsToExpandableNodes(tree, new Set());
    expect(expanded.size).toBe(0);
  });

  it('preserves existing expanded ids for expandable nodes', () => {
    const summaries = [
      makeSummary({ id: 'parent' }),
      makeSummary({
        id: 'child',
        parent_execution_id: 'parent',
        parent_step_id: 's1',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    const existing = new Set(['parent']);
    const expanded = pruneExpandedIdsToExpandableNodes(tree, existing);
    expect(expanded.has('parent')).toBe(true);
  });

  it('drops expanded ids for nodes that are no longer expandable', () => {
    const summaries = [makeSummary({ id: 'parent' })];
    const tree = buildExecutionTree(summaries);
    const expanded = pruneExpandedIdsToExpandableNodes(
      tree,
      new Set(['parent']),
    );
    expect(expanded.size).toBe(0);
  });

  it('returns early when there are no expanded ids to prune', () => {
    const summaries = [
      makeSummary({ id: 'parent' }),
      makeSummary({
        id: 'child',
        parent_execution_id: 'parent',
        parent_step_id: 's1',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    const expanded = pruneExpandedIdsToExpandableNodes(tree, new Set());
    expect(expanded.size).toBe(0);
  });

  it('does not expand when all children are successful', () => {
    const summaries = [
      makeSummary({ id: 'parent' }),
      makeSummary({
        id: 'child',
        parent_execution_id: 'parent',
        parent_step_id: 's1',
        status: 'success',
      }),
    ];
    const tree = buildExecutionTree(summaries);
    const expanded = pruneExpandedIdsToExpandableNodes(tree, new Set());
    expect(expanded.size).toBe(0);
  });
});

describe('collectVisibleExecutionTreeNodes', () => {
  it('includes descendants only while every ancestor is expanded', () => {
    const tree = buildExecutionTree([
      makeSummary({ id: 'root' }),
      makeSummary({
        id: 'child',
        parent_execution_id: 'root',
        parent_step_id: 's1',
      }),
      makeSummary({
        id: 'grandchild',
        parent_execution_id: 'child',
        parent_step_id: 's2',
      }),
    ]);

    expect(
      collectVisibleExecutionTreeNodes(tree, new Set()).map(
        (node) => node.summary.id,
      ),
    ).toEqual(['root']);
    expect(
      collectVisibleExecutionTreeNodes(tree, new Set(['root'])).map(
        (node) => node.summary.id,
      ),
    ).toEqual(['root', 'child']);
    expect(
      collectVisibleExecutionTreeNodes(tree, new Set(['root', 'child'])).map(
        (node) => node.summary.id,
      ),
    ).toEqual(['root', 'child', 'grandchild']);
  });
});
