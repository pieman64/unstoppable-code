import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
// Type-only: this module stays free of the commit log's node:sqlite runtime.
import type { W5Resource } from './commit-log';
import type {
  W5CaptureFile,
  W5CaptureResult,
  W5FileImage,
} from './capture-contract';
import { isRecord } from './is-record';

/*
 * W5a1 revision eligibility (CAN-5317): a read-only classification of one
 * capture. The log stores current counters and per-commit file fingerprints
 * but no per-commit resource-revision association, so a label is granted only
 * where the retained history itself establishes one:
 *
 * - every file the resource depends on was created from absence by a logged
 *   decision, and each later decision replaced exactly the image the one
 *   before it logged, so every content change was a logged write whose
 *   counter advances were computed from the canonical image;
 * - the captured bytes equal the last logged image, compared losslessly;
 * - no commit was ever abandoned and none is unresolved;
 * - a row label's ID occurs at most once in its captured image; and
 * - the counter has a row, and the caller's projection is complete.
 *
 * Anything else is `unverified`. A broken chain is never repaired by a later
 * write or fence: re-establishing provenance needs a separately specified
 * canonical transition.
 *
 * Relies on every logged write advancing each resource whose content it
 * changes, as the repositories' w5-revision-diff does. Revisit if a writer
 * declares advances any other way.
 */

export type W5FileUnverifiedReason =
  | 'not-captured'
  | 'unreadable'
  /** A commit was abandoned: its file rows are gone and its advances remain. */
  | 'abandoned-history'
  /** A committed or recovery-required decision on this path. */
  | 'pending'
  /** No logged decision: pre-log or foreign-created, or missing without deletion evidence. */
  | 'untracked'
  /** The first logged decision replaced an unlogged image. */
  | 'pre-log'
  /** A logged decision carried a foreign image forward, or a fingerprint is malformed. */
  | 'foreign-preimage'
  /** The captured bytes differ from the last logged image. */
  | 'diverged'
  | 'evidence-unavailable';

export type W5FileProvenance =
  | { readonly status: 'canonical'; readonly fingerprint: string | null }
  | { readonly status: 'unverified'; readonly reason: W5FileUnverifiedReason };

export type W5RevisionUnverifiedReason =
  | W5FileUnverifiedReason
  | 'projection-incomplete'
  /** The row's ID repeats: the revision diff compares only the last such row. */
  | 'duplicate-row'
  /** Revision 0 is the counter default, not an attestation of contents. */
  | 'no-revision';

export type W5RevisionEligibility =
  | { readonly status: 'eligible'; readonly revision: number }
  | {
      readonly status: 'unverified';
      readonly reason: W5RevisionUnverifiedReason;
    };

/**
 * Whether the projection behind a label derives only from the captured
 * images of its dependencies and omits nothing they hold: a filtered, paged
 * or fallback (for example backup) projection is `partial`.
 */
export type W5ProjectionCompleteness = 'complete' | 'partial';

function sameFile(a: W5CaptureFile, b: W5CaptureFile): boolean {
  if (a.kind !== b.kind) return false;
  if (!('workspaceId' in a)) return true;
  return 'workspaceId' in b && a.workspaceId === b.workspaceId;
}

/** Keys follow `w5ResourceKey` without importing the commit log at runtime. */
function resourceKey(resource: W5Resource): string {
  switch (resource.kind) {
    case 'workspaces':
      return 'workspaces';
    case 'workspace':
      return `workspace:${resource.workspaceId}`;
    case 'worktrees':
      return `worktrees:${resource.workspaceId}`;
    case 'worktree':
      return `worktree:${resource.workspaceId}/${resource.worktreeId}`;
  }
}

/** The files whose writes advance a resource (w5-revision-diff and its repositories). */
export function w5ResourceDependencies(
  resource: W5Resource,
): readonly W5CaptureFile[] {
  switch (resource.kind) {
    case 'workspaces':
      return [{ kind: 'index' }];
    case 'workspace':
      return [
        { kind: 'index' },
        { kind: 'manifest', workspaceId: resource.workspaceId },
      ];
    case 'worktrees':
    case 'worktree':
      return [{ kind: 'worktrees', workspaceId: resource.workspaceId }];
  }
}

// A projection classifies every row against one capture, so results for a
// frozen (host-delivered) capture or image are reused; others are recomputed.
const fileProvenanceMemo = new WeakMap<
  W5CaptureResult,
  Map<string, W5FileProvenance>
>();
const rowCountMemo = new WeakMap<
  W5FileImage,
  ReadonlyMap<string, number> | null
>();

/**
 * Whether a captured image is the canonical end of its path's retained
 * history. Fingerprints are compared over the captured bytes, so a foreign
 * invalid UTF-8 or BOM variant never matches the decoded text it resembles.
 */
export function classifyW5FileProvenance(
  capture: W5CaptureResult,
  file: W5CaptureFile,
): W5FileProvenance {
  if (!Object.isFrozen(capture)) return classifyUncached(capture, file);
  const memo =
    fileProvenanceMemo.get(capture) ?? new Map<string, W5FileProvenance>();
  fileProvenanceMemo.set(capture, memo);
  const key = resourceFileKey(file);
  const known = memo.get(key);
  if (known) return known;
  const provenance = Object.freeze(classifyUncached(capture, file));
  memo.set(key, provenance);
  return provenance;
}

function resourceFileKey(file: W5CaptureFile): string {
  return 'workspaceId' in file ? `${file.kind}:${file.workspaceId}` : file.kind;
}

function classifyUncached(
  capture: W5CaptureResult,
  file: W5CaptureFile,
): W5FileProvenance {
  const unverified = (reason: W5FileUnverifiedReason): W5FileProvenance => ({
    status: 'unverified',
    reason,
  });
  const image = capture.files.find((entry) => sameFile(entry, file));
  if (!image) return unverified('not-captured');
  const chain = capture.log.chains.find((entry) => sameFile(entry.file, file));
  if (!chain) return unverified('evidence-unavailable');
  if (image.state === 'unreadable') return unverified('unreadable');
  // Only abandonment deletes commits; its paths and file effects are unknown.
  if (capture.log.retainedCommits !== capture.log.commitId)
    return unverified('abandoned-history');
  const decisions = capture.log.files.filter((row) => sameFile(row.file, file));
  if (decisions.some((row) => row.state !== 'applied'))
    return unverified('pending');
  if (chain.decisions === 0) return unverified('untracked');
  const latest = decisions[decisions.length - 1];
  if (!latest) return unverified('evidence-unavailable');
  const fingerprint =
    image.state === 'present'
      ? createHash('sha256')
          .update(Buffer.from(image.base64, 'base64'))
          .digest('hex')
      : null;
  if (fingerprint !== latest.newFingerprint) return unverified('diverged');
  if (!chain.startsAbsent) return unverified('pre-log');
  if (chain.discontinuities > 0) return unverified('foreign-preimage');
  return { status: 'canonical', fingerprint };
}

function imageRows(
  image: W5FileImage | undefined,
  key: 'workspaces' | 'worktrees',
): readonly unknown[] | undefined {
  if (image?.state === 'absent') return [];
  if (image?.state !== 'present') return undefined;
  try {
    const document: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.from(image.base64, 'base64'),
      ),
    );
    if (!isRecord(document)) return undefined;
    const rows: unknown = document[key];
    return Array.isArray(rows) ? Array.from<unknown>(rows) : [];
  } catch {
    return undefined;
  }
}

/**
 * How often a row resource's ID occurs in its captured image (1 for a
 * non-row resource). Mirrors w5-revision-diff, which keys object rows by
 * string ID and keeps the last, so an earlier duplicate's content can change
 * without an advance.
 */
function rowOccurrences(
  capture: W5CaptureResult,
  resource: W5Resource,
): number | undefined {
  if (resource.kind !== 'workspace' && resource.kind !== 'worktree') return 1;
  const file: W5CaptureFile =
    resource.kind === 'workspace'
      ? { kind: 'index' }
      : { kind: 'worktrees', workspaceId: resource.workspaceId };
  const id =
    resource.kind === 'workspace' ? resource.workspaceId : resource.worktreeId;
  const image = capture.files.find((entry) => sameFile(entry, file));
  const counts = image
    ? rowIdCounts(
        image,
        resource.kind === 'workspace' ? 'workspaces' : 'worktrees',
      )
    : null;
  return counts ? (counts.get(id) ?? 0) : undefined;
}

/** String row IDs and their counts, or null when the image has no readable rows. */
function rowIdCounts(
  image: W5FileImage,
  key: 'workspaces' | 'worktrees',
): ReadonlyMap<string, number> | null {
  const frozen = Object.isFrozen(image);
  const known = frozen ? rowCountMemo.get(image) : undefined;
  if (known !== undefined) return known;
  const rows = imageRows(image, key);
  let counts: Map<string, number> | null = null;
  if (rows !== undefined) {
    counts = new Map();
    for (const row of rows)
      if (isRecord(row) && typeof row.id === 'string')
        counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
  }
  if (frozen) rowCountMemo.set(image, counts);
  return counts;
}

/**
 * Whether `resource` may carry its captured revision as a label. Internal
 * classification only: it makes no public revision claim and never reads
 * files, repairs or advances anything.
 */
export function classifyW5RevisionEligibility(
  capture: W5CaptureResult,
  resource: W5Resource,
  projection: W5ProjectionCompleteness,
): W5RevisionEligibility {
  // An unresolved commit's counter advances are durable before its images land.
  if (capture.log.unresolvedCommits > 0)
    return { status: 'unverified', reason: 'pending' };
  for (const file of w5ResourceDependencies(resource)) {
    const provenance = classifyW5FileProvenance(capture, file);
    if (provenance.status === 'unverified') return provenance;
  }
  if (projection !== 'complete')
    return { status: 'unverified', reason: 'projection-incomplete' };
  const rows = rowOccurrences(capture, resource);
  if (rows === undefined)
    return { status: 'unverified', reason: 'evidence-unavailable' };
  if (rows > 1) return { status: 'unverified', reason: 'duplicate-row' };
  const key = resourceKey(resource);
  const revision = Object.prototype.hasOwnProperty.call(
    capture.log.revisions,
    key,
  )
    ? capture.log.revisions[key]
    : undefined;
  return revision === undefined || revision < 1
    ? { status: 'unverified', reason: 'no-revision' }
    : { status: 'eligible', revision };
}
