import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { HookTriggerName } from '@canopy/desktop-shared/hooks';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  WORKSPACE_ROOT_REPO_NAME,
  type UsageRepoScope,
} from '@canopy/desktop-shared/types';
import type {
  GitHubCheckSnapshot,
  GitHubMergeConflictSnapshot,
  PersistedPrSnapshotFileV1,
  PrMergeQueueSnapshot,
  PrTrackingStateFile,
} from '@canopy/desktop-shared/types/github';
import {
  interpretPrMergeQueueHookSample,
  readPrMergeQueueSnapshot,
} from '@canopy/desktop-shared/lib/pr-merge-queue';
import { getGitHubPrStateDir, getWorktreeDataDir } from './paths';
import { getObservabilityService } from '../observability';

const PROJECT_REPO_STORAGE_KEY = 'project-root';
const MERGED_PR_CATCH_UP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PREVIEW_INDEX_LOCATIONS = 500;
const MAX_PREVIEW_LOOKUP_LOCATIONS = 1024;
const MAX_PREVIEW_LOOKUP_READS = 2048;
const PREVIEW_LOOKUP_TIMEOUT_MS = 500;

interface PreviewLookupBudget {
  signal: AbortSignal;
  remainingReads: number;
}

function usePreviewRead(budget: PreviewLookupBudget): void {
  budget.signal.throwIfAborted();
  if (budget.remainingReads-- <= 0)
    throw new Error('Preview lookup work budget exhausted');
}

function isMissingPreviewFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

interface PrSnapshotLocation {
  projectId: string;
  worktreeId: string;
  repoStorageKey?: string;
}

interface PrPreviewIndexEntry {
  location: Required<PrSnapshotLocation>;
  credentialScope: string;
  owner: string;
  repository: string;
  number: number;
  capturedAt: number;
}

interface PreviewWorktreeScan {
  promise: Promise<void>;
  complete: boolean;
}

const previewSnapshots = new Map<string, PrPreviewIndexEntry | null>();
const scannedWorktrees = new Map<string, PreviewWorktreeScan>();
const previewLookups = new Map<string, PrPreviewIndexEntry | null>();
const pendingPreviewLookups = new Map<
  string,
  Promise<PrPreviewIndexEntry | null>
>();
const pendingRepositoryDirectories = new Map<string, Promise<string[]>>();
let acceptedWriterRevision = 0;

export function resetPrPreviewIndexForTests(): void {
  previewLookups.clear();
  previewSnapshots.clear();
  scannedWorktrees.clear();
  pendingPreviewLookups.clear();
  pendingRepositoryDirectories.clear();
  acceptedWriterRevision += 1;
}

function invalidatePreviewLookups(
  snapshot: PersistedPrSnapshotFileV1 | null,
): void {
  acceptedWriterRevision += 1;
  pendingPreviewLookups.clear();
  if (!snapshot?.credentialScope) return;
  const targetPrefix = JSON.stringify([
    snapshot.credentialScope,
    snapshot.repository.owner.toLowerCase(),
    snapshot.repository.name.toLowerCase(),
    snapshot.pr.number,
  ]).slice(0, -1);
  for (const key of Array.from(previewLookups.keys())) {
    if (key.startsWith(`${targetPrefix},`)) previewLookups.delete(key);
  }
}

function previewLocationKey(location: Required<PrSnapshotLocation>): string {
  return `${location.projectId}\0${location.worktreeId}\0${location.repoStorageKey}`;
}

function rememberPreviewSnapshot(
  location: Required<PrSnapshotLocation>,
  snapshot: PersistedPrSnapshotFileV1 | null,
): void {
  const key = previewLocationKey(location);
  previewSnapshots.delete(key);
  const capturedAt = Date.parse(snapshot?.capturedAt ?? '');
  previewSnapshots.set(
    key,
    snapshot?.credentialScope && Number.isFinite(capturedAt)
      ? {
          location,
          credentialScope: snapshot.credentialScope,
          owner: snapshot.repository.owner.toLowerCase(),
          repository: snapshot.repository.name.toLowerCase(),
          number: snapshot.pr.number,
          capturedAt,
        }
      : null,
  );
  while (previewSnapshots.size > MAX_PREVIEW_INDEX_LOCATIONS) {
    const oldest = previewSnapshots.keys().next().value;
    if (oldest === undefined) break;
    previewSnapshots.delete(oldest);
    const worktreeKey = oldest.slice(0, oldest.lastIndexOf('\0'));
    const scan = scannedWorktrees.get(worktreeKey);
    if (scan) scan.complete = false;
  }
}

async function loadPreviewLocation(
  location: Required<PrSnapshotLocation>,
  budget: PreviewLookupBudget,
): Promise<void> {
  budget.signal.throwIfAborted();
  const key = previewLocationKey(location);
  if (previewSnapshots.has(key)) return;
  usePreviewRead(budget);
  const snapshot = await readSnapshotFile(
    getCurrentSnapshotFilePath(
      location.projectId,
      location.worktreeId,
      location.repoStorageKey,
    ),
    budget.signal,
  );
  budget.signal.throwIfAborted();
  if (!previewSnapshots.has(key)) rememberPreviewSnapshot(location, snapshot);
}

function matchesPreviewTarget(
  snapshot: PersistedPrSnapshotFileV1 | null,
  target: { owner: string; repository: string; number: number },
  credentialScope: string,
): snapshot is PersistedPrSnapshotFileV1 {
  return (
    snapshot?.credentialScope === credentialScope &&
    snapshot.credentialScope.length > 0 &&
    snapshot.repository.owner.toLowerCase() === target.owner &&
    snapshot.repository.name.toLowerCase() === target.repository &&
    snapshot.pr.number === target.number &&
    Number.isFinite(Date.parse(snapshot.capturedAt))
  );
}

function rememberPreviewLookup(
  key: string,
  entry: PrPreviewIndexEntry | null,
): void {
  previewLookups.delete(key);
  previewLookups.set(key, entry);
  while (previewLookups.size > MAX_PREVIEW_INDEX_LOCATIONS) {
    const oldest = previewLookups.keys().next().value;
    if (oldest === undefined) break;
    previewLookups.delete(oldest);
  }
}

async function listPreviewRepositories(
  location: PrSnapshotLocation,
  budget: PreviewLookupBudget,
): Promise<string[]> {
  const key = `${location.projectId}\0${location.worktreeId}`;
  let pending = pendingRepositoryDirectories.get(key);
  if (!pending) {
    if (pendingRepositoryDirectories.size >= MAX_PREVIEW_INDEX_LOCATIONS)
      throw new Error('Preview directory read capacity exhausted');
    usePreviewRead(budget);
    // Keep uncancellable directory I/O shared until it settles, even after timeout.
    pending = readdir(
      join(
        getWorktreeDataDir(location.projectId, location.worktreeId),
        'github-pr',
      ),
      { withFileTypes: true },
    )
      .then((entries) => {
        budget.signal.throwIfAborted();
        if (entries.length > MAX_PREVIEW_LOOKUP_READS)
          throw new Error('Preview repository inventory exceeds lookup budget');
        return entries
          .filter(
            (entry) =>
              entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name),
          )
          .map((entry) => entry.name);
      })
      .catch((error: unknown) => {
        if (isMissingPreviewFile(error)) return [];
        throw error;
      });
    pendingRepositoryDirectories.set(key, pending);
  }
  try {
    const repositories = await pending;
    budget.signal.throwIfAborted();
    return repositories;
  } finally {
    if (pendingRepositoryDirectories.get(key) === pending) {
      pendingRepositoryDirectories.delete(key);
    }
  }
}

async function scanPreviewWorktree(
  location: PrSnapshotLocation,
  budget: PreviewLookupBudget,
): Promise<void> {
  const key = `${location.projectId}\0${location.worktreeId}`;
  let scan = scannedWorktrees.get(key);
  if (!scan) {
    const current: PreviewWorktreeScan = {
      complete: true,
      promise: Promise.resolve(),
    };
    const forget = (): void => {
      if (scannedWorktrees.get(key) === current) scannedWorktrees.delete(key);
    };
    budget.signal.addEventListener('abort', forget, { once: true });
    current.promise = (async (): Promise<void> => {
      const repoStorageKeys = await listPreviewRepositories(location, budget);
      for (const repoStorageKey of repoStorageKeys) {
        await loadPreviewLocation({ ...location, repoStorageKey }, budget);
      }
    })()
      .catch((error: unknown) => {
        forget();
        throw error;
      })
      .finally(() => budget.signal.removeEventListener('abort', forget));
    scan = current;
    scannedWorktrees.set(key, scan);
    while (scannedWorktrees.size > MAX_PREVIEW_INDEX_LOCATIONS) {
      const oldest = scannedWorktrees.keys().next().value;
      if (oldest === undefined) break;
      scannedWorktrees.delete(oldest);
    }
  }
  await scan.promise;
  budget.signal.throwIfAborted();
}

async function discoverPreviewLookup(
  target: { owner: string; repository: string; number: number },
  credentialScope: string,
  locations: readonly PrSnapshotLocation[],
  budget: PreviewLookupBudget,
): Promise<PrPreviewIndexEntry | null> {
  const allowedWorktrees = new Set<string>();
  const allowedLocations = new Set<string>();
  for (const location of locations) {
    if (location.repoStorageKey) {
      const concrete = {
        ...location,
        repoStorageKey: location.repoStorageKey,
      };
      allowedLocations.add(previewLocationKey(concrete));
      await loadPreviewLocation(concrete, budget);
    } else {
      allowedWorktrees.add(`${location.projectId}\0${location.worktreeId}`);
      await scanPreviewWorktree(location, budget);
    }
  }
  let newest: PrPreviewIndexEntry | null = null;
  for (const [locationKey, entry] of Array.from(previewSnapshots)) {
    if (
      !allowedLocations.has(locationKey) &&
      !allowedWorktrees.has(locationKey.slice(0, locationKey.lastIndexOf('\0')))
    ) {
      continue;
    }
    if (
      entry?.credentialScope !== credentialScope ||
      entry.owner !== target.owner ||
      entry.repository !== target.repository ||
      entry.number !== target.number
    ) {
      continue;
    }
    if (!newest || entry.capturedAt > newest.capturedAt) newest = entry;
  }
  for (const location of locations) {
    const worktreeKey = `${location.projectId}\0${location.worktreeId}`;
    if (
      !location.repoStorageKey &&
      scannedWorktrees.get(worktreeKey)?.complete
    ) {
      continue;
    }
    const repoStorageKeys = location.repoStorageKey
      ? previewSnapshots.has(
          previewLocationKey({
            ...location,
            repoStorageKey: location.repoStorageKey,
          }),
        )
        ? []
        : [location.repoStorageKey]
      : await listPreviewRepositories(location, budget);
    for (const repoStorageKey of repoStorageKeys) {
      usePreviewRead(budget);
      const snapshot = await readSnapshotFile(
        getCurrentSnapshotFilePath(
          location.projectId,
          location.worktreeId,
          repoStorageKey,
        ),
        budget.signal,
      );
      budget.signal.throwIfAborted();
      if (!matchesPreviewTarget(snapshot, target, credentialScope)) continue;
      const capturedAt = Date.parse(snapshot.capturedAt);
      if (!newest || capturedAt > newest.capturedAt) {
        newest = {
          location: { ...location, repoStorageKey },
          credentialScope,
          owner: target.owner,
          repository: target.repository,
          number: target.number,
          capturedAt,
        };
      }
    }
  }
  return newest;
}

/** Cold hint discovery yields to the shared broker when its budget expires. */
export async function findTrackedPrSnapshot(
  target: { owner: string; repository: string; number: number },
  credentialScope: string,
  locations: readonly PrSnapshotLocation[],
): Promise<PersistedPrSnapshotFileV1 | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, PREVIEW_LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      lookupTrackedPrSnapshot(target, credentialScope, locations, {
        signal: controller.signal,
        remainingReads: MAX_PREVIEW_LOOKUP_READS,
      }).catch(() => null),
      expired,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}

async function lookupTrackedPrSnapshot(
  target: { owner: string; repository: string; number: number },
  credentialScope: string,
  locations: readonly PrSnapshotLocation[],
  budget: PreviewLookupBudget,
): Promise<PersistedPrSnapshotFileV1 | null> {
  if (locations.length > MAX_PREVIEW_LOOKUP_LOCATIONS) {
    const revision = acceptedWriterRevision;
    let newest: PrPreviewIndexEntry | null = null;
    for (const entry of Array.from(previewSnapshots.values())) {
      if (
        !entry ||
        entry.credentialScope !== credentialScope ||
        entry.owner !== target.owner ||
        entry.repository !== target.repository ||
        entry.number !== target.number
      )
        continue;
      if (
        !locations.some(
          (location) =>
            location.projectId === entry.location.projectId &&
            location.worktreeId === entry.location.worktreeId &&
            (!location.repoStorageKey ||
              location.repoStorageKey === entry.location.repoStorageKey),
        )
      )
        continue;
      if (!newest || entry.capturedAt > newest.capturedAt) newest = entry;
    }
    if (!newest) return null;
    usePreviewRead(budget);
    const snapshot = await readSnapshotFile(
      getCurrentSnapshotFilePath(
        newest.location.projectId,
        newest.location.worktreeId,
        newest.location.repoStorageKey,
      ),
      budget.signal,
    );
    budget.signal.throwIfAborted();
    return revision === acceptedWriterRevision &&
      matchesPreviewTarget(snapshot, target, credentialScope) &&
      Date.parse(snapshot.capturedAt) === newest.capturedAt
      ? snapshot
      : null;
  }
  const inventory = createHash('sha256');
  for (const location of locations) {
    inventory.update(
      JSON.stringify([
        location.projectId,
        location.worktreeId,
        location.repoStorageKey ?? null,
      ]),
    );
  }
  const key = JSON.stringify([
    credentialScope,
    target.owner,
    target.repository,
    target.number,
    inventory.digest('hex'),
  ]);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const revision = acceptedWriterRevision;
    let entry = previewLookups.get(key);
    if (entry === undefined) {
      let pending = pendingPreviewLookups.get(key);
      if (!pending) {
        const forget = (): void => {
          if (pendingPreviewLookups.get(key) === pending)
            pendingPreviewLookups.delete(key);
        };
        budget.signal.addEventListener('abort', forget, { once: true });
        pending = discoverPreviewLookup(
          target,
          credentialScope,
          locations,
          budget,
        ).finally(() => budget.signal.removeEventListener('abort', forget));
        pendingPreviewLookups.set(key, pending);
        while (pendingPreviewLookups.size > MAX_PREVIEW_INDEX_LOCATIONS) {
          const oldest = pendingPreviewLookups.keys().next().value;
          if (oldest === undefined) break;
          pendingPreviewLookups.delete(oldest);
        }
      }
      try {
        entry = await pending;
        budget.signal.throwIfAborted();
      } finally {
        if (pendingPreviewLookups.get(key) === pending) {
          pendingPreviewLookups.delete(key);
        }
      }
      if (revision !== acceptedWriterRevision) continue;
      rememberPreviewLookup(key, entry);
    }
    if (!entry) return null;
    usePreviewRead(budget);
    const snapshot = await readSnapshotFile(
      getCurrentSnapshotFilePath(
        entry.location.projectId,
        entry.location.worktreeId,
        entry.location.repoStorageKey,
      ),
      budget.signal,
    );
    budget.signal.throwIfAborted();
    if (revision !== acceptedWriterRevision) continue;
    if (
      matchesPreviewTarget(snapshot, target, credentialScope) &&
      Date.parse(snapshot.capturedAt) === entry.capturedAt
    ) {
      return snapshot;
    }
    previewLookups.delete(key);
  }
  return null;
}

function getStateFilePath(
  projectId: string,
  worktreeId: string,
  repoStorageKey: string,
): string {
  return join(
    getGitHubPrStateDir(projectId, worktreeId, repoStorageKey),
    'state.json',
  );
}

function getCurrentSnapshotFilePath(
  projectId: string,
  worktreeId: string,
  repoStorageKey: string,
): string {
  return join(
    getGitHubPrStateDir(projectId, worktreeId, repoStorageKey),
    'current.json',
  );
}

function getUsageRepoScopeFromStorageKey(args: {
  projectId: string;
  worktreeId: string;
  repoStorageKey: string;
  snapshot: PersistedPrSnapshotFileV1;
}): UsageRepoScope {
  const repoId =
    args.repoStorageKey === PROJECT_REPO_STORAGE_KEY
      ? SINGLE_REPO_USAGE_REPO_ID
      : args.repoStorageKey === WORKSPACE_ROOT_REPO_ID
        ? WORKSPACE_ROOT_REPO_ID
        : args.repoStorageKey;
  const repoLabel =
    repoId === WORKSPACE_ROOT_REPO_ID
      ? WORKSPACE_ROOT_REPO_NAME
      : args.snapshot.repository.name;
  return {
    workspaceId: args.projectId,
    worktreeId: args.worktreeId,
    repoId,
    repoLabel,
  };
}

function getPreviousSnapshotFilePath(
  projectId: string,
  worktreeId: string,
  repoStorageKey: string,
): string {
  return join(
    getGitHubPrStateDir(projectId, worktreeId, repoStorageKey),
    'previous.json',
  );
}

export function getProjectRepoStorageKey(): string {
  return PROJECT_REPO_STORAGE_KEY;
}

export function getWorkspaceRootRepoStorageKey(): string {
  return WORKSPACE_ROOT_REPO_ID;
}

export function getWorkspaceRepoStorageKey(repoId: string): string {
  return repoId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTrackingStateFile(value: unknown): value is PrTrackingStateFile {
  if (!isRecord(value) || !isRecord(value.snapshotCompleteness)) {
    return false;
  }

  return (
    value.version === 1 &&
    typeof value.branchName === 'string' &&
    typeof value.syncedAt === 'string' &&
    (value.currentPrId === null || typeof value.currentPrId === 'number') &&
    typeof value.snapshotCompleteness.includesComments === 'boolean' &&
    typeof value.snapshotCompleteness.includesReviews === 'boolean' &&
    typeof value.snapshotCompleteness.includesReviewComments === 'boolean'
  );
}

function isSnapshot(value: unknown): value is PersistedPrSnapshotFileV1 {
  if (!isRecord(value) || !isRecord(value.repository) || !isRecord(value.pr)) {
    return false;
  }

  return (
    value.version === 1 &&
    value.provider === 'github' &&
    typeof value.capturedAt === 'string' &&
    typeof value.includesComments === 'boolean' &&
    typeof value.includesReviews === 'boolean' &&
    typeof value.includesReviewComments === 'boolean' &&
    typeof value.repository.owner === 'string' &&
    typeof value.repository.name === 'string' &&
    typeof value.pr.id === 'number' &&
    typeof value.pr.number === 'number'
  );
}

/** Snapshot with `mergeQueue` replaced; `undefined` omits it. */
function withMergeQueue(
  snapshot: PersistedPrSnapshotFileV1,
  mergeQueue: PrMergeQueueSnapshot | undefined,
): PersistedPrSnapshotFileV1 {
  const next: PersistedPrSnapshotFileV1 = { ...snapshot };
  if (mergeQueue) next.mergeQueue = mergeQueue;
  else delete next.mergeQueue;
  return next;
}

/** Snapshot with `mergeConflicts` replaced; `undefined` omits it. */
function withMergeConflicts(
  snapshot: PersistedPrSnapshotFileV1,
  mergeConflicts: GitHubMergeConflictSnapshot | undefined,
): PersistedPrSnapshotFileV1 {
  const next: PersistedPrSnapshotFileV1 = { ...snapshot };
  if (mergeConflicts) next.mergeConflicts = mergeConflicts;
  else delete next.mergeConflicts;
  return next;
}

/** Stored queue evidence is validated on read; invalid evidence is unknown. */
async function readSnapshotFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<PersistedPrSnapshotFileV1 | null> {
  const snapshot = await readJsonFile(filePath, isSnapshot, signal);
  return snapshot && snapshot.mergeQueue !== undefined
    ? withMergeQueue(snapshot, readPrMergeQueueSnapshot(snapshot.mergeQueue))
    : snapshot;
}

async function readJsonFile<T>(
  filePath: string,
  isExpected: (value: unknown) => value is T,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const raw = signal
      ? await readFile(filePath, { encoding: 'utf8', signal })
      : await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isExpected(parsed) ? parsed : null;
  } catch (error) {
    if (
      signal &&
      !(error instanceof SyntaxError) &&
      !isMissingPreviewFile(error)
    )
      throw error;
    return null;
  }
}

async function writeSnapshotFile(
  filePath: string,
  snapshot: PersistedPrSnapshotFileV1 | null,
): Promise<void> {
  if (!snapshot) {
    await rm(filePath, { force: true });
    return;
  }

  await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

function areRelevantLabelsEqual(
  left: PersistedPrSnapshotFileV1,
  right: PersistedPrSnapshotFileV1,
): boolean {
  const leftLabels = left.pr.labels.map((label) => `${label.id}:${label.name}`);
  const rightLabels = right.pr.labels.map(
    (label) => `${label.id}:${label.name}`,
  );
  return JSON.stringify(leftLabels) === JSON.stringify(rightLabels);
}

function extractIssueCommentSignature(
  snapshot: PersistedPrSnapshotFileV1,
): string[] {
  return snapshot.issueComments.map((comment) =>
    JSON.stringify({
      id: comment.id,
      body: comment.body,
      updatedAt: comment.updatedAt,
      authorAssociation: comment.authorAssociation,
    }),
  );
}

function extractReviewSignature(snapshot: PersistedPrSnapshotFileV1): string[] {
  return snapshot.reviews.map((review) =>
    JSON.stringify({
      id: review.id,
      state: review.state,
      body: review.body,
      submittedAt: review.submittedAt,
      commitId: review.commitId,
    }),
  );
}

function extractReviewCommentSignature(
  snapshot: PersistedPrSnapshotFileV1,
): string[] {
  return snapshot.reviewComments.map((comment) =>
    JSON.stringify({
      id: comment.id,
      body: comment.body,
      updatedAt: comment.updatedAt,
      line: comment.line,
      path: comment.path,
      inReplyToId: comment.inReplyToId,
      pullRequestReviewId: comment.pullRequestReviewId,
    }),
  );
}

function hasCommentDiff(
  previous: PersistedPrSnapshotFileV1,
  current: PersistedPrSnapshotFileV1,
): boolean {
  if (!previous.includesComments || !current.includesComments) {
    return false;
  }
  if (!previous.includesReviews || !current.includesReviews) {
    return false;
  }
  if (!previous.includesReviewComments || !current.includesReviewComments) {
    return false;
  }

  return (
    JSON.stringify(extractIssueCommentSignature(previous)) !==
      JSON.stringify(extractIssueCommentSignature(current)) ||
    JSON.stringify(extractReviewSignature(previous)) !==
      JSON.stringify(extractReviewSignature(current)) ||
    JSON.stringify(extractReviewCommentSignature(previous)) !==
      JSON.stringify(extractReviewCommentSignature(current))
  );
}

function isNewReviewSubmission(args: {
  reviewId: number;
  reviewState: string;
  reviewBody: string;
  currentSnapshot: PersistedPrSnapshotFileV1;
}): boolean {
  if (args.reviewState !== 'COMMENTED') {
    return true;
  }

  if (args.reviewBody.trim().length > 0) {
    return true;
  }

  return hasTopLevelInlineCommentForReview({
    reviewId: args.reviewId,
    currentSnapshot: args.currentSnapshot,
  });
}

function hasTopLevelInlineCommentForReview(args: {
  reviewId: number;
  currentSnapshot: PersistedPrSnapshotFileV1;
}): boolean {
  if (!args.currentSnapshot.includesReviewComments) {
    return false;
  }

  return args.currentSnapshot.reviewComments.some(
    (comment) =>
      comment.pullRequestReviewId === args.reviewId &&
      comment.inReplyToId === null,
  );
}

function getNewSubmittedReviewIds(
  previous: PersistedPrSnapshotFileV1,
  current: PersistedPrSnapshotFileV1,
): number[] {
  if (!previous.includesReviews || !current.includesReviews) {
    return [];
  }

  const previousReviewIds = new Set(
    previous.reviews.map((review) => review.id),
  );

  return current.reviews
    .filter(
      (review) =>
        !previousReviewIds.has(review.id) &&
        isNewReviewSubmission({
          reviewId: review.id,
          reviewState: review.state,
          reviewBody: review.body,
          currentSnapshot: current,
        }),
    )
    .map((review) => review.id);
}

function hasNewReviewWithInlineComments(args: {
  reviewIds: number[];
  currentSnapshot: PersistedPrSnapshotFileV1;
}): boolean {
  return args.reviewIds.some((reviewId) =>
    hasTopLevelInlineCommentForReview({
      reviewId,
      currentSnapshot: args.currentSnapshot,
    }),
  );
}

function hasCommentBaselineReset(args: {
  previousCompleteness: {
    includesComments: boolean;
    includesReviews: boolean;
    includesReviewComments: boolean;
  };
  currentSnapshot: PersistedPrSnapshotFileV1;
}): boolean {
  const previousWasComplete =
    args.previousCompleteness.includesComments &&
    args.previousCompleteness.includesReviews &&
    args.previousCompleteness.includesReviewComments;
  const currentIsComplete =
    args.currentSnapshot.includesComments &&
    args.currentSnapshot.includesReviews &&
    args.currentSnapshot.includesReviewComments;
  return !previousWasComplete && currentIsComplete;
}

const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(['success']);
const PASS_ALL_CHECK_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);
const FAILING_CHECK_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'startup_failure',
]);

function getSnapshotChecks(
  snapshot: PersistedPrSnapshotFileV1 | null,
): GitHubCheckSnapshot[] {
  if (!snapshot?.checks || !Array.isArray(snapshot.checks.items)) {
    return [];
  }

  return snapshot.checks.items;
}

function getCheckIdentity(check: GitHubCheckSnapshot): string {
  return `${check.appSlug ?? check.appName ?? ''}\0${check.name}`;
}

function getCheckConclusion(check: GitHubCheckSnapshot): string | null {
  return typeof check.conclusion === 'string' ? check.conclusion : null;
}

function getCheckRawStatus(check: GitHubCheckSnapshot): string | null {
  return typeof check.rawStatus === 'string' ? check.rawStatus : null;
}

function isSuccessfulCheck(check: GitHubCheckSnapshot): boolean {
  const conclusion = getCheckConclusion(check);
  if (conclusion !== null) {
    return SUCCESSFUL_CHECK_CONCLUSIONS.has(conclusion);
  }

  return check.status === 'passing';
}

function isFailingCheck(check: GitHubCheckSnapshot): boolean {
  const conclusion = getCheckConclusion(check);
  if (conclusion !== null) {
    return FAILING_CHECK_CONCLUSIONS.has(conclusion);
  }

  return check.status === 'failing';
}

function isTerminalCheck(check: GitHubCheckSnapshot): boolean {
  const rawStatus = getCheckRawStatus(check);
  if (rawStatus !== null) {
    return rawStatus === 'completed';
  }

  return check.status !== 'pending' && check.status !== 'none';
}

function isPassAllEligibleCheck(check: GitHubCheckSnapshot): boolean {
  const conclusion = getCheckConclusion(check);
  if (conclusion !== null) {
    return PASS_ALL_CHECK_CONCLUSIONS.has(conclusion);
  }

  return check.status === 'passing' || check.status === 'neutral';
}

function buildCheckMap(
  snapshot: PersistedPrSnapshotFileV1 | null,
): Map<string, GitHubCheckSnapshot> {
  return new Map(
    getSnapshotChecks(snapshot).map((check): [string, GitHubCheckSnapshot] => [
      getCheckIdentity(check),
      check,
    ]),
  );
}

function hasNewCheckMatch(args: {
  previousSnapshot: PersistedPrSnapshotFileV1 | null;
  currentSnapshot: PersistedPrSnapshotFileV1;
  matches: (check: GitHubCheckSnapshot) => boolean;
}): boolean {
  const previousChecksByIdentity = buildCheckMap(args.previousSnapshot);

  for (const check of getSnapshotChecks(args.currentSnapshot)) {
    if (!args.matches(check)) {
      continue;
    }

    const previousCheck = previousChecksByIdentity.get(getCheckIdentity(check));
    if (!previousCheck || !args.matches(previousCheck)) {
      return true;
    }
  }

  return false;
}

function haveAllChecksPassed(
  snapshot: PersistedPrSnapshotFileV1 | null,
): boolean {
  const checks = getSnapshotChecks(snapshot);
  return checks.length > 0 && checks.every(isPassAllEligibleCheck);
}

function haveAllChecksFinished(
  snapshot: PersistedPrSnapshotFileV1 | null,
): boolean {
  const checks = getSnapshotChecks(snapshot);
  return checks.length > 0 && checks.every(isTerminalCheck);
}

function haveAllChecksFinishedWithFailures(
  snapshot: PersistedPrSnapshotFileV1 | null,
): boolean {
  const checks = getSnapshotChecks(snapshot);
  return (
    checks.length > 0 &&
    checks.every(isTerminalCheck) &&
    checks.some(isFailingCheck)
  );
}

function buildFinishedCheckSetSignature(
  snapshot: PersistedPrSnapshotFileV1 | null,
): string {
  const checks = getSnapshotChecks(snapshot)
    .map((check) => ({
      identity: getCheckIdentity(check),
      id: check.id,
      status: check.status,
      rawStatus: check.rawStatus,
      conclusion: check.conclusion,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    }))
    .sort((left, right) => {
      const identityComparison = left.identity.localeCompare(right.identity);
      if (identityComparison !== 0) {
        return identityComparison;
      }
      return String(left.id).localeCompare(String(right.id));
    });

  return JSON.stringify({
    headSha: snapshot?.checks?.headSha ?? null,
    checks,
  });
}

function hasNewFinishedCheckSet(args: {
  previousSnapshot: PersistedPrSnapshotFileV1 | null;
  currentSnapshot: PersistedPrSnapshotFileV1;
}): boolean {
  // A short rerun can start and finish between polls. Comparing completed
  // generations lets aggregate hooks observe that cycle without requiring an
  // intermediate queued/in-progress snapshot.
  if (!haveAllChecksFinished(args.currentSnapshot)) {
    return false;
  }
  if (!haveAllChecksFinished(args.previousSnapshot)) {
    return true;
  }

  return (
    buildFinishedCheckSetSignature(args.previousSnapshot) !==
    buildFinishedCheckSetSignature(args.currentSnapshot)
  );
}

function hasMergeConflicts(
  snapshot: PersistedPrSnapshotFileV1 | null,
): boolean {
  // GitHub can keep reporting a merged or closed PR as unmergeable/dirty.
  // State and mergeability come from the same pull request fetch, so only a
  // PR that can still be merged counts as conflicted.
  if (
    !snapshot ||
    (snapshot.pr.state !== 'open' && snapshot.pr.state !== 'draft') ||
    snapshot.pr.closedAt !== null ||
    snapshot.pr.mergedAt !== null
  ) {
    return false;
  }
  return snapshot.mergeConflicts?.hasConflicts === true;
}

function collectCheckAndConflictTriggers(args: {
  previousSnapshot: PersistedPrSnapshotFileV1 | null;
  currentSnapshot: PersistedPrSnapshotFileV1;
}): HookTriggerName[] {
  const triggers: HookTriggerName[] = [];
  const newFinishedCheckSet = hasNewFinishedCheckSet(args);

  if (
    hasNewCheckMatch({
      previousSnapshot: args.previousSnapshot,
      currentSnapshot: args.currentSnapshot,
      matches: isFailingCheck,
    })
  ) {
    triggers.push('pr:checks:fail');
  }

  if (
    hasNewCheckMatch({
      previousSnapshot: args.previousSnapshot,
      currentSnapshot: args.currentSnapshot,
      matches: isSuccessfulCheck,
    })
  ) {
    triggers.push('pr:checks:pass');
  }

  if (
    (!haveAllChecksPassed(args.previousSnapshot) || newFinishedCheckSet) &&
    haveAllChecksPassed(args.currentSnapshot)
  ) {
    triggers.push('pr:checks:pass:all');
  }

  if (newFinishedCheckSet) {
    triggers.push('pr:checks:finished');
  }

  if (
    newFinishedCheckSet &&
    haveAllChecksFinishedWithFailures(args.currentSnapshot)
  ) {
    triggers.push('pr:checks:finished:has-fail');
  }

  if (
    !hasMergeConflicts(args.previousSnapshot) &&
    hasMergeConflicts(args.currentSnapshot)
  ) {
    triggers.push('pr:merge-conflicts');
  }

  return triggers;
}

function getSnapshotCompleteness(snapshot: PersistedPrSnapshotFileV1 | null): {
  includesComments: boolean;
  includesReviews: boolean;
  includesReviewComments: boolean;
} {
  return {
    includesComments: snapshot?.includesComments ?? false,
    includesReviews: snapshot?.includesReviews ?? false,
    includesReviewComments: snapshot?.includesReviewComments ?? false,
  };
}

/**
 * GitHub recomputes mergeability in the background after the base branch
 * moves and reports `mergeable: null` / `mergeable_state: 'unknown'` until it
 * finishes. That is not evidence the conflicts were resolved.
 */
function isMergeabilityUnknown(
  mergeConflicts: GitHubMergeConflictSnapshot | undefined,
): boolean {
  return (
    !mergeConflicts ||
    (!mergeConflicts.hasConflicts &&
      mergeConflicts.mergeable === null &&
      (mergeConflicts.mergeableState === null ||
        mergeConflicts.mergeableState === 'unknown'))
  );
}

function normalizeSnapshotForStorage(
  previous: PersistedPrSnapshotFileV1 | null,
  current: PersistedPrSnapshotFileV1 | null,
): PersistedPrSnapshotFileV1 | null {
  if (
    !previous ||
    !current ||
    previous.pr.id !== current.pr.id ||
    previous.credentialScope !== current.credentialScope
  ) {
    return current;
  }

  // Keep the last known mergeability for an active PR so a recompute does not
  // read as a conflicts-resolved -> conflicts-detected transition. A reopened
  // PR must wait for fresh mergeability instead of inheriting its closed state.
  const previousWasActive =
    (previous.pr.state === 'open' || previous.pr.state === 'draft') &&
    previous.pr.closedAt === null &&
    previous.pr.mergedAt === null;
  const mergeConflicts =
    previousWasActive && isMergeabilityUnknown(current.mergeConflicts)
      ? (previous.mergeConflicts ?? current.mergeConflicts)
      : current.mergeConflicts;

  return {
    ...withMergeConflicts(current, mergeConflicts),
    includesComments:
      current.includesComments || !previous.includesComments
        ? current.includesComments
        : previous.includesComments,
    includesReviews:
      current.includesReviews || !previous.includesReviews
        ? current.includesReviews
        : previous.includesReviews,
    includesReviewComments:
      current.includesReviewComments || !previous.includesReviewComments
        ? current.includesReviewComments
        : previous.includesReviewComments,
    issueComments:
      current.includesComments || !previous.includesComments
        ? current.issueComments
        : previous.issueComments,
    reviews:
      current.includesReviews || !previous.includesReviews
        ? current.reviews
        : previous.reviews,
    reviewComments:
      current.includesReviewComments || !previous.includesReviewComments
        ? current.reviewComments
        : previous.reviewComments,
  };
}

async function readTrackingFiles(
  projectId: string,
  worktreeId: string,
  repoStorageKey: string,
): Promise<{
  state: PrTrackingStateFile | null;
  currentSnapshot: PersistedPrSnapshotFileV1 | null;
}> {
  const [state, currentSnapshot] = await Promise.all([
    readJsonFile(
      getStateFilePath(projectId, worktreeId, repoStorageKey),
      isTrackingStateFile,
    ),
    readSnapshotFile(
      getCurrentSnapshotFilePath(projectId, worktreeId, repoStorageKey),
    ),
  ]);

  return { state, currentSnapshot };
}

export async function readCurrentPrTrackingSnapshot(args: {
  projectId: string;
  worktreeId: string;
  repoStorageKey: string;
}): Promise<{
  snapshot: PersistedPrSnapshotFileV1 | null;
  currentSnapshotPath: string;
  previousSnapshotPath: string;
}> {
  const currentSnapshotPath = getCurrentSnapshotFilePath(
    args.projectId,
    args.worktreeId,
    args.repoStorageKey,
  );
  const previousSnapshotPath = getPreviousSnapshotFilePath(
    args.projectId,
    args.worktreeId,
    args.repoStorageKey,
  );

  return {
    snapshot: await readSnapshotFile(currentSnapshotPath),
    currentSnapshotPath,
    previousSnapshotPath,
  };
}

export async function deletePrTrackingState(args: {
  projectId: string;
  worktreeId: string;
  repoStorageKey: string;
}): Promise<void> {
  await rm(
    getGitHubPrStateDir(args.projectId, args.worktreeId, args.repoStorageKey),
    {
      recursive: true,
      force: true,
    },
  );
  invalidatePreviewLookups(null);
  rememberPreviewSnapshot(args, null);
}

export async function advancePrTrackingState(args: {
  projectId: string;
  worktreeId: string;
  repoStorageKey: string;
  branchName: string;
  currentSnapshot: PersistedPrSnapshotFileV1 | null;
  credentialScope?: string;
  worktreeCreatedAt?: string;
}): Promise<{
  triggers: HookTriggerName[];
  currentSnapshot: PersistedPrSnapshotFileV1 | null;
  currentSnapshotPath: string;
  previousSnapshotPath: string;
}> {
  const stateDir = getGitHubPrStateDir(
    args.projectId,
    args.worktreeId,
    args.repoStorageKey,
  );
  await mkdir(stateDir, { recursive: true });

  const statePath = getStateFilePath(
    args.projectId,
    args.worktreeId,
    args.repoStorageKey,
  );
  const currentPath = getCurrentSnapshotFilePath(
    args.projectId,
    args.worktreeId,
    args.repoStorageKey,
  );
  const previousPath = getPreviousSnapshotFilePath(
    args.projectId,
    args.worktreeId,
    args.repoStorageKey,
  );
  const existing = await readTrackingFiles(
    args.projectId,
    args.worktreeId,
    args.repoStorageKey,
  );

  const branchChanged =
    existing.state !== null && existing.state.branchName !== args.branchName;
  const storedCurrentSnapshot = existing.currentSnapshot;
  const observedCredentialScope = args.currentSnapshot
    ? args.currentSnapshot.credentialScope
    : args.credentialScope;
  const credentialScopeChanged =
    storedCurrentSnapshot !== null &&
    storedCurrentSnapshot.credentialScope !== observedCredentialScope;
  const normalizedSnapshot = normalizeSnapshotForStorage(
    storedCurrentSnapshot,
    args.currentSnapshot,
  );
  const queueSample = normalizedSnapshot
    ? interpretPrMergeQueueHookSample({
        previous:
          existing.state !== null &&
          !branchChanged &&
          !credentialScopeChanged &&
          storedCurrentSnapshot?.pr.id === normalizedSnapshot.pr.id
            ? storedCurrentSnapshot.mergeQueue
            : undefined,
        next: normalizedSnapshot.mergeQueue,
        prState: queuePrState(normalizedSnapshot.pr.state),
        observedAt: normalizedSnapshot.capturedAt,
        previousObservedAt: credentialScopeChanged
          ? normalizedSnapshot.capturedAt
          : (storedCurrentSnapshot?.capturedAt ??
            normalizedSnapshot.capturedAt),
      })
    : null;
  const nextCurrentSnapshot =
    normalizedSnapshot && queueSample
      ? withMergeQueue(normalizedSnapshot, queueSample.mergeQueue)
      : normalizedSnapshot;
  const storedSnapshotCompleteness =
    getSnapshotCompleteness(nextCurrentSnapshot);
  const shouldCatchUpMergedUsage =
    storedCurrentSnapshot === null &&
    nextCurrentSnapshot !== null &&
    shouldRecordMergedPrCatchUp({
      snapshot: nextCurrentSnapshot,
      worktreeCreatedAt: args.worktreeCreatedAt,
      now: Date.now(),
    });

  if (existing.state === null || branchChanged) {
    if (shouldCatchUpMergedUsage && nextCurrentSnapshot) {
      recordWorktreePrMergedUsageEvent({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        repoStorageKey: args.repoStorageKey,
        snapshot: nextCurrentSnapshot,
      });
    }
    await writeTrackingFiles({
      statePath,
      currentPath,
      previousPath,
      branchName: args.branchName,
      previousSnapshot: null,
      currentSnapshot: nextCurrentSnapshot,
      snapshotCompleteness: storedSnapshotCompleteness,
    });
    invalidatePreviewLookups(nextCurrentSnapshot);
    rememberPreviewSnapshot(args, nextCurrentSnapshot);
    return {
      triggers: [],
      currentSnapshot: nextCurrentSnapshot,
      currentSnapshotPath: currentPath,
      previousSnapshotPath: previousPath,
    };
  }

  const triggers: HookTriggerName[] = [];
  if (!storedCurrentSnapshot && nextCurrentSnapshot) {
    if (shouldCatchUpMergedUsage) {
      recordWorktreePrMergedUsageEvent({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        repoStorageKey: args.repoStorageKey,
        snapshot: nextCurrentSnapshot,
      });
    }
    if (
      nextCurrentSnapshot.pr.state === 'open' ||
      nextCurrentSnapshot.pr.state === 'draft'
    ) {
      triggers.push('pr:create');
    }
    triggers.push(
      ...collectCheckAndConflictTriggers({
        previousSnapshot: null,
        currentSnapshot: nextCurrentSnapshot,
      }),
    );
  } else if (storedCurrentSnapshot && nextCurrentSnapshot) {
    if (storedCurrentSnapshot.pr.id !== nextCurrentSnapshot.pr.id) {
      if (
        nextCurrentSnapshot.pr.state === 'open' ||
        nextCurrentSnapshot.pr.state === 'draft'
      ) {
        triggers.push('pr:create');
      }
      triggers.push(
        ...collectCheckAndConflictTriggers({
          previousSnapshot: null,
          currentSnapshot: nextCurrentSnapshot,
        }),
      );
    } else {
      if (!areRelevantLabelsEqual(storedCurrentSnapshot, nextCurrentSnapshot)) {
        triggers.push('pr:update:labels');
      }
      const resetCommentBaseline =
        credentialScopeChanged ||
        hasCommentBaselineReset({
          previousCompleteness: existing.state.snapshotCompleteness,
          currentSnapshot: nextCurrentSnapshot,
        });
      if (
        !resetCommentBaseline &&
        hasCommentDiff(storedCurrentSnapshot, nextCurrentSnapshot)
      ) {
        triggers.push('pr:update:comments');
      }
      const newSubmittedReviewIds = credentialScopeChanged
        ? []
        : getNewSubmittedReviewIds(storedCurrentSnapshot, nextCurrentSnapshot);
      if (newSubmittedReviewIds.length > 0) {
        triggers.push('pr:reviews:new');
      }
      if (
        hasNewReviewWithInlineComments({
          reviewIds: newSubmittedReviewIds,
          currentSnapshot: nextCurrentSnapshot,
        })
      ) {
        triggers.push('pr:reviews:new:has-comments');
      }
      triggers.push(
        ...collectCheckAndConflictTriggers({
          previousSnapshot: storedCurrentSnapshot,
          currentSnapshot: nextCurrentSnapshot,
        }),
        ...(queueSample?.triggers ?? []),
      );

      const previousState = storedCurrentSnapshot.pr.state;
      const currentState = nextCurrentSnapshot.pr.state;
      if (previousState !== 'merged' && currentState === 'merged') {
        triggers.push('pr:merged');
        recordWorktreePrMergedUsageEvent({
          projectId: args.projectId,
          worktreeId: args.worktreeId,
          repoStorageKey: args.repoStorageKey,
          snapshot: nextCurrentSnapshot,
        });
      } else if (
        previousState !== 'closed' &&
        previousState !== 'merged' &&
        currentState === 'closed'
      ) {
        triggers.push('pr:closed');
      }
    }
  }

  await writeTrackingFiles({
    statePath,
    currentPath,
    previousPath,
    branchName: args.branchName,
    previousSnapshot: credentialScopeChanged ? null : storedCurrentSnapshot,
    currentSnapshot: nextCurrentSnapshot,
    snapshotCompleteness: storedSnapshotCompleteness,
  });
  invalidatePreviewLookups(nextCurrentSnapshot);
  rememberPreviewSnapshot(args, nextCurrentSnapshot);

  return {
    triggers,
    currentSnapshot: nextCurrentSnapshot,
    currentSnapshotPath: currentPath,
    previousSnapshotPath: previousPath,
  };
}

function queuePrState(
  state: PersistedPrSnapshotFileV1['pr']['state'],
): 'open' | 'merged' | 'closed' {
  return state === 'draft' ? 'open' : state;
}

function shouldRecordMergedPrCatchUp(args: {
  snapshot: PersistedPrSnapshotFileV1;
  worktreeCreatedAt?: string;
  now: number;
}): boolean {
  if (args.snapshot.pr.state !== 'merged') {
    return false;
  }
  const createdAt = Date.parse(args.worktreeCreatedAt ?? '');
  const mergedAt = Date.parse(args.snapshot.pr.mergedAt ?? '');
  if (!Number.isFinite(createdAt) || !Number.isFinite(mergedAt)) {
    return false;
  }
  const age = args.now - mergedAt;
  return (
    mergedAt >= createdAt && age >= 0 && age <= MERGED_PR_CATCH_UP_WINDOW_MS
  );
}

function recordWorktreePrMergedUsageEvent(args: {
  projectId: string;
  worktreeId: string;
  repoStorageKey: string;
  snapshot: PersistedPrSnapshotFileV1;
}): void {
  const timestamp = new Date().toISOString();
  const repoScope = getUsageRepoScopeFromStorageKey(args);
  getObservabilityService().recordUsageMetricEvent({
    version: 1,
    id: `worktree-pr-merged:${args.projectId}/${args.worktreeId}:${repoScope.repoId}:${String(args.snapshot.pr.number)}`,
    type: 'worktree_pr_merged',
    timestamp,
    workspaceId: args.projectId,
    worktreeId: args.worktreeId,
    repoId: repoScope.repoId,
    repoLabel: repoScope.repoLabel,
    prNumber: args.snapshot.pr.number,
    prUrl: args.snapshot.pr.htmlUrl,
    mergedAt: args.snapshot.pr.mergedAt ?? timestamp,
    repos: [repoScope],
  });
}

async function writeTrackingFiles(args: {
  statePath: string;
  currentPath: string;
  previousPath: string;
  branchName: string;
  previousSnapshot: PersistedPrSnapshotFileV1 | null;
  currentSnapshot: PersistedPrSnapshotFileV1 | null;
  snapshotCompleteness: {
    includesComments: boolean;
    includesReviews: boolean;
    includesReviewComments: boolean;
  };
}): Promise<void> {
  const syncedAt = new Date().toISOString();
  const state: PrTrackingStateFile = {
    version: 1,
    branchName: args.branchName,
    syncedAt,
    currentPrId: args.currentSnapshot?.pr.id ?? null,
    snapshotCompleteness: args.snapshotCompleteness,
  };

  await Promise.all([
    writeFile(args.statePath, JSON.stringify(state, null, 2), 'utf8'),
    writeSnapshotFile(args.currentPath, args.currentSnapshot),
    writeSnapshotFile(args.previousPath, args.previousSnapshot),
  ]);
}
