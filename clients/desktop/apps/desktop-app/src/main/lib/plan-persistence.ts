import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  CreateTrackedPlanRequest,
  DataModelDiffDiagram,
  LogicDiffDiagram,
  ParsedPlanGraph,
  PlanComment,
  PlanCommentThread,
  PlanDiagramArtifact,
  PlanDiagramArtifacts,
  PlanUsageEvent,
  SaveTrackedPlanCommentsRequest,
  WirePlanComment,
  WirePlanCommentThread,
  TrackedPlanData,
  TrackedPlansFile,
  TrackedPlanReviewStatus,
  TrackedPlanRevisionData,
  TrackedPlanShareState,
  TrackedPlanShareSyncStatus,
  TrackedPlanSource,
  UpdateTrackedPlanRequest,
  UsageMetricProvider,
} from '@canopy/desktop-shared/types';
import {
  isDataModelDiffDiagram,
  isLogicDiffDiagram,
  isParsedPlanGraph,
  isPlanDiagramArtifacts,
  isPlanCommentThreadArray,
} from '@canopy/desktop-shared/types';
import { derivePlanTitle } from '@canopy/protocol/plans';
import { resolveTrackedPlansFilePath } from './resolve-worktree';
import { getPlanExplorePlanFilePath } from './paths';
import { isRecord } from './type-guards';
import { getObservabilityService } from '../observability';

/**
 * Per-file write queue that serializes read-modify-write operations on the same
 * tracked-plans file to prevent concurrent writes from silently dropping data.
 */
const writeLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  writeLocks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(key) === next) {
      writeLocks.delete(key);
    }
  }
}

/**
 * Dependency-inverted hook fired when a tracked plan's content is created or
 * changed. The plan-diagram scheduler registers here so persistence does not
 * import scheduler/Electron code directly. It is intentionally NOT invoked by
 * {@link setPlanDiagramArtifact}, which only mutates derived diagram artifacts
 * and must never re-trigger generation (that would loop forever).
 */
type PlanContentChangeListener = (plan: TrackedPlanData) => void;
type PlanShareChangeListener = (plan: TrackedPlanData) => void;
type PlanDiagramArtifactChangeListener = (plan: TrackedPlanData) => void;
type TrackedPlanShareStateUpdater = (
  current: TrackedPlanShareState | undefined,
) => TrackedPlanShareState | undefined;

const planContentChangeListeners = new Set<PlanContentChangeListener>();
const planShareChangeListeners = new Set<PlanShareChangeListener>();
const planDiagramArtifactChangeListeners =
  new Set<PlanDiagramArtifactChangeListener>();

export function setPlanContentChangeListener(
  fn: PlanContentChangeListener | null,
): void {
  planContentChangeListeners.clear();
  if (fn) {
    planContentChangeListeners.add(fn);
  }
}

export function addPlanContentChangeListener(
  fn: PlanContentChangeListener,
): void {
  planContentChangeListeners.add(fn);
}

export function removePlanContentChangeListener(
  fn: PlanContentChangeListener,
): void {
  planContentChangeListeners.delete(fn);
}

/**
 * Dependency-inverted hook fired after every tracked-plans file write
 * (including the empty-file removal on last-plan delete). The chat-search
 * index registers here so this persistence module stays Electron-free; the
 * payload is the exact file content just written, so subscribers never
 * re-read from disk.
 */
type TrackedPlansWriteListener = (
  projectId: string,
  worktreeId: string,
  file: TrackedPlansFile,
) => void;

const trackedPlansWriteListeners = new Set<TrackedPlansWriteListener>();

export function addTrackedPlansWriteListener(
  fn: TrackedPlansWriteListener,
): void {
  trackedPlansWriteListeners.add(fn);
}

export function removeTrackedPlansWriteListener(
  fn: TrackedPlansWriteListener,
): void {
  trackedPlansWriteListeners.delete(fn);
}

export function addPlanShareChangeListener(fn: PlanShareChangeListener): void {
  planShareChangeListeners.add(fn);
}

export function removePlanShareChangeListener(
  fn: PlanShareChangeListener,
): void {
  planShareChangeListeners.delete(fn);
}

export function addPlanDiagramArtifactChangeListener(
  fn: PlanDiagramArtifactChangeListener,
): void {
  planDiagramArtifactChangeListeners.add(fn);
}

export function removePlanDiagramArtifactChangeListener(
  fn: PlanDiagramArtifactChangeListener,
): void {
  planDiagramArtifactChangeListeners.delete(fn);
}

function emitPlanContentChange(plan: TrackedPlanData): void {
  planContentChangeListeners.forEach((listener) => {
    listener(plan);
  });
}

function emitPlanShareChange(plan: TrackedPlanData): void {
  planShareChangeListeners.forEach((listener) => {
    listener(plan);
  });
}

function emitPlanDiagramArtifactChange(plan: TrackedPlanData): void {
  planDiagramArtifactChangeListeners.forEach((listener) => {
    listener(plan);
  });
}

function isTrackedPlanReviewStatus(
  value: unknown,
): value is TrackedPlanReviewStatus {
  return value === 'pending' || value === 'approved' || value === 'dismissed';
}

function isTrackedPlanSource(value: unknown): value is TrackedPlanSource {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'opencode' ||
    value === 'cursor' ||
    value === 'ollama' ||
    value === 'pipeline' ||
    value === 'imported' ||
    value === 'detected'
  );
}

function planSourceToUsageMetricProvider(
  source: TrackedPlanSource,
): UsageMetricProvider | undefined {
  // Only agent/pipeline sources map to a usage-metric provider; file-origin
  // sources (imported/detected) have no provider to attribute usage to.
  switch (source) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'ollama':
    case 'pipeline':
      return source;
    case 'imported':
    case 'detected':
      return undefined;
  }
}

function isTrackedPlanShareSyncStatus(
  value: unknown,
): value is TrackedPlanShareSyncStatus {
  return (
    value === 'pending' ||
    value === 'syncing' ||
    value === 'synced' ||
    value === 'error'
  );
}

function isTrackedPlanShareState(
  value: unknown,
): value is TrackedPlanShareState {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.serverId === 'string' &&
    typeof value.remoteId === 'string' &&
    (value.shareScope === 'private' ||
      value.shareScope === 'team' ||
      value.shareScope === 'organization') &&
    (value.teamId === undefined || typeof value.teamId === 'string') &&
    (value.organizationId === undefined ||
      typeof value.organizationId === 'string') &&
    isTrackedPlanShareSyncStatus(value.syncStatus) &&
    (value.lastSyncedAt === undefined ||
      typeof value.lastSyncedAt === 'string') &&
    (value.lastSyncedLocalRevisionNumber === undefined ||
      typeof value.lastSyncedLocalRevisionNumber === 'number') &&
    (value.lastSyncedRemoteRevisionNumber === undefined ||
      typeof value.lastSyncedRemoteRevisionNumber === 'number') &&
    (value.lastSyncedSnapshotHash === undefined ||
      typeof value.lastSyncedSnapshotHash === 'string') &&
    (value.lastSyncError === undefined ||
      typeof value.lastSyncError === 'string')
  );
}

function isTrackedPlanRevisionData(
  value: unknown,
): value is TrackedPlanRevisionData {
  if (!isRecord(value)) {
    return false;
  }

  return (
    (value.proposalRequestId === undefined ||
      (typeof value.proposalRequestId === 'string' &&
        value.proposalRequestId.length > 0 &&
        value.proposalRequestId.length <= 256)) &&
    typeof value.revisionNumber === 'number' &&
    typeof value.content === 'string' &&
    isTrackedPlanSource(value.source) &&
    isTrackedPlanReviewStatus(value.reviewStatus) &&
    typeof value.createdAt === 'string' &&
    (value.approvedAt === undefined || typeof value.approvedAt === 'string') &&
    (value.dismissedAt === undefined || typeof value.dismissedAt === 'string')
  );
}

function isTrackedPlanData(value: unknown): value is TrackedPlanData {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    isTrackedPlanSource(value.source) &&
    (value.proposalChatId === undefined ||
      (typeof value.proposalChatId === 'string' &&
        value.proposalChatId.length > 0 &&
        value.proposalChatId.length <= 256)) &&
    typeof value.title === 'string' &&
    typeof value.content === 'string' &&
    isTrackedPlanReviewStatus(value.reviewStatus) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.latestRevisionNumber === 'number' &&
    (value.approvedAt === undefined || typeof value.approvedAt === 'string') &&
    (value.dismissedAt === undefined ||
      typeof value.dismissedAt === 'string') &&
    Array.isArray(value.revisions) &&
    value.revisions.every((revision) => isTrackedPlanRevisionData(revision)) &&
    Array.isArray(value.linkedExecutionIds) &&
    value.linkedExecutionIds.every((entry) => typeof entry === 'string') &&
    (value.hidden === undefined || typeof value.hidden === 'boolean') &&
    (value.diagrams === undefined || isPlanDiagramArtifacts(value.diagrams)) &&
    (value.commentThreads === undefined ||
      isPlanCommentThreadArray(value.commentThreads)) &&
    (value.lastEditSource === undefined ||
      value.lastEditSource === 'agent' ||
      value.lastEditSource === 'pipeline') &&
    (value.share === undefined || isTrackedPlanShareState(value.share)) &&
    (value.sourceFilePath === undefined ||
      typeof value.sourceFilePath === 'string') &&
    (value.sourceRepoId === undefined || typeof value.sourceRepoId === 'string')
  );
}

export function isTrackedPlansFile(value: unknown): value is TrackedPlansFile {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === 1 &&
    Array.isArray(value.plans) &&
    value.plans.every((plan) => isTrackedPlanData(plan))
  );
}

async function readTrackedPlansFile(
  projectId: string,
  worktreeId: string,
): Promise<TrackedPlansFile> {
  try {
    const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isTrackedPlansFile(parsed)) {
      return parsed;
    }
  } catch {
    // Use empty state when missing or invalid.
  }

  return {
    version: 1,
    plans: [],
  };
}

/**
 * Strict reader for destructive whole-store replacement paths. Unlike the
 * general reader, unreadable, malformed, and invalid files are propagated so
 * a transient failure cannot be mistaken for authoritative empty plan state.
 * Callers that define a missing file as an empty store must handle ENOENT at
 * their boundary; this strict variant must not be used for ordinary reads.
 */
export async function readTrackedPlansFileForIndex(
  projectId: string,
  worktreeId: string,
): Promise<TrackedPlansFile> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  const raw = await readFile(filePath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!isTrackedPlansFile(parsed)) {
    throw new Error(`Invalid tracked plans file: ${filePath}`);
  }
  return parsed;
}

async function writeTrackedPlansFile(
  projectId: string,
  worktreeId: string,
  file: TrackedPlansFile,
): Promise<void> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  if (file.plans.length === 0) {
    await rm(filePath, { force: true });
    emitTrackedPlansWrite(projectId, worktreeId, file);
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(file, null, 2), 'utf8');
  emitTrackedPlansWrite(projectId, worktreeId, file);
}

function emitTrackedPlansWrite(
  projectId: string,
  worktreeId: string,
  file: TrackedPlansFile,
): void {
  trackedPlansWriteListeners.forEach((listener) => {
    try {
      listener(projectId, worktreeId, file);
    } catch (error) {
      // Plan persistence must never fail because a derived-index subscriber
      // threw; the index rebuilds itself on the next scan.
      // eslint-disable-next-line no-console
      console.error('Tracked-plans write listener failed:', error);
    }
  });
}

function markDiagramsStale(
  diagrams: PlanDiagramArtifacts | undefined,
): PlanDiagramArtifacts | undefined {
  if (!diagrams) return diagrams;
  const next: PlanDiagramArtifacts = {};
  if (diagrams.sequence) {
    next.sequence = { ...diagrams.sequence, status: 'stale' };
  }
  if (diagrams.logicDiff) {
    next.logicDiff = { ...diagrams.logicDiff, status: 'stale' };
  }
  if (diagrams.dataModelDiff) {
    next.dataModelDiff = { ...diagrams.dataModelDiff, status: 'stale' };
  }
  return next;
}

function reevaluateCommentAnchors(
  threads: PlanCommentThread[] | undefined,
  content: string,
): PlanCommentThread[] | undefined {
  if (!threads || threads.length === 0) {
    return threads;
  }
  return threads.map((thread) => {
    // Unanchored (general) comments have no plan passage to match against, so
    // they can never go outdated.
    if (thread.anchor.unanchored) {
      return thread.anchorState === 'matched'
        ? thread
        : { ...thread, anchorState: 'matched' };
    }
    return content.includes(thread.anchor.quote)
      ? thread.anchorState === 'matched'
        ? thread
        : { ...thread, anchorState: 'matched' }
      : thread.anchorState === 'outdated'
        ? thread
        : { ...thread, anchorState: 'outdated' };
  });
}

function isDurableComment(comment: PlanComment): boolean {
  return comment.author === 'agent' || comment.staged !== true;
}

function mergePlanComments(
  existingComments: PlanComment[],
  incomingComments: PlanComment[],
): PlanComment[] {
  const incomingIds = new Set(incomingComments.map((comment) => comment.id));
  const preservedExisting = existingComments.filter(
    (comment) => !incomingIds.has(comment.id) && isDurableComment(comment),
  );
  return [...incomingComments, ...preservedExisting].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created !== 0 ? created : left.id.localeCompare(right.id);
  });
}

function mergeCommentThread(
  existing: PlanCommentThread,
  incoming: PlanCommentThread,
): PlanCommentThread {
  const incomingCommentIds = new Set(
    incoming.comments.map((comment) => comment.id),
  );
  const missingDurableExisting = existing.comments.some(
    (comment) =>
      isDurableComment(comment) && !incomingCommentIds.has(comment.id),
  );

  return {
    ...incoming,
    // Anchor matching is owned by plan persistence when content changes. A
    // renderer save may carry an older anchorState snapshot, so preserve the
    // latest persisted anchor fields for existing threads.
    anchor: existing.anchor,
    anchorState: existing.anchorState,
    status:
      missingDurableExisting && existing.status === 'resolved'
        ? existing.status
        : incoming.status,
    comments: mergePlanComments(existing.comments, incoming.comments),
  };
}

function mergeCommentThreads(
  existingThreads: PlanCommentThread[],
  incomingThreads: PlanCommentThread[],
): PlanCommentThread[] {
  const existingById = new Map(
    existingThreads.map((thread) => [thread.id, thread]),
  );
  const incomingIds = new Set(incomingThreads.map((thread) => thread.id));

  const merged = incomingThreads.map((incoming) => {
    const existing = existingById.get(incoming.id);
    return existing ? mergeCommentThread(existing, incoming) : incoming;
  });

  for (const existing of existingThreads) {
    if (incomingIds.has(existing.id)) {
      continue;
    }
    if (existing.comments.some((comment) => isDurableComment(comment))) {
      merged.push(existing);
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Remote (server) comment-thread merge (CAN-393).
//
// Distinct from `mergeCommentThreads` (which reconciles renderer saves): a
// server pull must NEVER drop locally-staged drafts (which are not "durable"),
// and the server is authoritative for thread resolution status while the local
// side stays authoritative for anchor matching against plan content.
// ---------------------------------------------------------------------------

function toLocalComment(comment: WirePlanComment): PlanComment {
  const local: PlanComment = {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
  };
  if (comment.author === 'remote' && comment.remoteAuthor) {
    local.remoteAuthor = comment.remoteAuthor;
  }
  return local;
}

function toLocalThread(thread: WirePlanCommentThread): PlanCommentThread {
  return {
    id: thread.id,
    status: thread.status,
    createdAt: thread.createdAt,
    anchor: thread.anchor,
    anchorState: thread.anchorState,
    comments: thread.comments.map(toLocalComment),
  };
}

function mergeRemoteThreadComments(
  existing: PlanComment[],
  incoming: PlanComment[],
): PlanComment[] {
  const existingIds = new Set(existing.map((comment) => comment.id));
  const serverOnly = incoming.filter((comment) => !existingIds.has(comment.id));
  // Keep every existing local comment (including staged drafts) and append the
  // server-only ones (e.g. teammate replies), ordered by creation time.
  return [...existing, ...serverOnly].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    return created !== 0 ? created : left.id.localeCompare(right.id);
  });
}

function mergeRemoteThread(
  existing: PlanCommentThread,
  incoming: PlanCommentThread,
): PlanCommentThread {
  return {
    ...existing,
    // Server is canonical for resolution status; local owns anchor matching, so
    // the local anchor + anchorState are preserved verbatim.
    status: incoming.status,
    comments: mergeRemoteThreadComments(existing.comments, incoming.comments),
  };
}

function mergeRemoteCommentThreads(
  existing: PlanCommentThread[],
  incoming: PlanCommentThread[],
): PlanCommentThread[] {
  const incomingById = new Map(incoming.map((thread) => [thread.id, thread]));
  const existingIds = new Set(existing.map((thread) => thread.id));
  const merged = existing.map((thread) => {
    const incomingThread = incomingById.get(thread.id);
    return incomingThread ? mergeRemoteThread(thread, incomingThread) : thread;
  });
  for (const thread of incoming) {
    if (!existingIds.has(thread.id)) {
      merged.push(thread);
    }
  }
  return merged;
}

/**
 * Merge server-authored comment threads (pulled from a shared plan) into the
 * local store (CAN-393). Preserves locally-staged drafts, attributes remote
 * authors, and re-evaluates anchor state against the current local content.
 * Returns `null` when the plan is unknown; otherwise the plan plus whether the
 * merge changed anything (so callers can skip a redundant update event).
 */
export async function applyRemoteSharedPlanComments(
  projectId: string,
  worktreeId: string,
  planId: string,
  remoteThreads: WirePlanCommentThread[],
): Promise<{ plan: TrackedPlanData; changed: boolean } | null> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const existing = file.plans.find((plan) => plan.id === planId);
    if (!existing) {
      return null;
    }
    const incoming = remoteThreads.map(toLocalThread);
    const mergedThreads = mergeRemoteCommentThreads(
      existing.commentThreads ?? [],
      incoming,
    );
    const reevaluated =
      reevaluateCommentAnchors(mergedThreads, existing.content) ??
      mergedThreads;

    const changed =
      JSON.stringify(existing.commentThreads ?? []) !==
      JSON.stringify(reevaluated);
    if (!changed) {
      return { plan: existing, changed: false };
    }

    const updated: TrackedPlanData = {
      ...existing,
      commentThreads: reevaluated,
    };
    file.plans = file.plans.map((plan) =>
      plan.id === planId ? updated : plan,
    );
    await writeTrackedPlansFile(projectId, worktreeId, file);
    return { plan: updated, changed: true };
  });
}

function linkExecutionIds(
  current: string[],
  linkedExecutionId: string | undefined,
): string[] {
  if (!linkedExecutionId) {
    return current;
  }

  if (current.includes(linkedExecutionId)) {
    return current;
  }

  return [...current, linkedExecutionId];
}

function getPlanLineCount(content: string): number {
  return content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function buildPlanUsageEventId(
  type: PlanUsageEvent['type'],
  plan: TrackedPlanData,
  request: {
    chatId?: string;
  },
): string {
  return `plan-${type.replace('plan_', '')}:${plan.projectId}/${plan.worktreeId}/${request.chatId ?? 'unknown-chat'}:${plan.id}:${String(plan.latestRevisionNumber)}`;
}

function buildPlanUsageEvent(
  type: PlanUsageEvent['type'],
  plan: TrackedPlanData,
  request: {
    chatId?: string;
    initiationSource?: PlanUsageEvent['initiationSource'];
  },
): PlanUsageEvent {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    id: buildPlanUsageEventId(type, plan, request),
    type,
    timestamp,
    workspaceId: plan.projectId,
    worktreeId: plan.worktreeId,
    provider: planSourceToUsageMetricProvider(plan.source),
    initiationSource: request.initiationSource ?? 'unknown',
    chatId: request.chatId,
    planId: plan.id,
    planVersion: plan.latestRevisionNumber,
    planTextBytes: Buffer.byteLength(plan.content, 'utf8'),
    planLineCount: getPlanLineCount(plan.content),
  };
}

function recordPlanUsageEvent(
  type: PlanUsageEvent['type'],
  plan: TrackedPlanData,
  request: {
    chatId?: string;
    initiationSource?: PlanUsageEvent['initiationSource'];
  },
): void {
  getObservabilityService().recordUsageMetricEvent(
    buildPlanUsageEvent(type, plan, request),
  );
}

export async function listTrackedPlans(
  projectId: string,
  worktreeId: string,
): Promise<TrackedPlanData[]> {
  const file = await readTrackedPlansFile(projectId, worktreeId);
  return [...file.plans].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );
}

export async function getTrackedPlan(
  projectId: string,
  worktreeId: string,
  planId: string,
): Promise<TrackedPlanData | null> {
  const file = await readTrackedPlansFile(projectId, worktreeId);
  return file.plans.find((plan) => plan.id === planId) ?? null;
}

function validateProposalRequestId(value: string | undefined): void {
  if (
    value !== undefined &&
    (typeof value !== 'string' || !value.trim() || value.length > 256)
  )
    throw new Error('The proposal request identity is invalid.');
}

function assertProposalReplay(
  plan: TrackedPlanData,
  requestId: string,
  content: string | undefined,
  source: TrackedPlanSource,
): void {
  const revision = plan.revisions.find(
    (entry) => entry.proposalRequestId === requestId,
  );
  if (!revision || revision.content !== content || revision.source !== source)
    throw new Error(
      'This proposal request was already used for different plan content.',
    );
}

export async function createTrackedPlan(
  request: CreateTrackedPlanRequest,
): Promise<TrackedPlanData> {
  validateProposalRequestId(request.proposalRequestId);
  const proposalChatId =
    request.source === 'cursor' && request.proposalRequestId && !request.id
      ? request.chatId
      : undefined;
  if (
    proposalChatId !== undefined &&
    (typeof proposalChatId !== 'string' ||
      proposalChatId.length === 0 ||
      proposalChatId.length > 256)
  ) {
    throw new Error('Invalid proposal chat identity.');
  }
  const filePath = resolveTrackedPlansFilePath(
    request.projectId,
    request.worktreeId,
  );
  const result = await withFileLock<
    TrackedPlanData | { pendingPlanId: string }
  >(filePath, async () => {
    const file = await readTrackedPlansFile(
      request.projectId,
      request.worktreeId,
    );

    if (request.proposalRequestId) {
      const replay = file.plans.find((plan) =>
        plan.revisions.some(
          (revision) =>
            revision.proposalRequestId === request.proposalRequestId,
        ),
      );
      if (replay) {
        assertProposalReplay(
          replay,
          request.proposalRequestId,
          request.content,
          request.source,
        );
        return replay;
      }
    }

    // Idempotent when an explicit id is supplied: if a plan with that id
    // already exists, return it unchanged rather than creating a duplicate.
    if (request.id) {
      const existing = file.plans.find((plan) => plan.id === request.id);
      if (existing) {
        return existing;
      }
    }

    if (proposalChatId && (request.reviewStatus ?? 'pending') === 'pending') {
      const pending = file.plans.filter(
        (plan) =>
          plan.source === 'cursor' &&
          plan.proposalChatId === proposalChatId &&
          plan.reviewStatus === 'pending',
      );
      if (pending.length > 1)
        throw new Error('Multiple pending plans match this proposal chat.');
      const [existing] = pending;
      if (existing) return { pendingPlanId: existing.id };
    }

    const now = new Date().toISOString();
    const reviewStatus = request.reviewStatus ?? 'pending';
    const plan: TrackedPlanData = {
      id: request.id ?? randomUUID(),
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      source: request.source,
      ...(proposalChatId ? { proposalChatId } : {}),
      title: request.title?.trim() || derivePlanTitle(request.content),
      content: request.content,
      reviewStatus,
      createdAt: now,
      updatedAt: now,
      latestRevisionNumber: 1,
      ...(reviewStatus === 'approved' ? { approvedAt: now } : {}),
      ...(reviewStatus === 'dismissed' ? { dismissedAt: now } : {}),
      revisions: [
        {
          ...(request.proposalRequestId
            ? { proposalRequestId: request.proposalRequestId }
            : {}),
          revisionNumber: 1,
          content: request.content,
          source: request.source,
          reviewStatus,
          createdAt: now,
          ...(reviewStatus === 'approved' ? { approvedAt: now } : {}),
          ...(reviewStatus === 'dismissed' ? { dismissedAt: now } : {}),
        },
      ],
      linkedExecutionIds: request.linkedExecutionId
        ? [request.linkedExecutionId]
        : [],
      ...(request.sourceFilePath
        ? { sourceFilePath: request.sourceFilePath }
        : {}),
      ...(request.sourceRepoId ? { sourceRepoId: request.sourceRepoId } : {}),
    };

    file.plans = [plan, ...file.plans];
    await writeTrackedPlansFile(request.projectId, request.worktreeId, file);
    recordPlanUsageEvent('plan_created', plan, request);
    emitPlanContentChange(plan);
    emitPlanShareChange(plan);
    return plan;
  });
  if ('pendingPlanId' in result) {
    // Release the creation lock before the existing revision writer takes it.
    // The persisted association survives a failed update or renderer reload.
    const updated = await updateTrackedPlan({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      planId: result.pendingPlanId,
      proposalRequestId: request.proposalRequestId,
      source: request.source,
      content: request.content,
      title: request.title,
      reviewStatus: 'pending',
      approvedAt: null,
      dismissedAt: null,
      chatId: request.chatId,
      initiationSource: request.initiationSource,
    });
    if (!updated)
      throw new Error('The pending proposal plan is no longer available.');
    return updated;
  }
  return result;
}

/** Keep the reviewed revision stable until its implementation message commits. */
export async function withTrackedPlanRevision<T>(
  request: {
    projectId: string;
    worktreeId: string;
    planId: string;
    revisionNumber: number;
    source?: TrackedPlanData['source'];
    reviewStatus?: TrackedPlanData['reviewStatus'];
  },
  commit: (plan: TrackedPlanData) => Promise<T>,
): Promise<{ accepted: false } | { accepted: true; result: T }> {
  const filePath = resolveTrackedPlansFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(
      request.projectId,
      request.worktreeId,
    );
    const plan = file.plans.find((entry) => entry.id === request.planId);
    if (
      !plan ||
      plan.latestRevisionNumber !== request.revisionNumber ||
      (request.source !== undefined && plan.source !== request.source) ||
      (request.reviewStatus !== undefined &&
        plan.reviewStatus !== request.reviewStatus)
    ) {
      return { accepted: false as const };
    }
    if (plan.source === 'opencode' && request.reviewStatus === 'approved') {
      // The implementation instruction reads this working copy. Its edits can
      // still be waiting for the sync debounce or another worktree turn, so
      // checking only the stored revision does not validate the reviewed bytes.
      try {
        const content = await readFile(
          getPlanExplorePlanFilePath(
            request.projectId,
            request.worktreeId,
            request.planId,
          ),
          'utf8',
        );
        if (content !== plan.content) return { accepted: false as const };
      } catch {
        // Missing or unreadable content cannot authorize implementation.
        return { accepted: false as const };
      }
    }
    return { accepted: true as const, result: await commit(plan) };
  });
}

export async function updateTrackedPlan(
  request: UpdateTrackedPlanRequest,
  guard?: {
    revisionNumber: number;
    source: TrackedPlanData['source'];
  },
): Promise<TrackedPlanData | null> {
  validateProposalRequestId(request.proposalRequestId);
  if (request.proposalRequestId && request.content === undefined)
    throw new Error('A proposal revision requires plan content.');
  const filePath = resolveTrackedPlansFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(
      request.projectId,
      request.worktreeId,
    );
    const existing = file.plans.find((plan) => plan.id === request.planId);
    if (
      !existing ||
      (guard &&
        (existing.latestRevisionNumber !== guard.revisionNumber ||
          existing.source !== guard.source))
    ) {
      return null;
    }

    if (
      request.proposalRequestId &&
      existing.revisions.some(
        (revision) => revision.proposalRequestId === request.proposalRequestId,
      )
    ) {
      assertProposalReplay(
        existing,
        request.proposalRequestId,
        request.content,
        request.source ?? existing.source,
      );
      return existing;
    }

    const nextUpdatedAt = new Date().toISOString();
    const contentChanged = request.content !== undefined;
    const nextTitle =
      request.title?.trim() ||
      (contentChanged
        ? derivePlanTitle(request.content ?? existing.content)
        : existing.title);
    const nextSource = request.source ?? existing.source;
    const nextReviewStatus = request.reviewStatus ?? existing.reviewStatus;
    const nextContent = request.content ?? existing.content;
    const nextRevisionNumber = contentChanged
      ? existing.latestRevisionNumber + 1
      : existing.latestRevisionNumber;
    const preserveExistingApprovedAt =
      request.approvedAt !== null &&
      existing.reviewStatus === 'approved' &&
      nextReviewStatus === 'approved' &&
      existing.approvedAt !== undefined;
    const nextApprovedAt =
      request.approvedAt === null
        ? undefined
        : preserveExistingApprovedAt
          ? existing.approvedAt
          : (request.approvedAt ?? existing.approvedAt);
    const nextDismissedAt =
      request.dismissedAt === null
        ? undefined
        : (request.dismissedAt ?? existing.dismissedAt);

    const revisions = contentChanged
      ? [
          ...existing.revisions,
          {
            ...(request.proposalRequestId
              ? { proposalRequestId: request.proposalRequestId }
              : {}),
            revisionNumber: nextRevisionNumber,
            content: nextContent,
            source: nextSource,
            reviewStatus: nextReviewStatus,
            createdAt: nextUpdatedAt,
            ...(nextApprovedAt ? { approvedAt: nextApprovedAt } : {}),
            ...(nextDismissedAt ? { dismissedAt: nextDismissedAt } : {}),
          },
        ]
      : existing.revisions;

    const nextHidden =
      request.hidden !== undefined ? request.hidden : existing.hidden;

    const nextDiagrams = contentChanged
      ? markDiagramsStale(existing.diagrams)
      : existing.diagrams;

    // Re-evaluate each comment thread's anchor state only when the plan content
    // changed; non-content updates must leave comment threads untouched.
    const nextCommentThreads = contentChanged
      ? reevaluateCommentAnchors(existing.commentThreads, nextContent)
      : existing.commentThreads;

    const updated: TrackedPlanData = {
      ...existing,
      source: nextSource,
      title: nextTitle,
      content: nextContent,
      reviewStatus: nextReviewStatus,
      updatedAt: nextUpdatedAt,
      latestRevisionNumber: nextRevisionNumber,
      revisions,
      linkedExecutionIds: linkExecutionIds(
        existing.linkedExecutionIds,
        request.linkedExecutionId,
      ),
      ...(nextApprovedAt ? { approvedAt: nextApprovedAt } : {}),
      ...(nextDismissedAt ? { dismissedAt: nextDismissedAt } : {}),
      ...(nextHidden !== undefined ? { hidden: nextHidden } : {}),
      ...(nextDiagrams ? { diagrams: nextDiagrams } : {}),
      ...(nextCommentThreads ? { commentThreads: nextCommentThreads } : {}),
      ...(request.lastEditSource
        ? { lastEditSource: request.lastEditSource }
        : {}),
    };

    if (!nextApprovedAt) {
      delete updated.approvedAt;
    }
    if (!nextDismissedAt) {
      delete updated.dismissedAt;
    }

    file.plans = file.plans.map((plan) =>
      plan.id === request.planId ? updated : plan,
    );
    await writeTrackedPlansFile(request.projectId, request.worktreeId, file);
    const becameApproved =
      existing.reviewStatus !== 'approved' &&
      updated.reviewStatus === 'approved';
    if (
      updated.latestRevisionNumber > existing.latestRevisionNumber &&
      updated.reviewStatus !== 'dismissed' &&
      (updated.reviewStatus !== 'approved' || becameApproved)
    ) {
      recordPlanUsageEvent('plan_updated', updated, request);
    }
    if (becameApproved) {
      recordPlanUsageEvent('plan_approved', updated, request);
    }
    if (contentChanged) {
      emitPlanContentChange(updated);
    }
    const shareRelevantChanged =
      existing.title !== updated.title ||
      existing.content !== updated.content ||
      existing.source !== updated.source ||
      existing.reviewStatus !== updated.reviewStatus ||
      existing.latestRevisionNumber !== updated.latestRevisionNumber ||
      // Linking an execution changes the derived "implementation started" signal
      // (telemetry maps linkedExecutionIds.length > 0 to implementationStartedAt),
      // so a new linked execution must propagate to the shared/synced plan.
      existing.linkedExecutionIds.length !== updated.linkedExecutionIds.length;
    if (shareRelevantChanged) {
      emitPlanShareChange(updated);
    }
    return updated;
  });
}

export async function setTrackedPlanShareState(
  projectId: string,
  worktreeId: string,
  planId: string,
  share: TrackedPlanShareState | undefined | TrackedPlanShareStateUpdater,
): Promise<TrackedPlanData | null> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const existing = file.plans.find((plan) => plan.id === planId);
    if (!existing) {
      return null;
    }

    const nextShare =
      typeof share === 'function' ? share(existing.share) : share;
    const updated: TrackedPlanData = {
      ...existing,
      ...(nextShare ? { share: nextShare } : {}),
    };
    if (!nextShare) {
      delete updated.share;
    }

    file.plans = file.plans.map((plan) =>
      plan.id === planId ? updated : plan,
    );
    await writeTrackedPlansFile(projectId, worktreeId, file);
    return updated;
  });
}

export async function saveTrackedPlanComments(
  request: SaveTrackedPlanCommentsRequest,
): Promise<TrackedPlanData | null> {
  if (!isPlanCommentThreadArray(request.commentThreads)) {
    throw new Error('Invalid plan comment threads payload.');
  }

  const filePath = resolveTrackedPlansFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(
      request.projectId,
      request.worktreeId,
    );
    const existing = file.plans.find((plan) => plan.id === request.planId);
    if (!existing) {
      return null;
    }
    const mergedCommentThreads = mergeCommentThreads(
      existing.commentThreads ?? [],
      request.commentThreads,
    );
    const updated: TrackedPlanData = {
      ...existing,
      commentThreads: mergedCommentThreads,
      updatedAt: new Date().toISOString(),
    };
    file.plans = file.plans.map((plan) =>
      plan.id === request.planId ? updated : plan,
    );
    await writeTrackedPlansFile(request.projectId, request.worktreeId, file);
    return updated;
  });
}

export interface AppendPlanCommentReplyRequest {
  projectId: string;
  worktreeId: string;
  planId: string;
  threadId: string;
  body: string;
  resolve?: boolean;
  /**
   * When true, reject the reply (no write, no side effects) unless the thread
   * has at least one non-draft comment. Callers that expose replies to a
   * shared collaborator (e.g. the plan-comment agent tool) set this so an
   * agent can never respond to a thread the owner has not yet submitted.
   */
  requireSubmittedThread?: boolean;
}

export interface AppendPlanCommentReplyResult {
  ok: boolean;
  plan?: TrackedPlanData;
  error?: string;
  /**
   * Set only when `requireSubmittedThread` rejected a draft-only thread, so a
   * caller can wait for the submit hand-off and retry. `error` keeps the same
   * text.
   */
  reason?: 'not-submitted';
}

/**
 * A plan comment thread's owning plan, projected to the fields a formatter or
 * caller needs without exposing the whole {@link TrackedPlanData} record.
 */
export interface PlanCommentThreadOwner {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
  readonly title: string;
  readonly latestRevisionNumber: number;
  readonly content: string;
}

function toPlanCommentThreadOwner(
  plan: TrackedPlanData,
): PlanCommentThreadOwner {
  return {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    planId: plan.id,
    title: plan.title,
    latestRevisionNumber: plan.latestRevisionNumber,
    content: plan.content,
  };
}

/**
 * Whether a plan comment thread has been submitted to the agent at least
 * once, i.e. it has at least one comment that is not still a local-only
 * draft. Draft-only threads must never be exposed to (or replied to by) an
 * agent tool.
 */
export function isPlanCommentThreadSubmitted(
  thread: PlanCommentThread,
): boolean {
  return thread.comments.some((comment) => comment.staged !== true);
}

/** Identifies one comment thread on one tracked plan. */
export interface PlanCommentThreadRef {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly planId: string;
  readonly threadId: string;
}

/**
 * How long the agent-facing plan comment tools wait for a thread to become
 * submitted before treating it as a draft. The renderer acknowledges a
 * handed-off snapshot (drafts become `staged: false`) only after the owning
 * chat accepted the send, and acceptance means the provider turn has already
 * started. A thread named in the message that started the turn can therefore
 * still be draft-only for about one IPC round trip when the agent's first
 * tool call reads or replies to it. The grace bounds that wait; a thread that
 * stays draft-only past it is treated as unsubmitted.
 */
export const PLAN_COMMENT_HANDOFF_GRACE_MS = 5_000;

type PlanCommentThreadSubmission = 'submitted' | 'draft' | 'missing';

function planCommentThreadSubmission(
  file: TrackedPlansFile,
  ref: PlanCommentThreadRef,
): PlanCommentThreadSubmission {
  const plan = file.plans.find((entry) => entry.id === ref.planId);
  const thread = plan?.commentThreads?.find(
    (entry) => entry.id === ref.threadId,
  );
  if (!thread) {
    return 'missing';
  }
  return isPlanCommentThreadSubmitted(thread) ? 'submitted' : 'draft';
}

/**
 * Wait up to `timeoutMs` for a plan comment thread to have at least one
 * submitted comment (see {@link PLAN_COMMENT_HANDOFF_GRACE_MS}). Resolves
 * `true` as soon as it does, including immediately when it already has one,
 * and `false` on timeout or once the plan or thread is gone. Never rejects.
 *
 * The write listener is registered before the current file is read, so an
 * acknowledgment that lands between the two is still observed. The plan file
 * lock is never held while waiting: the acknowledgment itself needs it.
 */
export function waitForSubmittedPlanCommentThread(
  ref: PlanCommentThreadRef,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (submitted: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeTrackedPlansWriteListener(onWrite);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(submitted);
    };

    const check = (file: TrackedPlansFile): void => {
      const submission = planCommentThreadSubmission(file, ref);
      if (submission !== 'draft') {
        finish(submission === 'submitted');
      }
    };

    function onWrite(
      projectId: string,
      worktreeId: string,
      file: TrackedPlansFile,
    ): void {
      if (projectId === ref.projectId && worktreeId === ref.worktreeId) {
        check(file);
      }
    }

    addTrackedPlansWriteListener(onWrite);
    timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    readTrackedPlansFile(ref.projectId, ref.worktreeId).then(check, () => {
      finish(false);
    });
  });
}

export type ReadScopedPlanCommentThreadsResult =
  | { ok: false; reason: 'not-found' | 'ambiguous'; error: string }
  | {
      ok: true;
      mode: 'single';
      owner: PlanCommentThreadOwner;
      thread: PlanCommentThread;
    }
  | {
      ok: true;
      mode: 'all';
      threads: Array<{
        owner: PlanCommentThreadOwner;
        thread: PlanCommentThread;
      }>;
    };

/**
 * Read-only access to every tracked plan's comment threads within a
 * `(projectId, worktreeId)` scope, for the shared file-comment tool surface
 * (which searches file annotations, code-review, and plan storage together).
 * No file lock is needed because nothing is mutated.
 *
 * With a `threadId`, searches every plan in the scope: a match in exactly one
 * plan returns it (`mode: 'single'`); a match in more than one plan is
 * `ambiguous` (thread ids are only unique within their own store); no match is
 * `not-found`. Without a `threadId`, returns every OPEN thread across every
 * plan in the scope (`mode: 'all'`), ordered the same as {@link
 * listTrackedPlans} (most-recently-updated plan first).
 */
export async function readScopedPlanCommentThreads(request: {
  projectId: string;
  worktreeId: string;
  threadId?: string;
}): Promise<ReadScopedPlanCommentThreadsResult> {
  const file = await readTrackedPlansFile(
    request.projectId,
    request.worktreeId,
  );
  const plans = [...file.plans].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  );

  if (request.threadId !== undefined) {
    const matches: Array<{
      owner: PlanCommentThreadOwner;
      thread: PlanCommentThread;
    }> = [];
    for (const plan of plans) {
      const thread = (plan.commentThreads ?? []).find(
        (entry) => entry.id === request.threadId,
      );
      if (thread) {
        matches.push({ owner: toPlanCommentThreadOwner(plan), thread });
      }
    }
    if (matches.length === 0) {
      return {
        ok: false,
        reason: 'not-found',
        error: 'Comment thread not found.',
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        error: 'Ambiguous comment thread id.',
      };
    }
    const [match] = matches;
    return {
      ok: true,
      mode: 'single',
      owner: match.owner,
      thread: match.thread,
    };
  }

  const threads: Array<{
    owner: PlanCommentThreadOwner;
    thread: PlanCommentThread;
  }> = [];
  for (const plan of plans) {
    const owner = toPlanCommentThreadOwner(plan);
    for (const thread of plan.commentThreads ?? []) {
      if (thread.status === 'open') {
        threads.push({ owner, thread });
      }
    }
  }
  return { ok: true, mode: 'all', threads };
}

/**
 * Append an agent reply to a single plan comment thread, optionally resolving
 * it. Performs a read-modify-write under the per-file lock and mutates ONLY the
 * matched thread so concurrent UI edits to other threads (or staged drafts) are
 * not clobbered. The thread's other fields (anchor, anchorState, prior
 * comments) are preserved verbatim.
 */
export async function appendPlanCommentReply(
  request: AppendPlanCommentReplyRequest,
): Promise<AppendPlanCommentReplyResult> {
  const filePath = resolveTrackedPlansFilePath(
    request.projectId,
    request.worktreeId,
  );
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(
      request.projectId,
      request.worktreeId,
    );
    const existing = file.plans.find((plan) => plan.id === request.planId);
    if (!existing) {
      return { ok: false, error: 'Plan not found.' };
    }

    const threads = existing.commentThreads ?? [];
    const thread = threads.find((entry) => entry.id === request.threadId);
    if (!thread) {
      return { ok: false, error: 'Comment thread not found.' };
    }

    if (
      request.requireSubmittedThread &&
      !isPlanCommentThreadSubmitted(thread)
    ) {
      return {
        ok: false,
        reason: 'not-submitted',
        error: 'Comment thread has not been submitted.',
      };
    }

    const now = new Date().toISOString();
    const reply: PlanComment = {
      id: randomUUID(),
      author: 'agent',
      body: request.body,
      createdAt: now,
      staged: false,
    };
    const nextThread: PlanCommentThread = {
      ...thread,
      comments: [...thread.comments, reply],
      ...(request.resolve ? { status: 'resolved' } : {}),
    };
    const nextThreads = threads.map((entry) =>
      entry.id === request.threadId ? nextThread : entry,
    );

    const updated: TrackedPlanData = {
      ...existing,
      commentThreads: nextThreads,
      updatedAt: now,
    };
    file.plans = file.plans.map((plan) =>
      plan.id === request.planId ? updated : plan,
    );
    await writeTrackedPlansFile(request.projectId, request.worktreeId, file);
    return { ok: true, plan: updated };
  });
}

export interface ReadPlanCommentThreadRequest {
  projectId: string;
  worktreeId: string;
  planId: string;
  threadId?: string;
}

export type ReadPlanCommentThreadResult =
  | { ok: false; error: string }
  | { ok: true; mode: 'single'; thread: PlanCommentThread }
  | { ok: true; mode: 'all'; threads: PlanCommentThread[] };

/**
 * Read-only access to a plan's comment threads for the plan-explore tool. With
 * a `threadId` it returns that single thread; without one it returns every
 * thread on the plan (the session-runtime formats the open-thread summary). No
 * file lock is needed because nothing is mutated.
 */
export async function readPlanCommentThread(
  request: ReadPlanCommentThreadRequest,
): Promise<ReadPlanCommentThreadResult> {
  const file = await readTrackedPlansFile(
    request.projectId,
    request.worktreeId,
  );
  const plan = file.plans.find((entry) => entry.id === request.planId);
  if (!plan) {
    return { ok: false, error: 'Plan not found.' };
  }

  const threads = plan.commentThreads ?? [];
  if (request.threadId !== undefined) {
    const thread = threads.find((entry) => entry.id === request.threadId);
    if (!thread) {
      return { ok: false, error: 'Comment thread not found.' };
    }
    return { ok: true, mode: 'single', thread };
  }

  return { ok: true, mode: 'all', threads };
}

/**
 * Persist a generated diagram artifact onto a tracked plan. This mutates only
 * the derived `diagrams` map; it does NOT alter plan content and therefore must
 * NOT invoke the content-change listener (doing so would cause generation to
 * loop forever).
 */
export async function setPlanDiagramArtifact(
  projectId: string,
  worktreeId: string,
  planId: string,
  key: 'sequence' | 'logicDiff' | 'dataModelDiff',
  artifact: AnyPlanDiagramArtifact,
): Promise<TrackedPlanData | null> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const existing = file.plans.find((plan) => plan.id === planId);
    if (!existing) {
      return null;
    }

    const lagsCurrentRevision =
      (artifact.status === 'ready' || artifact.status === 'error') &&
      artifact.derivedFromRevision < existing.latestRevisionNumber;
    const nextArtifact = lagsCurrentRevision
      ? { ...artifact, status: 'stale' as const }
      : artifact;
    const nextDiagrams: PlanDiagramArtifacts = { ...existing.diagrams };
    if (key === 'sequence' && isSequenceArtifact(nextArtifact)) {
      nextDiagrams.sequence = nextArtifact;
    } else if (key === 'logicDiff' && isLogicDiffArtifact(nextArtifact)) {
      nextDiagrams.logicDiff = nextArtifact;
    } else if (
      key === 'dataModelDiff' &&
      isDataModelDiffArtifact(nextArtifact)
    ) {
      const existingDataModelArtifact = existing.diagrams?.dataModelDiff;
      if (
        lagsCurrentRevision &&
        (existingDataModelArtifact === undefined ||
          existingDataModelArtifact.derivedFromRevision >
            artifact.derivedFromRevision)
      ) {
        return existing;
      }
      nextDiagrams.dataModelDiff = nextArtifact;
    } else {
      return existing;
    }

    const updated: TrackedPlanData = {
      ...existing,
      diagrams: nextDiagrams,
    };
    file.plans = file.plans.map((plan) =>
      plan.id === planId ? updated : plan,
    );
    await writeTrackedPlansFile(projectId, worktreeId, file);
    emitPlanDiagramArtifactChange(updated);
    return updated;
  });
}

type AnyPlanDiagramArtifact =
  | PlanDiagramArtifact<ParsedPlanGraph>
  | PlanDiagramArtifact<LogicDiffDiagram>
  | PlanDiagramArtifact<DataModelDiffDiagram>;

function isSequenceArtifact(
  artifact: AnyPlanDiagramArtifact,
): artifact is PlanDiagramArtifact<ParsedPlanGraph> {
  const data = artifact.data;
  return data === null || isParsedPlanGraph(data);
}

function isLogicDiffArtifact(
  artifact: AnyPlanDiagramArtifact,
): artifact is PlanDiagramArtifact<LogicDiffDiagram> {
  const data = artifact.data;
  return data === null || isLogicDiffDiagram(data);
}

function isDataModelDiffArtifact(
  artifact: AnyPlanDiagramArtifact,
): artifact is PlanDiagramArtifact<DataModelDiffDiagram> {
  const data = artifact.data;
  return data === null || isDataModelDiffDiagram(data);
}

export async function removePlanDiagramArtifact(
  projectId: string,
  worktreeId: string,
  planId: string,
  key: 'dataModelDiff',
  expectedRevision: number,
): Promise<TrackedPlanData | null> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const existing = file.plans.find((plan) => plan.id === planId);
    if (!existing) {
      return null;
    }

    if (expectedRevision < existing.latestRevisionNumber) {
      return existing;
    }

    if (!existing.diagrams?.dataModelDiff) {
      return existing;
    }

    const nextDiagrams: PlanDiagramArtifacts = { ...existing.diagrams };
    delete nextDiagrams.dataModelDiff;
    const updated: TrackedPlanData = {
      ...existing,
      diagrams: nextDiagrams,
    };
    file.plans = file.plans.map((plan) =>
      plan.id === planId ? updated : plan,
    );
    await writeTrackedPlansFile(projectId, worktreeId, file);
    emitPlanDiagramArtifactChange(updated);
    return updated;
  });
}

export async function deleteTrackedPlan(
  projectId: string,
  worktreeId: string,
  planId: string,
): Promise<void> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  return withFileLock(filePath, async () => {
    const file = await readTrackedPlansFile(projectId, worktreeId);
    const nextPlans = file.plans.filter((plan) => plan.id !== planId);
    if (nextPlans.length === file.plans.length) {
      return;
    }

    await writeTrackedPlansFile(projectId, worktreeId, {
      version: 1,
      plans: nextPlans,
    });
  });
}

export async function deleteTrackedPlansForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  await rm(filePath, { force: true });
}

/**
 * Installs plans captured from an archived container into a restored
 * worktree. Each plan is re-bound to the destination ids; everything else
 * (revisions, comments, diagrams, share state, execution links) is preserved
 * verbatim. An empty list is a no-op rather than clearing the destination.
 */
export async function installRestoredTrackedPlans(
  projectId: string,
  worktreeId: string,
  plans: TrackedPlanData[],
): Promise<void> {
  if (plans.length === 0) return;
  const filePath = resolveTrackedPlansFilePath(projectId, worktreeId);
  await withFileLock(filePath, async () => {
    await writeTrackedPlansFile(projectId, worktreeId, {
      version: 1,
      plans: plans.map((plan) => ({ ...plan, projectId, worktreeId })),
    });
  });
}
