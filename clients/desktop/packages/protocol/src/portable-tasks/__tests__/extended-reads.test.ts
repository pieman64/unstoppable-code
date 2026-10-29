import {
  diffResultSchema,
  pipelinePageSchema,
  pipelineRunGetResultSchema,
  planGetResultSchema,
  planPageSchema,
  pullRequestResultSchema,
  remoteInventoryResultSchema,
} from '../index';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const RPC = {
  source: 'live',
  observationKind: 'desktop_rpc',
  observedAt: null,
  repliedAt: '2026-10-17T12:00:00.000Z',
} as const;

describe('remote extended read schemas', () => {
  it('accepts a plan page and bounds plan content in UTF-8 bytes', () => {
    const summary = {
      planId: ID,
      projectId: ID,
      worktreeId: OTHER_ID,
      title: 'Ship it',
      status: 'draft',
      reviewStatus: null,
      updatedAt: null,
    };
    expect(
      planPageSchema.safeParse({ items: [summary], nextCursor: null, ...RPC })
        .success,
    ).toBe(true);
    const detail = {
      ...summary,
      truncated: false,
      revisionNumber: null,
      approvedAt: null,
      dismissedAt: null,
    };
    expect(
      planGetResultSchema.safeParse({
        plan: { ...detail, content: 'é'.repeat(24576) },
        ...RPC,
      }).success,
    ).toBe(true);
    expect(
      planGetResultSchema.safeParse({
        plan: { ...detail, content: 'é'.repeat(24577) },
        ...RPC,
      }).success,
    ).toBe(false);
  });

  it('caps the diff patch and file list', () => {
    const base = {
      projectId: ID,
      worktreeId: OTHER_ID,
      diffSource: 'combined',
      files: [],
      filesTruncated: false,
      patchTruncated: false,
      rangeLabel: null,
      ...RPC,
    };
    expect(
      diffResultSchema.safeParse({ ...base, patch: 'x'.repeat(32768) }).success,
    ).toBe(true);
    expect(
      diffResultSchema.safeParse({ ...base, patch: 'x'.repeat(32769) }).success,
    ).toBe(false);
    expect(
      diffResultSchema.safeParse({
        ...base,
        patch: '',
        files: Array.from({ length: 201 }, () => ({
          path: 'a.ts',
          previousPath: null,
          status: 'modified',
          insertions: 1,
          deletions: 0,
        })),
      }).success,
    ).toBe(false);
  });

  it('accepts a worktree without a pull request', () => {
    expect(
      pullRequestResultSchema.safeParse({
        projectId: ID,
        worktreeId: OTHER_ID,
        pullRequest: null,
        source: 'cached',
        observationKind: 'server_held',
        observedAt: null,
        repliedAt: null,
      }).success,
    ).toBe(true);
  });

  it('requires the concrete worktree on pipeline rows and bounds run output', () => {
    const row = {
      pipelineId: ID,
      projectId: ID,
      worktreeId: OTHER_ID,
      name: 'Review',
      description: null,
      origin: 'bundled',
      triggerTypes: ['dispatch'],
      latestRun: null,
    };
    expect(
      pipelinePageSchema.safeParse({ items: [row], nextCursor: null, ...RPC })
        .success,
    ).toBe(true);
    expect(
      pipelinePageSchema.safeParse({
        items: [{ ...row, worktreeId: null }],
        nextCursor: null,
        ...RPC,
      }).success,
    ).toBe(false);
    const run = {
      runId: ID,
      pipelineId: ID,
      projectId: ID,
      worktreeId: OTHER_ID,
      pipelineName: null,
      status: 'running',
      startedAt: null,
      finishedAt: null,
      progress: { completedSteps: 1, totalSteps: 3 },
      outputTruncated: true,
    };
    expect(
      pipelineRunGetResultSchema.safeParse({
        run: { ...run, outputTail: 'x'.repeat(8192) },
        ...RPC,
      }).success,
    ).toBe(true);
    expect(
      pipelineRunGetResultSchema.safeParse({
        run: { ...run, outputTail: 'x'.repeat(8193) },
        ...RPC,
      }).success,
    ).toBe(false);
  });

  it('accepts only the four inventory lanes and closed rows', () => {
    const item = { itemId: ID, kind: 'skill', name: 'Review', version: null };
    const page = {
      nextCursor: null,
      source: 'cached',
      observationKind: 'server_held',
      observedAt: null,
      repliedAt: null,
    };
    expect(
      remoteInventoryResultSchema.safeParse({ items: [item], ...page }).success,
    ).toBe(true);
    expect(
      remoteInventoryResultSchema.safeParse({
        items: [{ ...item, kind: 'hook' }],
        ...page,
      }).success,
    ).toBe(false);
    expect(
      remoteInventoryResultSchema.safeParse({
        items: [{ ...item, path: '/Users/me/.skills/review' }],
        ...page,
      }).success,
    ).toBe(false);
  });
});
