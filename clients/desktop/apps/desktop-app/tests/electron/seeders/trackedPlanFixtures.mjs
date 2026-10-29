import { SHARE_MEMBERSHIP_TEAM } from './shareMembership.mjs';

/**
 * Pure builders for tracked-plan fixtures: plans, share state, comment
 * threads, diagram artifacts, and the matching shared-plan server seed.
 *
 * Shapes mirror `TrackedPlanData` (packages/desktop-shared/src/types.ts),
 * `PlanCommentThread` (packages/desktop-shared/src/types/plan-diagrams.ts),
 * and the wire contracts in packages/protocol/src/plans/index.ts. The desktop
 * reads a plans file all-or-nothing: one invalid plan silently empties the
 * whole worktree's list (`readTrackedPlansFile`). Every builder therefore ends
 * in `assertSeedableTrackedPlan`, which fails fast with the offending field.
 *
 * This module is imported by Electron specs, the capture spec, and the
 * performance harness, so it stays free of `@canopy/*` imports and I/O.
 * `seedTrackedPlans` writes the result; its behavior is unchanged.
 */

/**
 * @typedef {{ userId: string, displayName: string | null }} SharedPlanTeammate
 * @typedef {'user' | 'agent' | 'remote'} PlanCommentAuthorFixture
 * @typedef {{
 *   quote: string,
 *   renderedText?: string,
 *   lineStart?: number,
 *   lineEnd?: number,
 *   planNodeId?: string,
 *   headingPath?: string[],
 *   unanchored?: boolean,
 *   source?: 'document' | 'diagram',
 *   diagramKind?: 'sequence' | 'logicDiff' | 'dataModelDiff',
 * }} PlanCommentAnchorFixture
 * @typedef {{
 *   id: string,
 *   author: PlanCommentAuthorFixture,
 *   remoteAuthor?: SharedPlanTeammate,
 *   body: string,
 *   createdAt: string,
 *   staged?: boolean,
 *   submittedToChat?: boolean,
 * }} PlanCommentFixture
 * @typedef {{
 *   id: string,
 *   status: 'open' | 'resolved',
 *   createdAt: string,
 *   anchor: PlanCommentAnchorFixture,
 *   anchorState: 'matched' | 'outdated',
 *   comments: PlanCommentFixture[],
 * }} PlanCommentThreadFixture
 * @typedef {{
 *   sequence?: object,
 *   logicDiff?: object,
 *   dataModelDiff?: object,
 * }} PlanDiagramArtifactsFixture
 * @typedef {{
 *   serverId: string,
 *   remoteId: string,
 *   shareScope: 'private' | 'team' | 'organization',
 *   teamId?: string,
 *   organizationId?: string,
 *   syncStatus: 'pending' | 'syncing' | 'synced' | 'error',
 *   lastSyncedAt?: string,
 *   lastSyncedLocalRevisionNumber?: number,
 *   lastSyncedRemoteRevisionNumber?: number,
 *   lastSyncedSnapshotHash?: string,
 *   lastSyncError?: string,
 * }} TrackedPlanShareFixture
 * @typedef {{
 *   id: string,
 *   projectId: string,
 *   worktreeId: string,
 *   source: string,
 *   title: string,
 *   content: string,
 *   reviewStatus: string,
 *   createdAt: string,
 *   updatedAt: string,
 *   latestRevisionNumber: number,
 *   revisions: object[],
 *   linkedExecutionIds: string[],
 *   hidden?: boolean,
 *   diagrams?: PlanDiagramArtifactsFixture,
 *   commentThreads?: PlanCommentThreadFixture[],
 *   share?: TrackedPlanShareFixture,
 * }} TrackedPlanFixture
 */

/** Fixed timestamp for durable fixtures. */
export const SHARED_PLAN_FIXTURE_TIME = '2026-06-11T12:00:00.000Z';

/**
 * Placeholder snapshot hash seeded on both the local share state and the mock
 * server. The desktop's real hash includes live Git state, so a seed cannot
 * reproduce it; matching placeholders let the startup full-content `PUT`
 * pass the server's `expectedSnapshotHash` check instead.
 */
export const SEEDED_SHARED_PLAN_SNAPSHOT_HASH =
  'e2e-seeded-shared-plan-snapshot';

/** `CANOPY_CLOUD_SERVER_ID` from desktop-shared constants. */
export const SHARED_PLAN_SERVER_ID = 'canopy-cloud';

/** Teammates who comment from the web. Ids match sharedContainerInviteFixture. */
export const SHARED_PLAN_TEAMMATES = Object.freeze({
  ada: Object.freeze({
    userId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Ada Lovelace',
  }),
  grace: Object.freeze({
    userId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Grace Hopper',
  }),
  unresolved: Object.freeze({
    userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    displayName: null,
  }),
});

const PLAN_SOURCES = new Set([
  'claude',
  'codex',
  'ollama',
  'pipeline',
  'imported',
  'detected',
]);
const REVIEW_STATUSES = new Set(['pending', 'approved', 'dismissed']);
const SYNC_STATUSES = new Set(['pending', 'syncing', 'synced', 'error']);
const SHARE_SCOPES = new Set(['private', 'team', 'organization']);
const DIAGRAM_STATUSES = new Set([
  'pending',
  'generating',
  'ready',
  'stale',
  'error',
]);
const COMMENT_AUTHORS = new Set(['user', 'agent', 'remote']);
const DIAGRAM_KINDS = ['sequence', 'logicDiff', 'dataModelDiff'];

// ── Validation ────────────────────────────────────────────────────────────

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optional(value, type) {
  return value === undefined || typeof value === type;
}

function fail(planId, field, detail = '') {
  throw new Error(
    `Unseedable tracked plan ${String(planId)}: ${field}${detail ? ` (${detail})` : ''}`,
  );
}

function assertShareState(planId, share) {
  if (!isRecord(share)) fail(planId, 'share');
  if (typeof share.serverId !== 'string') fail(planId, 'share.serverId');
  if (typeof share.remoteId !== 'string') fail(planId, 'share.remoteId');
  if (!SHARE_SCOPES.has(share.shareScope)) fail(planId, 'share.shareScope');
  if (!optional(share.teamId, 'string')) fail(planId, 'share.teamId');
  if (!optional(share.organizationId, 'string')) {
    fail(planId, 'share.organizationId');
  }
  if (!SYNC_STATUSES.has(share.syncStatus)) fail(planId, 'share.syncStatus');
  for (const field of [
    'lastSyncedAt',
    'lastSyncedSnapshotHash',
    'lastSyncError',
  ]) {
    if (!optional(share[field], 'string')) fail(planId, `share.${field}`);
  }
  for (const field of [
    'lastSyncedLocalRevisionNumber',
    'lastSyncedRemoteRevisionNumber',
  ]) {
    if (!optional(share[field], 'number')) fail(planId, `share.${field}`);
  }
}

function assertDiagramData(planId, kind, data) {
  const field = `diagrams.${kind}.data`;
  if (!isRecord(data) || data.schemaVersion !== 1) fail(planId, field);
  if (kind === 'sequence') {
    if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
      fail(planId, field, 'nodes/edges');
    }
    const ids = new Set(data.nodes.map((node) => node.id));
    for (const node of data.nodes) {
      if (
        typeof node.id !== 'string' ||
        (node.kind !== 'phase' && node.kind !== 'task') ||
        typeof node.title !== 'string' ||
        typeof node.description !== 'string' ||
        !isRecord(node.planAnchor)
      ) {
        fail(planId, field, `node ${String(node.id)}`);
      }
    }
    for (const edge of data.edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) {
        fail(planId, field, `edge ${edge.from}->${edge.to}`);
      }
    }
    return;
  }
  if (!isRecord(data.current) || !isRecord(data.planned)) {
    fail(planId, field, 'current/planned');
  }
  if (!Array.isArray(data.changes)) fail(planId, field, 'changes');
  if (kind === 'logicDiff') {
    for (const flow of [data.current, data.planned]) {
      if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
        fail(planId, field, 'flow nodes/edges');
      }
    }
    return;
  }
  // dataModelDiff mirrors `isDataModelDiffDiagram`: entities need `fields[]`
  // and every change is discriminated by `target`.
  for (const graph of [data.current, data.planned]) {
    if (!Array.isArray(graph.entities) || !Array.isArray(graph.relationships)) {
      fail(planId, field, 'entities/relationships');
    }
    for (const entity of graph.entities) {
      if (
        typeof entity.id !== 'string' ||
        typeof entity.name !== 'string' ||
        !Array.isArray(entity.fields) ||
        !entity.fields.every(
          (entry) =>
            typeof entry.id === 'string' && typeof entry.name === 'string',
        )
      ) {
        fail(planId, field, `entity ${String(entity.id)}`);
      }
    }
  }
  for (const change of data.changes) {
    const valid =
      typeof change.id === 'string' &&
      ['added', 'removed', 'changed'].includes(change.type) &&
      ((change.target === 'entity' && typeof change.entityId === 'string') ||
        (change.target === 'field' &&
          typeof change.entityId === 'string' &&
          typeof change.fieldId === 'string') ||
        (change.target === 'relationship' &&
          typeof change.relationshipId === 'string'));
    if (!valid) fail(planId, field, `change ${String(change.id)}`);
  }
}

function assertDiagrams(planId, diagrams) {
  if (!isRecord(diagrams)) fail(planId, 'diagrams');
  for (const kind of DIAGRAM_KINDS) {
    const artifact = diagrams[kind];
    if (artifact === undefined) continue;
    if (
      !isRecord(artifact) ||
      typeof artifact.derivedFromRevision !== 'number' ||
      !DIAGRAM_STATUSES.has(artifact.status) ||
      !('data' in artifact)
    ) {
      fail(planId, `diagrams.${kind}`);
    }
    if (artifact.data !== null) assertDiagramData(planId, kind, artifact.data);
    if (artifact.status === 'ready' && artifact.data === null) {
      fail(planId, `diagrams.${kind}`, 'ready without data');
    }
  }
}

function assertComment(planId, threadId, comment) {
  const field = `commentThreads.${threadId}.comments.${String(comment?.id)}`;
  if (
    !isRecord(comment) ||
    typeof comment.id !== 'string' ||
    !COMMENT_AUTHORS.has(comment.author) ||
    typeof comment.body !== 'string' ||
    typeof comment.createdAt !== 'string' ||
    !optional(comment.staged, 'boolean') ||
    !optional(comment.submittedToChat, 'boolean')
  ) {
    fail(planId, field);
  }
  if (comment.author === 'remote') {
    const author = comment.remoteAuthor;
    if (
      !isRecord(author) ||
      typeof author.userId !== 'string' ||
      (author.displayName !== null && typeof author.displayName !== 'string')
    ) {
      fail(planId, `${field}.remoteAuthor`);
    }
  }
}

function assertThreads(planId, threads, content) {
  if (!Array.isArray(threads)) fail(planId, 'commentThreads');
  const ids = new Set();
  for (const thread of threads) {
    if (
      !isRecord(thread) ||
      typeof thread.id !== 'string' ||
      (thread.status !== 'open' && thread.status !== 'resolved') ||
      typeof thread.createdAt !== 'string' ||
      !isRecord(thread.anchor) ||
      typeof thread.anchor.quote !== 'string' ||
      (thread.anchorState !== 'matched' && thread.anchorState !== 'outdated') ||
      !Array.isArray(thread.comments)
    ) {
      fail(planId, `commentThreads.${String(thread?.id)}`);
    }
    if (ids.has(thread.id))
      fail(planId, `commentThreads.${thread.id}`, 'duplicate id');
    ids.add(thread.id);
    for (const comment of thread.comments) {
      assertComment(planId, thread.id, comment);
    }
    // The desktop re-evaluates anchors against the plan content on every
    // merge: a quote that is not an exact raw substring becomes `outdated`
    // and collapses into the archive. Keep fixtures honest about which state
    // the app will render.
    const expected =
      thread.anchor.unanchored === true || content.includes(thread.anchor.quote)
        ? 'matched'
        : 'outdated';
    if (thread.anchorState !== expected) {
      fail(
        planId,
        `commentThreads.${thread.id}.anchorState`,
        `the app computes ${expected} for this quote`,
      );
    }
  }
}

/**
 * Throw unless `plan` passes the desktop's `isTrackedPlanData` reader guard
 * (plus the anchor re-evaluation the merge applies).
 */
export function assertSeedableTrackedPlan(plan) {
  if (!isRecord(plan)) fail(plan, 'plan');
  const id = plan.id;
  for (const field of [
    'id',
    'projectId',
    'worktreeId',
    'title',
    'content',
    'createdAt',
    'updatedAt',
  ]) {
    if (typeof plan[field] !== 'string') fail(id, field);
  }
  if (!PLAN_SOURCES.has(plan.source)) fail(id, 'source');
  if (!REVIEW_STATUSES.has(plan.reviewStatus)) fail(id, 'reviewStatus');
  if (typeof plan.latestRevisionNumber !== 'number') {
    fail(id, 'latestRevisionNumber');
  }
  for (const field of [
    'approvedAt',
    'dismissedAt',
    'sourceFilePath',
    'sourceRepoId',
  ]) {
    if (!optional(plan[field], 'string')) fail(id, field);
  }
  if (!Array.isArray(plan.revisions) || plan.revisions.length === 0) {
    fail(id, 'revisions');
  }
  for (const revision of plan.revisions) {
    if (
      !isRecord(revision) ||
      typeof revision.revisionNumber !== 'number' ||
      typeof revision.content !== 'string' ||
      !PLAN_SOURCES.has(revision.source) ||
      !REVIEW_STATUSES.has(revision.reviewStatus) ||
      typeof revision.createdAt !== 'string' ||
      !optional(revision.approvedAt, 'string') ||
      !optional(revision.dismissedAt, 'string')
    ) {
      fail(id, `revisions.${String(revision?.revisionNumber)}`);
    }
  }
  const latest = plan.revisions.at(-1);
  if (
    latest.revisionNumber !== plan.latestRevisionNumber ||
    latest.content !== plan.content
  ) {
    fail(id, 'revisions', 'the last revision must match the plan content');
  }
  if (
    !Array.isArray(plan.linkedExecutionIds) ||
    !plan.linkedExecutionIds.every((entry) => typeof entry === 'string')
  ) {
    fail(id, 'linkedExecutionIds');
  }
  if (!optional(plan.hidden, 'boolean')) fail(id, 'hidden');
  if (
    plan.lastEditSource !== undefined &&
    plan.lastEditSource !== 'agent' &&
    plan.lastEditSource !== 'pipeline'
  ) {
    fail(id, 'lastEditSource');
  }
  if (plan.diagrams !== undefined) assertDiagrams(id, plan.diagrams);
  if (plan.commentThreads !== undefined) {
    assertThreads(id, plan.commentThreads, plan.content);
  }
  if (plan.share !== undefined) assertShareState(id, plan.share);
  return plan;
}

// ── Plans and share state ──────────────────────────────────────────────────

/**
 * Build a tracked plan. Revisions default to a history whose last entry is
 * the current content; earlier revisions carry a short earlier draft.
 *
 * @param {{
 *   id: string,
 *   projectId: string,
 *   worktreeId: string,
 *   title: string,
 *   content: string,
 *   source?: string,
 *   reviewStatus?: 'pending' | 'approved' | 'dismissed',
 *   latestRevisionNumber?: number,
 *   revisions?: object[],
 *   createdAt?: string,
 *   updatedAt?: string,
 *   hidden?: boolean,
 *   diagrams?: PlanDiagramArtifactsFixture,
 *   commentThreads?: PlanCommentThreadFixture[],
 *   share?: TrackedPlanShareFixture,
 *   linkedExecutionIds?: string[],
 * }} options
 * @returns {TrackedPlanFixture}
 */
export function buildTrackedPlan({
  id,
  projectId,
  worktreeId,
  title,
  content,
  source = 'claude',
  reviewStatus = 'pending',
  latestRevisionNumber = 1,
  revisions,
  createdAt = SHARED_PLAN_FIXTURE_TIME,
  updatedAt = createdAt,
  hidden,
  diagrams,
  commentThreads,
  share,
  linkedExecutionIds = [],
}) {
  const history =
    revisions ??
    Array.from({ length: latestRevisionNumber }, (_, index) => {
      const revisionNumber = index + 1;
      return {
        revisionNumber,
        content:
          revisionNumber === latestRevisionNumber
            ? content
            : `# ${title}\n\nEarlier draft (revision ${revisionNumber}).`,
        source,
        reviewStatus,
        createdAt,
      };
    });
  const plan = {
    id,
    projectId,
    worktreeId,
    source,
    title,
    content,
    reviewStatus,
    createdAt,
    updatedAt,
    latestRevisionNumber,
    revisions: history,
    linkedExecutionIds,
    ...(hidden === undefined ? {} : { hidden }),
    ...(diagrams === undefined ? {} : { diagrams }),
    ...(commentThreads === undefined ? {} : { commentThreads }),
    ...(share === undefined ? {} : { share }),
  };
  return assertSeedableTrackedPlan(plan);
}

/**
 * A visible team share already synced to the mock cloud. The seeded snapshot
 * hash matches the server seed so the desktop's startup `PUT` is accepted.
 *
 * @param {{
 *   remoteId: string,
 *   teamId?: string,
 *   syncStatus?: 'pending' | 'syncing' | 'synced' | 'error',
 *   snapshotHash?: string,
 *   localRevisionNumber?: number,
 *   remoteRevisionNumber?: number,
 *   syncedAt?: string,
 * }} options
 * @returns {TrackedPlanShareFixture}
 */
export function teamShareState({
  remoteId,
  teamId = SHARE_MEMBERSHIP_TEAM.id,
  syncStatus = 'synced',
  snapshotHash = SEEDED_SHARED_PLAN_SNAPSHOT_HASH,
  localRevisionNumber = 1,
  remoteRevisionNumber = 1,
  syncedAt = SHARED_PLAN_FIXTURE_TIME,
}) {
  if (typeof remoteId !== 'string' || remoteId.length === 0) {
    throw new Error('teamShareState requires a remoteId');
  }
  return {
    serverId: SHARED_PLAN_SERVER_ID,
    remoteId,
    shareScope: 'team',
    teamId,
    syncStatus,
    lastSyncedAt: syncedAt,
    lastSyncedLocalRevisionNumber: localRevisionNumber,
    lastSyncedRemoteRevisionNumber: remoteRevisionNumber,
    lastSyncedSnapshotHash: snapshotHash,
  };
}

// ── Comment threads ───────────────────────────────────────────────────────

/**
 * Anchor on a raw markdown passage. `quote` must be an exact substring.
 *
 * @param {{
 *   quote: string,
 *   renderedText?: string,
 *   lineStart?: number,
 *   lineEnd?: number,
 *   headingPath?: string[],
 * }} options
 * @returns {PlanCommentAnchorFixture}
 */
export function documentAnchor({
  quote,
  renderedText,
  lineStart,
  lineEnd,
  headingPath,
}) {
  return {
    quote,
    ...(renderedText === undefined ? {} : { renderedText }),
    ...(lineStart === undefined ? {} : { lineStart }),
    ...(lineEnd === undefined ? {} : { lineEnd }),
    ...(headingPath === undefined ? {} : { headingPath }),
  };
}

/**
 * A general note that is not anchored to any passage.
 *
 * @returns {PlanCommentAnchorFixture}
 */
export function generalAnchor() {
  return { quote: '', unanchored: true };
}

/**
 * Anchor on a diagram node, shaped like `usePlanComments.addNodeComment`:
 * without a plan quote the node stays pinned (`unanchored`).
 *
 * @param {{
 *   diagramKind: 'sequence' | 'logicDiff' | 'dataModelDiff',
 *   planNodeId: string,
 *   title: string,
 *   quote?: string,
 *   headingPath?: string[],
 * }} options
 * @returns {PlanCommentAnchorFixture}
 */
export function diagramNodeAnchor({
  diagramKind,
  planNodeId,
  title,
  quote = '',
  headingPath,
}) {
  return {
    source: 'diagram',
    diagramKind,
    planNodeId,
    renderedText: title,
    quote,
    unanchored: quote.length === 0,
    ...(headingPath === undefined ? {} : { headingPath }),
  };
}

/**
 * @param {{
 *   id: string,
 *   status?: 'open' | 'resolved',
 *   createdAt?: string,
 *   anchor: PlanCommentAnchorFixture,
 *   anchorState?: 'matched' | 'outdated',
 *   comments: PlanCommentFixture[],
 * }} options
 * @returns {PlanCommentThreadFixture}
 */
export function buildPlanCommentThread({
  id,
  status = 'open',
  createdAt = SHARED_PLAN_FIXTURE_TIME,
  anchor,
  anchorState = 'matched',
  comments,
}) {
  return { id, status, createdAt, anchor, anchorState, comments };
}

/**
 * A teammate's web comment. `author` is a `SHARED_PLAN_TEAMMATES` entry.
 *
 * @param {{
 *   id: string,
 *   author: SharedPlanTeammate,
 *   body: string,
 *   createdAt?: string,
 *   submittedToChat?: boolean,
 * }} options
 * @returns {PlanCommentFixture}
 */
export function remoteComment({
  id,
  author,
  body,
  createdAt = SHARED_PLAN_FIXTURE_TIME,
  submittedToChat,
}) {
  return {
    id,
    author: 'remote',
    remoteAuthor: { userId: author.userId, displayName: author.displayName },
    body,
    createdAt,
    ...(submittedToChat === undefined ? {} : { submittedToChat }),
  };
}

/**
 * The owner's comment; `staged: true` is an unsubmitted draft.
 *
 * @param {{ id: string, body: string, createdAt?: string, staged?: boolean }} options
 * @returns {PlanCommentFixture}
 */
export function userComment({
  id,
  body,
  createdAt = SHARED_PLAN_FIXTURE_TIME,
  staged,
}) {
  return {
    id,
    author: 'user',
    body,
    createdAt,
    ...(staged === undefined ? {} : { staged }),
  };
}

/**
 * @param {{ id: string, body: string, createdAt?: string }} options
 * @returns {PlanCommentFixture}
 */
export function agentComment({
  id,
  body,
  createdAt = SHARED_PLAN_FIXTURE_TIME,
}) {
  return { id, author: 'agent', body, createdAt };
}

/**
 * Project local threads onto the wire exactly like the desktop's outbound
 * sync: empty threads are dropped and the local-only `staged` /
 * `submittedToChat` flags never leave the machine.
 */
export function toWireCommentThreads(threads) {
  return (threads ?? [])
    .filter((thread) => thread.comments.length > 0)
    .map((thread) => ({
      id: thread.id,
      status: thread.status,
      createdAt: thread.createdAt,
      anchor: structuredClone(thread.anchor),
      anchorState: thread.anchorState,
      comments: thread.comments.map((comment) => ({
        id: comment.id,
        author: comment.author,
        ...(comment.author === 'remote' && comment.remoteAuthor
          ? { remoteAuthor: { ...comment.remoteAuthor } }
          : {}),
        body: comment.body,
        createdAt: comment.createdAt,
      })),
    }));
}

/**
 * The mock server's copy of a shared plan (a partial `SharedPlanDetail` that
 * `routes/shared-plans.mjs` completes). Comment threads default to the wire
 * projection of the local threads, i.e. a fully synced plan.
 *
 * @param {{
 *   remoteId: string,
 *   plan: TrackedPlanFixture,
 *   commentThreads?: object[],
 *   snapshotHash?: string,
 *   remoteRevisionNumber?: number,
 * }} options
 */
export function sharedPlanServerSeed({
  remoteId,
  plan,
  commentThreads,
  snapshotHash = SEEDED_SHARED_PLAN_SNAPSHOT_HASH,
  remoteRevisionNumber = 1,
}) {
  return {
    id: remoteId,
    title: plan.title,
    content: plan.content,
    localRevisionNumber: plan.latestRevisionNumber,
    remoteRevisionNumber,
    snapshotHash,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    ...(plan.diagrams === undefined
      ? {}
      : { diagrams: structuredClone(plan.diagrams) }),
    commentThreads: commentThreads ?? toWireCommentThreads(plan.commentThreads),
  };
}

// ── Diagrams ──────────────────────────────────────────────────────────────

/**
 * Wrap diagram payloads as ready artifacts derived from `revision`.
 *
 * @param {{
 *   revision?: number,
 *   sequence?: object,
 *   logicDiff?: object,
 *   dataModelDiff?: object,
 *   generatedAt?: string,
 * }} options
 * @returns {PlanDiagramArtifactsFixture}
 */
export function readyDiagramArtifacts({
  revision = 1,
  sequence,
  logicDiff,
  dataModelDiff,
  generatedAt = SHARED_PLAN_FIXTURE_TIME,
}) {
  const artifact = (data) => ({
    data,
    derivedFromRevision: revision,
    status: 'ready',
    generatedAt,
  });
  return {
    ...(sequence === undefined ? {} : { sequence: artifact(sequence) }),
    ...(logicDiff === undefined ? {} : { logicDiff: artifact(logicDiff) }),
    ...(dataModelDiff === undefined
      ? {}
      : { dataModelDiff: artifact(dataModelDiff) }),
  };
}

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   tasks: {
 *     id: string,
 *     title: string,
 *     quote?: string,
 *     description?: string,
 *     files?: string[],
 *   }[],
 * }} PlanSectionFixture
 */

/**
 * Sequence graph for `sections`: one phase node per section, its tasks nested
 * by `parentId`, phases chained by `sequence` edges and tasks by `depends-on`.
 *
 * @param {PlanSectionFixture[]} sections
 * @param {{ planTitle?: string }} [options]
 */
export function sequenceGraphFor(sections, { planTitle } = {}) {
  const nodes = [];
  const edges = [];
  sections.forEach((section, sectionIndex) => {
    const headingPath = planTitle
      ? [planTitle, section.title]
      : [section.title];
    nodes.push({
      id: section.id,
      kind: 'phase',
      title: section.title,
      description: `Phase ${sectionIndex + 1}`,
      planAnchor: { headingPath },
    });
    if (sectionIndex > 0) {
      edges.push({
        from: sections[sectionIndex - 1].id,
        to: section.id,
        kind: 'sequence',
      });
    }
    section.tasks.forEach((task, taskIndex) => {
      nodes.push({
        id: task.id,
        kind: 'task',
        title: task.title,
        description: task.description ?? task.title,
        parentId: section.id,
        planAnchor: {
          headingPath,
          ...(task.quote ? { quote: task.quote } : {}),
        },
        ...(task.files ? { files: task.files } : {}),
      });
      if (taskIndex > 0) {
        edges.push({
          from: section.tasks[taskIndex - 1].id,
          to: task.id,
          kind: 'depends-on',
        });
      }
    });
  });
  return { schemaVersion: 1, nodes, edges };
}

/**
 * Current/planned/diff logic graph: one existing handler per section that
 * stays, plus one added planned step per section wired after it.
 *
 * @param {PlanSectionFixture[]} sections
 */
export function logicDiffFor(sections) {
  const currentNodes = sections.map((section) => ({
    id: `logic-${section.id}`,
    label: `${section.title} today`,
    planNodeIds: [section.id],
  }));
  const plannedNodes = [
    ...currentNodes,
    ...sections.map((section) => ({
      id: `logic-${section.id}-planned`,
      label: `${section.title} planned step`,
      detail: `Added by ${section.title}.`,
      planNodeIds: [section.id],
    })),
  ];
  const chain = (ids) =>
    ids.slice(1).map((id, index) => ({ from: ids[index], to: id }));
  return {
    schemaVersion: 1,
    current: {
      nodes: currentNodes,
      edges: chain(currentNodes.map((node) => node.id)),
    },
    planned: {
      nodes: plannedNodes,
      edges: [
        ...chain(currentNodes.map((node) => node.id)),
        ...sections.map((section) => ({
          from: `logic-${section.id}`,
          to: `logic-${section.id}-planned`,
          label: 'then',
        })),
      ],
    },
    changes: sections.map((section) => ({
      nodeId: `logic-${section.id}-planned`,
      type: 'added',
      note: `New step for ${section.title}.`,
    })),
  };
}

/**
 * A small current/planned ERD: plans gain comment threads and comments.
 *
 * @param {string[]} [planNodeIds]
 */
export function dataModelDiffFor(planNodeIds = []) {
  const plan = {
    id: 'plan',
    name: 'Plan',
    kind: 'table',
    fields: [
      { id: 'id', name: 'id', type: 'uuid', kind: 'primary' },
      { id: 'title', name: 'title', type: 'text', kind: 'regular' },
    ],
    planNodeIds,
  };
  const plannedPlan = {
    ...plan,
    fields: [
      ...plan.fields,
      { id: 'revision', name: 'revision', type: 'integer', kind: 'regular' },
    ],
  };
  const thread = {
    id: 'plan_comment_thread',
    name: 'PlanCommentThread',
    kind: 'table',
    fields: [
      { id: 'id', name: 'id', type: 'uuid', kind: 'primary' },
      { id: 'plan_id', name: 'plan_id', type: 'uuid', kind: 'foreign' },
      { id: 'status', name: 'status', type: 'text', kind: 'regular' },
    ],
    planNodeIds,
  };
  const comment = {
    id: 'plan_comment',
    name: 'PlanComment',
    kind: 'table',
    fields: [
      { id: 'id', name: 'id', type: 'uuid', kind: 'primary' },
      { id: 'thread_id', name: 'thread_id', type: 'uuid', kind: 'foreign' },
      { id: 'body', name: 'body', type: 'text', kind: 'regular' },
    ],
    planNodeIds,
  };
  return {
    schemaVersion: 1,
    current: { entities: [plan], relationships: [] },
    planned: {
      entities: [plannedPlan, thread, comment],
      relationships: [
        {
          id: 'plan-threads',
          from: 'plan',
          to: 'plan_comment_thread',
          label: 'has',
          cardinality: 'one-to-many',
        },
        {
          id: 'thread-comments',
          from: 'plan_comment_thread',
          to: 'plan_comment',
          label: 'has',
          cardinality: 'one-to-many',
        },
      ],
    },
    changes: [
      {
        id: 'change-plan-revision',
        target: 'field',
        type: 'added',
        entityId: 'plan',
        fieldId: 'revision',
      },
      {
        id: 'change-thread',
        target: 'entity',
        type: 'added',
        entityId: 'plan_comment_thread',
      },
      {
        id: 'change-comment',
        target: 'entity',
        type: 'added',
        entityId: 'plan_comment',
      },
      {
        id: 'change-plan-threads',
        target: 'relationship',
        type: 'added',
        relationshipId: 'plan-threads',
      },
      {
        id: 'change-thread-comments',
        target: 'relationship',
        type: 'added',
        relationshipId: 'thread-comments',
      },
    ],
  };
}

// ── Large deterministic plan ──────────────────────────────────────────────

/** Heading text of the last section in `buildLargePlanFixture` output. */
export const LARGE_PLAN_SENTINEL = 'Plan open sentinel: final review';

const FILLER_WORDS = [
  'coordinate',
  'renderer',
  'workspace',
  'deterministic',
  'fixture',
  'panel',
  'revision',
  'comment',
  'diagram',
  'anchor',
  'measure',
  'layout',
  'teammate',
  'shared',
  'history',
  'placement',
];

function fillerParagraph(seed, bytes) {
  const words = [];
  let length = 0;
  for (let index = 0; length < bytes; index += 1) {
    const word = FILLER_WORDS[(seed * 7 + index * 3) % FILLER_WORDS.length];
    words.push(word);
    length += word.length + 1;
  }
  const text = words.join(' ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * A large, deterministic plan with ready diagrams and comment threads, used by
 * the `plan-open` performance scenario. The last heading is
 * `LARGE_PLAN_SENTINEL`, so "the sentinel is rendered" means the whole
 * document body rendered.
 *
 * @param {{
 *   id?: string,
 *   projectId: string,
 *   worktreeId: string,
 *   title?: string,
 *   sections: number,
 *   tasksPerSection: number,
 *   paragraphBytes: number,
 *   diagramTasksPerSection: number,
 *   commentThreads: number,
 *   share?: TrackedPlanShareFixture,
 *   hidden?: boolean,
 * }} options
 */
export function buildLargePlanFixture({
  id = 'plan-open-large',
  projectId,
  worktreeId,
  title = 'Plan workspace performance fixture',
  sections: sectionCount,
  tasksPerSection,
  paragraphBytes,
  diagramTasksPerSection,
  commentThreads: commentThreadCount,
  share,
  hidden,
}) {
  for (const [name, value] of Object.entries({
    sections: sectionCount,
    tasksPerSection,
    paragraphBytes,
    diagramTasksPerSection,
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`buildLargePlanFixture requires a positive ${name}`);
    }
  }
  if (!Number.isInteger(commentThreadCount) || commentThreadCount < 0) {
    throw new Error('buildLargePlanFixture requires commentThreads >= 0');
  }

  const lines = [
    `# ${title}`,
    '',
    'Deterministic plan used to measure opening, reading, and diagram switching.',
    '',
  ];
  const sections = [];
  const taskQuotes = [];
  for (let s = 1; s <= sectionCount; s += 1) {
    const sectionTitle = `Phase ${s}: Workstream ${s}`;
    lines.push(
      `## ${sectionTitle}`,
      '',
      fillerParagraph(s, paragraphBytes),
      '',
    );
    const tasks = [];
    for (let t = 1; t <= tasksPerSection; t += 1) {
      const plain = `Task ${s}.${t}: Implement workstream ${s} step ${t}`;
      lines.push(
        `- ${plain} in \`src/workstream-${s}/step-${t}.ts\` and **verify** it.`,
      );
      taskQuotes.push({ quote: plain, heading: sectionTitle });
      if (t <= diagramTasksPerSection) {
        tasks.push({ id: `task-${s}-${t}`, title: plain, quote: plain });
      }
    }
    lines.push('');
    if (s % 5 === 0) {
      lines.push(
        '| Check | Owner | Status |',
        '| --- | --- | --- |',
        `| Workstream ${s} review | Platform | Pending |`,
        `| Workstream ${s} rollout | Platform | Planned |`,
        '',
      );
    }
    if (s % 4 === 0) {
      lines.push(
        '```ts',
        `export function workstream${s}(): number {`,
        `  return ${s};`,
        '}',
        '```',
        '',
      );
    }
    sections.push({ id: `phase-${s}`, title: sectionTitle, tasks });
  }
  lines.push(
    `## ${LARGE_PLAN_SENTINEL}`,
    '',
    'Confirm every workstream is complete before rollout.',
  );
  const content = lines.join('\n');

  const authors = [
    SHARED_PLAN_TEAMMATES.ada,
    SHARED_PLAN_TEAMMATES.grace,
    SHARED_PLAN_TEAMMATES.unresolved,
  ];
  const threads = [];
  for (let index = 0; index < commentThreadCount; index += 1) {
    const target = taskQuotes[(index * 5) % taskQuotes.length];
    const minute = String(index % 60).padStart(2, '0');
    const createdAt = `2026-06-11T13:${minute}:00.000Z`;
    const comments = [
      remoteComment({
        id: `${id}-comment-${index}-1`,
        author: authors[index % authors.length],
        body: `Question ${index + 1} about ${target.quote}.`,
        createdAt,
        ...(index % 4 === 3 ? { submittedToChat: true } : {}),
      }),
    ];
    if (index % 2 === 1) {
      comments.push(
        userComment({
          id: `${id}-comment-${index}-2`,
          body: `Answer ${index + 1}: keep the current approach.`,
          createdAt: `2026-06-11T14:${minute}:00.000Z`,
        }),
      );
    }
    threads.push(
      buildPlanCommentThread({
        id: `${id}-thread-${index}`,
        status: index % 3 === 2 ? 'resolved' : 'open',
        createdAt,
        anchor: documentAnchor({
          quote: target.quote,
          renderedText: target.quote,
          headingPath: [title, target.heading],
        }),
        comments,
      }),
    );
  }

  const sequence = sequenceGraphFor(sections, { planTitle: title });
  const logicDiff = logicDiffFor(sections);
  const plan = buildTrackedPlan({
    id,
    projectId,
    worktreeId,
    title,
    content,
    diagrams: readyDiagramArtifacts({
      revision: 1,
      sequence,
      logicDiff,
      dataModelDiff: dataModelDiffFor([sections[0].id]),
    }),
    commentThreads: threads,
    ...(share === undefined ? {} : { share }),
    ...(hidden === undefined ? {} : { hidden }),
  });
  const logicNodeIds = new Set([
    ...logicDiff.current.nodes.map((node) => node.id),
    ...logicDiff.planned.nodes.map((node) => node.id),
  ]);
  return {
    plan,
    sentinel: LARGE_PLAN_SENTINEL,
    logicNodeId: `logic-${sections.at(-1).id}-planned`,
    sequenceNodeId: sections.at(-1).id,
    contentBytes: byteLength(content),
    sequenceNodeCount: sequence.nodes.length,
    logicNodeCount: logicNodeIds.size,
    commentThreadCount: threads.length,
  };
}
