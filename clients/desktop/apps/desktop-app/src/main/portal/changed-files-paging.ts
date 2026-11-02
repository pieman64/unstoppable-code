import { createHash } from 'node:crypto';
import type {
  PortalChangedFile,
  PortalChangedFilesGroup,
  PortalChangedFilesPageResult,
  PortalChangedFilesPayload,
} from '@canopy/protocol/portal';

export const DEFAULT_CHANGED_FILES_PAGE_SIZE = 2_000;
export const MAX_CHANGED_FILES_PAGE_SIZE = 5_000;

export interface ChangedFilesCursor {
  revision: string;
  group: PortalChangedFilesGroup;
  offset: number;
}

export type ChangedFilesCursorDecodeResult =
  | ({ ok: true } & ChangedFilesCursor)
  | { ok: false; error: 'stale_cursor' | 'invalid_cursor' };

export interface SortedChangedFiles {
  uncommitted: PortalChangedFile[];
  committed: PortalChangedFile[];
}

export interface ChangedFilesPageRequest {
  workspaceLocalId: string;
  worktreeLocalId: string;
  group: PortalChangedFilesGroup;
  cursor: string;
  limit?: number;
}

interface CursorPayload extends ChangedFilesCursor {
  v: 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isChangedFilesGroup(value: unknown): value is PortalChangedFilesGroup {
  return value === 'uncommitted' || value === 'committed';
}

function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = Array.from(
    left,
    (character) => character.codePointAt(0) ?? -1,
  );
  const rightPoints = Array.from(
    right,
    (character) => character.codePointAt(0) ?? -1,
  );
  const sharedLength = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftPoint = leftPoints[index];
    const rightPoint = rightPoints[index];
    if (
      leftPoint !== undefined &&
      rightPoint !== undefined &&
      leftPoint !== rightPoint
    ) {
      return leftPoint - rightPoint;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function compareChangedFiles(
  left: PortalChangedFile,
  right: PortalChangedFile,
): number {
  const repoOrder = compareCodePointStrings(
    left.repoId ?? '',
    right.repoId ?? '',
  );
  return repoOrder !== 0
    ? repoOrder
    : compareCodePointStrings(left.filePath, right.filePath);
}

export function sortChangedFiles(
  files: PortalChangedFile[],
): PortalChangedFile[] {
  return files.slice().sort(compareChangedFiles);
}

function groupsOf(
  files: SortedChangedFiles | PortalChangedFilesPayload,
): SortedChangedFiles {
  return {
    uncommitted: sortChangedFiles(files.uncommitted),
    committed: sortChangedFiles(files.committed),
  };
}

export function getChangedFilesRevision(
  files: SortedChangedFiles | PortalChangedFilesPayload,
): string {
  const groups = groupsOf(files);
  const identity = {
    uncommitted: groups.uncommitted.map((file) => [
      file.repoId ?? '',
      file.filePath,
      file.status,
    ]),
    committed: groups.committed.map((file) => [
      file.repoId ?? '',
      file.filePath,
      file.status,
    ]),
  };
  return createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 16);
}

export function encodeChangedFilesCursor(cursor: ChangedFilesCursor): string {
  const value: CursorPayload = { v: 1, ...cursor };
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function parseChangedFilesCursor(cursor: string): ChangedFilesCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const decoded = Buffer.from(cursor, 'base64url');
  if (decoded.toString('base64url') !== cursor) return null;

  let value: unknown;
  try {
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort(compareCodePointStrings);
  if (
    keys.length !== 4 ||
    keys[0] !== 'group' ||
    keys[1] !== 'offset' ||
    keys[2] !== 'revision' ||
    keys[3] !== 'v' ||
    value.v !== 1 ||
    !isChangedFilesGroup(value.group) ||
    typeof value.revision !== 'string' ||
    value.revision.length === 0 ||
    typeof value.offset !== 'number' ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0
  ) {
    return null;
  }
  return {
    revision: value.revision,
    group: value.group,
    offset: value.offset,
  };
}

export function decodeChangedFilesCursor(
  cursor: string,
  expectedGroup: PortalChangedFilesGroup,
  currentRevision: string,
  total: number,
): ChangedFilesCursorDecodeResult {
  const parsed = parseChangedFilesCursor(cursor);
  if (!parsed || parsed.group !== expectedGroup) {
    return { ok: false, error: 'invalid_cursor' };
  }
  if (parsed.revision !== currentRevision) {
    return { ok: false, error: 'stale_cursor' };
  }
  if (parsed.offset > total) {
    return { ok: false, error: 'invalid_cursor' };
  }
  return { ok: true, ...parsed };
}

function pageForGroup(
  total: number,
  offset: number,
  revision: string,
  group: PortalChangedFilesGroup,
): { total: number; nextCursor?: string } {
  return {
    total,
    ...(offset < total
      ? { nextCursor: encodeChangedFilesCursor({ revision, group, offset }) }
      : {}),
  };
}

function cappedPayload(
  payload: PortalChangedFilesPayload,
  groups: SortedChangedFiles,
  retainedUncommitted: number,
  retainedCommitted: number,
  revision: string,
): PortalChangedFilesPayload {
  const existingNotices = payload.notices?.filter(
    (notice) => notice.kind !== 'truncated',
  );
  return {
    ...payload,
    uncommitted: groups.uncommitted.slice(0, retainedUncommitted),
    committed: groups.committed.slice(0, retainedCommitted),
    notices: [...(existingNotices ?? []), { kind: 'truncated' }],
    page: {
      revision,
      uncommitted: pageForGroup(
        groups.uncommitted.length,
        retainedUncommitted,
        revision,
        'uncommitted',
      ),
      committed: pageForGroup(
        groups.committed.length,
        retainedCommitted,
        revision,
        'committed',
      ),
    },
  };
}

export function capChangedFilesPayload(
  payload: PortalChangedFilesPayload,
  measure: (candidate: PortalChangedFilesPayload) => number,
  budget: number,
): PortalChangedFilesPayload {
  if (measure(payload) <= budget) return payload;

  const groups = groupsOf(payload);
  const revision = getChangedFilesRevision(groups);
  const uncommittedTotal = groups.uncommitted.length;
  const committedTotal = groups.committed.length;
  const fits = (uncommitted: number, committed: number): boolean =>
    measure(cappedPayload(payload, groups, uncommitted, committed, revision)) <=
    budget;
  // The first `rows` entries of the round-robin order, uncommitted first,
  // continuing with whichever group still has rows.
  const roundRobin = (rows: number): [number, number] => {
    const shared = Math.min(uncommittedTotal, committedTotal);
    if (rows <= shared * 2) return [Math.ceil(rows / 2), Math.floor(rows / 2)];
    return uncommittedTotal > committedTotal
      ? [rows - committedTotal, committedTotal]
      : [uncommittedTotal, rows - uncommittedTotal];
  };
  // Each measure serializes up to a full event, so search instead of growing
  // one row at a time. Size grows with rows except where a finished group
  // drops its cursor; the search only ever keeps measured, fitting prefixes.
  const largestFitting = (
    max: number,
    fitsAt: (count: number) => boolean,
  ): number => {
    let low = 0;
    let high = max;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fitsAt(middle)) low = middle;
      else high = middle - 1;
    }
    return low;
  };

  const rows = largestFitting(uncommittedTotal + committedTotal, (count) =>
    fits(...roundRobin(count)),
  );
  let [retainedUncommitted, retainedCommitted] = roundRobin(rows);
  if (rows < uncommittedTotal + committedTotal) {
    // The group due the next row is blocked; the other one keeps paging.
    const [nextUncommitted] = roundRobin(rows + 1);
    if (nextUncommitted > retainedUncommitted) {
      const base = retainedCommitted;
      retainedCommitted += largestFitting(committedTotal - base, (extra) =>
        fits(retainedUncommitted, base + extra),
      );
    } else {
      const base = retainedUncommitted;
      retainedUncommitted += largestFitting(uncommittedTotal - base, (extra) =>
        fits(base + extra, retainedCommitted),
      );
    }
  }
  return cappedPayload(
    payload,
    groups,
    retainedUncommitted,
    retainedCommitted,
    revision,
  );
}

function pageResult(
  request: ChangedFilesPageRequest,
  group: PortalChangedFilesGroup,
  revision: string,
  files: PortalChangedFile[],
  total: number,
  nextOffset: number,
): PortalChangedFilesPageResult {
  return {
    changedFilesPage: {
      workspaceLocalId: request.workspaceLocalId,
      worktreeLocalId: request.worktreeLocalId,
      group,
      revision,
      files,
      total,
      ...(nextOffset < total
        ? {
            nextCursor: encodeChangedFilesCursor({
              revision,
              group,
              offset: nextOffset,
            }),
          }
        : {}),
    },
  };
}

function errorResult(
  request: ChangedFilesPageRequest,
  group: PortalChangedFilesGroup,
  error: 'stale_cursor' | 'invalid_cursor',
): PortalChangedFilesPageResult {
  return {
    changedFilesPage: {
      workspaceLocalId: request.workspaceLocalId,
      worktreeLocalId: request.worktreeLocalId,
      group,
      cursor: request.cursor,
      error,
    },
  };
}

export function pageChangedFiles(
  fullSorted: SortedChangedFiles,
  request: ChangedFilesPageRequest,
  fitsBudget: (candidate: PortalChangedFilesPageResult) => boolean,
): PortalChangedFilesPageResult {
  const groups = groupsOf(fullSorted);
  const group = request.group;
  const files = groups[group];
  const revision = getChangedFilesRevision(groups);
  const decoded = decodeChangedFilesCursor(
    request.cursor,
    group,
    revision,
    files.length,
  );
  if (!decoded.ok) return errorResult(request, group, decoded.error);

  const requestedLimit = request.limit ?? DEFAULT_CHANGED_FILES_PAGE_SIZE;
  if (
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > MAX_CHANGED_FILES_PAGE_SIZE
  ) {
    return errorResult(request, group, 'invalid_cursor');
  }

  const remaining = files.length - decoded.offset;
  const maxCount = Math.min(requestedLimit, remaining);
  if (maxCount === 0) {
    return pageResult(
      request,
      group,
      revision,
      [],
      files.length,
      decoded.offset,
    );
  }

  // While rows remain after the page, every candidate has the same cursor
  // envelope and its serialized size is monotone as rows are appended. The
  // only possible cursor-size drop is the terminal candidate, so test that
  // candidate separately after the cursor-bearing prefix.
  const hasTerminalCandidate = maxCount === remaining;
  const monotoneMaxCount = hasTerminalCandidate ? maxCount - 1 : maxCount;
  let low = 0;
  let high = monotoneMaxCount;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = pageResult(
      request,
      group,
      revision,
      files.slice(decoded.offset, decoded.offset + middle),
      files.length,
      decoded.offset + middle,
    );
    if (fitsBudget(candidate)) low = middle;
    else high = middle - 1;
  }

  let fittingCount = low;
  if (hasTerminalCandidate && fittingCount === monotoneMaxCount) {
    const terminal = pageResult(
      request,
      group,
      revision,
      files.slice(decoded.offset, decoded.offset + maxCount),
      files.length,
      decoded.offset + maxCount,
    );
    if (fitsBudget(terminal)) fittingCount = maxCount;
  }
  if (fittingCount === 0) return errorResult(request, group, 'invalid_cursor');

  return pageResult(
    request,
    group,
    revision,
    files.slice(decoded.offset, decoded.offset + fittingCount),
    files.length,
    decoded.offset + fittingCount,
  );
}
