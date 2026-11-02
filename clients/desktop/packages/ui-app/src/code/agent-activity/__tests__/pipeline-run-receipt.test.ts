import type { PipelineRunArtifactReceiptV1 } from '@canopy/protocol/agent-artifacts';
import type { PipelineRunSummary } from '../../activity/pipeline/PipelineRunRows';
import {
  normalizePipelineRunStatus,
  pipelineRunReceiptSummary,
  pipelineRunReceiptView,
} from '../pipeline-run-receipt';

const CREATED_AT = '2026-10-16T12:00:00.000Z';

const RECEIPT: PipelineRunArtifactReceiptV1 = {
  version: 1,
  kind: 'pipeline_run',
  operation: 'pipeline.run',
  dedupeKey: 'canopy:pipeline_run:local:e1',
  createdAt: CREATED_AT,
  executionId: 'e1',
  pipelineId: 'p1',
  pipelineName: 'Ship',
  initialStatus: 'running',
  queuedAt: CREATED_AT,
  projectId: 'proj',
  worktreeId: 'wt',
  navigationTarget: {
    kind: 'pipeline_execution',
    executionId: 'e1',
    projectId: 'proj',
    worktreeId: 'wt',
  },
};

function summary(
  overrides: Partial<PipelineRunSummary> & { id: string },
): PipelineRunSummary {
  return {
    pipeline_id: 'p1',
    pipeline_name: 'Ship',
    status: 'success',
    status_reasons: [],
    started_at: CREATED_AT,
    ...overrides,
  };
}

describe('pipelineRunReceiptSummary', () => {
  it('maps the receipt snapshot onto a run summary', () => {
    expect(pipelineRunReceiptSummary(RECEIPT)).toEqual({
      id: 'e1',
      pipeline_id: 'p1',
      pipeline_name: 'Ship',
      status: 'running',
      status_reasons: [],
      started_at: CREATED_AT,
      project_id: 'proj',
      worktree_id: 'wt',
    });
  });

  it('prefers startedAt over queuedAt', () => {
    expect(
      pipelineRunReceiptSummary({
        ...RECEIPT,
        startedAt: '2026-10-16T12:00:05.000Z',
      }).started_at,
    ).toBe('2026-10-16T12:00:05.000Z');
  });
});

describe('normalizePipelineRunStatus', () => {
  it('keeps known statuses and maps anything else to pending', () => {
    expect(normalizePipelineRunStatus('failure')).toBe('failure');
    expect(normalizePipelineRunStatus('weird')).toBe('pending');
    expect(normalizePipelineRunStatus(undefined)).toBe('pending');
  });
});

describe('pipelineRunReceiptView', () => {
  it('uses the receipt snapshot when no host state is present', () => {
    const view = pipelineRunReceiptView(RECEIPT, []);
    expect(view.summary).toMatchObject({
      id: 'e1',
      pipeline_name: 'Ship',
      status: 'running',
    });
    expect(view.node).toEqual({
      summary: view.summary,
      children: [],
      depth: 0,
    });
    expect(view.summaryLookup).toEqual({ e1: view.summary });
  });

  it('keeps the receipt start time when the stored run has none', () => {
    const view = pipelineRunReceiptView(RECEIPT, [
      summary({ id: 'e1', status: 'pending', started_at: '' }),
    ]);
    expect(view.summary.started_at).toBe(CREATED_AT);
    expect(view.summary.status).toBe('pending');
  });

  it('prefers stored fields over the receipt, then the live override', () => {
    const stored = summary({
      id: 'e1',
      pipeline_name: 'Ship v2',
      status: 'paused',
      planId: 'plan-stored',
    });
    const view = pipelineRunReceiptView(RECEIPT, [stored], {
      planId: 'plan-live',
    });
    expect(view.summary).toMatchObject({
      pipeline_name: 'Ship v2',
      status: 'paused',
      planId: 'plan-live',
    });
  });

  it('normalizes an unknown live status to pending', () => {
    const view = pipelineRunReceiptView(RECEIPT, [], { status: 'queued' });
    expect(view.summary.status).toBe('pending');
  });

  it('keeps the stored status when the live override has none', () => {
    const view = pipelineRunReceiptView(
      RECEIPT,
      [summary({ id: 'e1', status: 'failure' })],
      { status: undefined, planId: 'plan-1' },
    );
    expect(view.summary.status).toBe('failure');
  });

  it('places the run under its parent when the parent is present', () => {
    const parent = summary({ id: 'parent' });
    const view = pipelineRunReceiptView(RECEIPT, [
      parent,
      summary({ id: 'e1', parent_execution_id: 'parent' }),
    ]);
    expect(view.node.depth).toBe(1);
    expect(view.node.summary.id).toBe('e1');
  });

  it('builds a depth-0 node when the parent is absent', () => {
    const view = pipelineRunReceiptView(RECEIPT, [
      summary({ id: 'e1', parent_execution_id: 'missing' }),
    ]);
    expect(view.node.depth).toBe(0);
  });

  it('includes child runs in the node and every summary in the lookup', () => {
    const child = summary({ id: 'child', parent_execution_id: 'e1' });
    const other = summary({ id: 'other' });
    const view = pipelineRunReceiptView(RECEIPT, [
      summary({ id: 'e1', status: 'running' }),
      child,
      other,
    ]);
    expect(view.node.children.map((node) => node.summary.id)).toEqual([
      'child',
    ]);
    expect(view.summaryLookup).toEqual({
      child,
      other,
      e1: view.summary,
    });
  });
});
