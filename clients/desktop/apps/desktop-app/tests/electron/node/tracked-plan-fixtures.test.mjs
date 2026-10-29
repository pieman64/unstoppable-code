import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSharedPlanDetail } from '../mock-server/routes/shared-plans.mjs';
import { SHARE_MEMBERSHIP_TEAM } from '../seeders/shareMembership.mjs';
import {
  assertSeedableTrackedPlan,
  buildPlanCommentThread,
  buildTrackedPlan,
  diagramNodeAnchor,
  documentAnchor,
  generalAnchor,
  readyDiagramArtifacts,
  remoteComment,
  SEEDED_SHARED_PLAN_SNAPSHOT_HASH,
  SHARED_PLAN_TEAMMATES,
  sharedPlanServerSeed,
  teamShareState,
  toWireCommentThreads,
  userComment,
  dataModelDiffFor,
} from '../seeders/trackedPlanFixtures.mjs';

const CONTENT = '# Fixture plan\n\n- Build the parser.\n- Ship the renderer.';

function basePlan(overrides = {}) {
  return buildTrackedPlan({
    id: 'fixture-plan',
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    title: 'Fixture plan',
    content: CONTENT,
    ...overrides,
  });
}

function thread(overrides = {}) {
  return buildPlanCommentThread({
    id: 'thread-1',
    anchor: documentAnchor({
      quote: '- Build the parser.',
      renderedText: 'Build the parser.',
    }),
    comments: [
      remoteComment({
        id: 'comment-1',
        author: SHARED_PLAN_TEAMMATES.ada,
        body: 'Parser first?',
      }),
    ],
    ...overrides,
  });
}

test('buildTrackedPlan produces a reader-valid plan whose last revision is the content', () => {
  const plan = basePlan({ latestRevisionNumber: 3, hidden: true });
  assert.equal(plan.revisions.length, 3);
  assert.deepEqual(
    plan.revisions.map((revision) => revision.revisionNumber),
    [1, 2, 3],
  );
  assert.equal(plan.revisions.at(-1).content, CONTENT);
  assert.equal(plan.hidden, true);
  assert.deepEqual(plan.linkedExecutionIds, []);
  assert.equal(assertSeedableTrackedPlan(plan), plan);
});

test('assertSeedableTrackedPlan names the field that would empty the plans file', () => {
  const cases = [
    [{ linkedExecutionIds: undefined }, /linkedExecutionIds/],
    [{ source: 'robot' }, /source/],
    [
      { share: { ...teamShareState({ remoteId: 'r' }), shareScope: 'public' } },
      /share\.shareScope/,
    ],
    [
      {
        commentThreads: [
          thread({
            comments: [
              { id: 'c', author: 'remote', body: 'x', createdAt: 'now' },
            ],
          }),
        ],
      },
      /remoteAuthor/,
    ],
    [
      {
        commentThreads: [
          thread({ anchor: documentAnchor({ quote: 'Not in the plan.' }) }),
        ],
      },
      /anchorState.*outdated/,
    ],
    [{ commentThreads: [thread({ anchorState: 'outdated' })] }, /matched/],
    [{ commentThreads: [thread(), thread()] }, /duplicate id/],
    [
      {
        diagrams: {
          sequence: { data: null, derivedFromRevision: 1, status: 'ready' },
        },
      },
      /ready without data/,
    ],
    [
      {
        diagrams: readyDiagramArtifacts({
          dataModelDiff: {
            ...dataModelDiffFor(),
            changes: [{ id: 'x', type: 'added', entityId: 'plan' }],
          },
        }),
      },
      /dataModelDiff\.data/,
    ],
  ];
  const valid = basePlan();
  for (const [overrides, pattern] of cases) {
    assert.throws(
      () => assertSeedableTrackedPlan({ ...valid, ...overrides }),
      pattern,
      JSON.stringify(overrides).slice(0, 80),
    );
  }
});

test('comment anchors follow the app: general and quote-less diagram notes stay matched', () => {
  const plan = basePlan({
    commentThreads: [
      thread({ id: 'general', anchor: generalAnchor() }),
      thread({
        id: 'diagram',
        anchor: diagramNodeAnchor({
          diagramKind: 'sequence',
          planNodeId: 'phase-1',
          title: 'Phase 1',
        }),
      }),
      thread({
        id: 'outdated',
        anchor: documentAnchor({ quote: '- Removed step.' }),
        anchorState: 'outdated',
      }),
    ],
  });
  assert.deepEqual(
    plan.commentThreads.map((entry) => [entry.id, entry.anchorState]),
    [
      ['general', 'matched'],
      ['diagram', 'matched'],
      ['outdated', 'outdated'],
    ],
  );
  assert.equal(plan.commentThreads[1].anchor.unanchored, true);
  assert.equal(plan.commentThreads[1].anchor.source, 'diagram');
});

test('the wire projection and server seed mirror a synced team share', () => {
  const local = [
    thread({
      comments: [
        remoteComment({
          id: 'remote-1',
          author: SHARED_PLAN_TEAMMATES.grace,
          body: 'Handed off already.',
          submittedToChat: true,
        }),
        userComment({ id: 'draft-1', body: 'Draft.', staged: true }),
      ],
    }),
    thread({ id: 'empty', comments: [] }),
  ];
  const wire = toWireCommentThreads(local);
  assert.deepEqual(
    wire.map((entry) => entry.id),
    ['thread-1'],
  );
  assert.doesNotMatch(JSON.stringify(wire), /staged|submittedToChat/);
  assert.deepEqual(
    wire[0].comments[0].remoteAuthor,
    SHARED_PLAN_TEAMMATES.grace,
  );

  const share = teamShareState({ remoteId: 'remote-plan' });
  assert.deepEqual(share, {
    serverId: 'canopy-cloud',
    remoteId: 'remote-plan',
    shareScope: 'team',
    teamId: SHARE_MEMBERSHIP_TEAM.id,
    syncStatus: 'synced',
    lastSyncedAt: '2026-06-11T12:00:00.000Z',
    lastSyncedLocalRevisionNumber: 1,
    lastSyncedRemoteRevisionNumber: 1,
    lastSyncedSnapshotHash: SEEDED_SHARED_PLAN_SNAPSHOT_HASH,
  });

  const plan = basePlan({ commentThreads: local.slice(0, 1), share });
  const detail = buildSharedPlanDetail(
    sharedPlanServerSeed({ remoteId: 'remote-plan', plan }),
  );
  assert.equal(detail.snapshotHash, SEEDED_SHARED_PLAN_SNAPSHOT_HASH);
  assert.equal(detail.content, CONTENT);
  assert.deepEqual(detail.commentThreads, wire);
  // The desktop derives the team share from the owner on every reply.
  assert.equal(detail.shareScope, 'team');
  assert.equal(detail.owner.type, 'team');
  assert.equal(detail.owner.id, share.teamId);
});
