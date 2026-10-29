import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import {
  DELEGATION_APPLY_FAILURE_LIMITS,
  type DelegationApplyFailure,
  type DelegationApplyFailureReason,
  type DelegationApplyIssue,
  type DelegationApplyIssueReason,
  type DelegationWorkspaceChange,
  type DelegationWorkspaceChanges,
  type ManagedDelegationWorktreeSummary,
} from '@canopy/protocol/delegation';
import {
  DELEGATION_APPLY_FILE_BOUND,
  DelegationApplyError,
  delegationContentVersion,
  type DelegationAppliedFile,
  type DelegationApplyJournal,
  type DelegationApplyJournalFile,
  type DelegationApplyLease,
  type DelegationWorkspaceHooks,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import {
  DELEGATION_FILE_MAX_BYTES,
  DelegationFileAccessError,
  type NativeDelegationFiles,
  validDelegationPath,
} from '@canopy/desktop-shared/node/delegation/file-access';
import { assertPrivateDirectoryAcl } from '@canopy/desktop-shared/node/delegation/private-storage';
import type { AgentSessionOptions } from '../types';
import { createApprovalSession } from '../../approvals/approval-service';
import { canonicalDelegationRoot, openDelegationFiles } from './file-process';
import {
  discardIsolatedDelegationWorktree,
  isolatedDelegationChanges,
  isolatedDelegationWorktreeStats,
  materializeIsolatedDelegationBases,
  type IsolatedDelegationBase,
} from './isolated-worktree';

/** Apply reads, compares and writes files up to this size. */
const FILE_BYTES = DELEGATION_FILE_MAX_BYTES;
/** File content one apply holds in memory at once: the parent, starting and
 * delegate copies of every planned write, and the copies its reports show. */
const APPLY_CONTENT_BYTES = 256 * 1024 * 1024;
/** Each file session reads every file at most a few times. */
const APPLY_FILE_LIMITS = {
  fileBytes: FILE_BYTES,
  totalBytes: 4 * APPLY_CONTENT_BYTES,
};
const DIFF_CONTEXT_LINES = 3;
const DIFF_LINE_CHARACTERS = 400;
/** A larger changed region is shown as one replaced block. */
const DIFF_LCS_CELLS = 250_000;
const MESSAGE_PATH_CHARACTERS = 120;

/** File content; null means the file does not exist. */
type Content = string | null;

type FileState =
  | { readonly kind: 'content'; readonly content: Content }
  | {
      readonly kind: 'blocked';
      readonly reason: Extract<
        DelegationApplyIssueReason,
        'too_large' | 'not_text' | 'not_regular_file'
      >;
    };

interface PlannedWrite {
  readonly path: string;
  /** The delegate's starting copy, for reports. */
  readonly base: Content;
  /** The parent's current content, which the write replaces. */
  readonly before: Content;
  /** The delegate's content. */
  readonly after: Content;
  readonly toolUseId: string;
}

interface IssueDraft {
  readonly path: string;
  readonly reason: DelegationApplyIssueReason;
  /** For a parent change: the delegate's starting copy and the parent's. */
  readonly diff?: { readonly base: Content; readonly parent: Content };
}

interface ApplyPlan {
  readonly writes: readonly PlannedWrite[];
  /** The delegate version of every file the parent holds from it once the
   * writes land: the record's receipts after this apply. */
  readonly receipts: readonly DelegationAppliedFile[];
  readonly issues: readonly IssueDraft[];
  /** Leases to retain if this apply fails. */
  readonly leases: readonly DelegationApplyLease[];
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? error.code
    : undefined;
}

function contentHash(content: Content): string {
  return delegationContentVersion(content);
}

function holds(state: FileState, content: Content): boolean {
  return state.kind === 'content' && state.content === content;
}

function leaseFor(
  file: string,
  parent: Content,
  delegate: Content,
): DelegationApplyLease {
  return {
    path: file,
    parent: contentHash(parent),
    delegate: contentHash(delegate),
  };
}

function mergeLeases(
  retained: readonly DelegationApplyLease[],
  added: readonly DelegationApplyLease[],
): DelegationApplyLease[] {
  const replaced = new Set(added.map((entry) => entry.path));
  return [...retained.filter((entry) => !replaced.has(entry.path)), ...added];
}

function parentIssue(
  file: string,
  base: Content,
  state: FileState,
): IssueDraft {
  return state.kind === 'blocked'
    ? { path: file, reason: state.reason }
    : {
        path: file,
        reason: 'parent_changed',
        diff: { base, parent: state.content },
      };
}

/** The boundary refuses without saying why; lstat only chooses the report. */
async function readState(
  files: NativeDelegationFiles,
  root: string,
  relative: string,
): Promise<FileState> {
  try {
    return { kind: 'content', content: await files.read(relative) };
  } catch (error) {
    if (error instanceof DelegationFileAccessError && error.kind === 'not_text')
      return { kind: 'blocked', reason: 'not_text' };
    if (
      !(error instanceof DelegationFileAccessError) ||
      error.kind !== 'refused'
    )
      throw error;
  }
  let info: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    info = await fs.lstat(path.join(root, ...relative.split('/')));
  } catch (error) {
    if (errorCode(error) === 'ENOENT')
      return { kind: 'content', content: null };
    if (errorCode(error) === 'ENOTDIR')
      return { kind: 'blocked', reason: 'not_regular_file' };
    throw error;
  }
  return info.isFile() && info.nlink === 1 && info.size > FILE_BYTES
    ? { kind: 'blocked', reason: 'too_large' }
    : { kind: 'blocked', reason: 'not_regular_file' };
}

/** UTF-8 text without NUL bytes, as the file boundary accepts it. */
function textState(bytes: Buffer): FileState {
  if (bytes.includes(0)) return { kind: 'blocked', reason: 'not_text' };
  try {
    return {
      kind: 'content',
      content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    };
  } catch {
    return { kind: 'blocked', reason: 'not_text' };
  }
}

/** UTF-8 bytes of the content an apply holds. */
function contentBytes(content: Content): number {
  return content === null ? 0 : Buffer.byteLength(content, 'utf8');
}

/** Tracks the file content an apply holds in memory at once. */
function contentBudget(limit: number): (...contents: Content[]) => boolean {
  let remaining = limit;
  return (...contents) => {
    const bytes = contents.reduce(
      (total, content) => total + contentBytes(content),
      0,
    );
    if (bytes > remaining) return false;
    remaining -= bytes;
    return true;
  };
}

/**
 * The delegate's starting copy of `file`, as checked out into
 * `<directory>/files`. The checkout is the host's own, but a starting
 * revision can hold links, so none is followed.
 */
async function readBase(
  directory: string,
  file: string,
  entry: IsolatedDelegationBase | undefined,
): Promise<FileState> {
  if (!entry) return { kind: 'content', content: null };
  if (entry.kind === 'other' || !validDelegationPath(file))
    return { kind: 'blocked', reason: 'not_regular_file' };
  if (!entry.checkedOut) return { kind: 'blocked', reason: 'too_large' };
  let current = path.join(directory, 'files');
  const parts = file.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let info: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
        return { kind: 'blocked', reason: 'not_regular_file' };
      throw error;
    }
    const last = index === parts.length - 1;
    if (last ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
      return { kind: 'blocked', reason: 'not_regular_file' };
    if (last && info.size > FILE_BYTES)
      return { kind: 'blocked', reason: 'too_large' };
  }
  return textState(await fs.readFile(current));
}

/** A private directory for one operation's starting copies. */
async function baseDirectory(directory: string): Promise<string> {
  const bases = path.join(directory, 'apply-bases', randomUUID());
  await fs.mkdir(bases, { recursive: true, mode: 0o700 });
  await assertPrivateDirectoryAcl(bases);
  return bases;
}

function splitLines(content: Content): string[] {
  if (!content) return [];
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface DiffLine {
  readonly kind: ' ' | '-' | '+';
  readonly line: string;
}

function lineDiff(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  const removed = before.slice(start, beforeEnd);
  const added = after.slice(start, afterEnd);
  const middle: DiffLine[] = [];
  if (removed.length * added.length <= DIFF_LCS_CELLS) {
    // common[r * width + c]: longest common subsequence of removed[r..], added[c..].
    const width = added.length + 1;
    const common = new Uint32Array((removed.length + 1) * width);
    for (let row = removed.length - 1; row >= 0; row -= 1)
      for (let column = added.length - 1; column >= 0; column -= 1)
        common[row * width + column] =
          removed[row] === added[column]
            ? common[(row + 1) * width + column + 1] + 1
            : Math.max(
                common[(row + 1) * width + column],
                common[row * width + column + 1],
              );
    let row = 0;
    let column = 0;
    while (row < removed.length || column < added.length) {
      if (
        row < removed.length &&
        column < added.length &&
        removed[row] === added[column]
      ) {
        middle.push({ kind: ' ', line: removed[row] });
        row += 1;
        column += 1;
      } else if (
        row < removed.length &&
        (column === added.length ||
          common[(row + 1) * width + column] >=
            common[row * width + column + 1])
      ) {
        middle.push({ kind: '-', line: removed[row] });
        row += 1;
      } else {
        middle.push({ kind: '+', line: added[column] });
        column += 1;
      }
    }
  } else {
    // A loop, not an argument spread: a large change exceeds the call's
    // argument limit.
    for (const line of removed) middle.push({ kind: '-', line });
    for (const line of added) middle.push({ kind: '+', line });
  }
  const unchanged = (line: string): DiffLine => ({ kind: ' ', line });
  return [
    ...before.slice(0, start).map(unchanged),
    ...middle,
    ...before.slice(beforeEnd).map(unchanged),
  ];
}

/** Unified diff from the delegate's starting copy to the parent's file, cut
 * at a line boundary to fit `budget` UTF-8 bytes. */
function parentDiff(
  file: string,
  base: Content,
  parent: Content,
  budget: number,
): { readonly diff?: string; readonly truncated: boolean } {
  return unifiedDiff(file, base, parent, budget, ['delegate', 'parent']);
}

/** Unified diff between two versions of a file, labelled by `sides`, cut at
 * a line boundary to fit `budget` UTF-8 bytes. */
function unifiedDiff(
  file: string,
  base: Content,
  parent: Content,
  budget: number,
  sides: readonly [string, string],
): { readonly diff?: string; readonly truncated: boolean } {
  const lines = lineDiff(splitLines(base), splitLines(parent));
  const output = [
    base === null ? '--- /dev/null' : `--- ${sides[0]}/${file}`,
    parent === null ? '+++ /dev/null' : `+++ ${sides[1]}/${file}`,
  ];
  const beforeNumbers: number[] = [];
  const afterNumbers: number[] = [];
  let beforeNumber = 1;
  let afterNumber = 1;
  for (const { kind } of lines) {
    beforeNumbers.push(beforeNumber);
    afterNumbers.push(afterNumber);
    if (kind !== '+') beforeNumber += 1;
    if (kind !== '-') afterNumber += 1;
  }
  const hunks: Array<[number, number]> = [];
  lines.forEach(({ kind }, index) => {
    if (kind === ' ') return;
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const end = Math.min(lines.length, index + DIFF_CONTEXT_LINES + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  });
  // Render line by line and stop at the budget, so a huge change never
  // builds its whole text.
  let diff = '';
  let used = 0;
  const append = (line: string): boolean => {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (used + bytes > budget) return false;
    diff += `${line}\n`;
    used += bytes;
    return true;
  };
  const cut = (): { readonly diff?: string; readonly truncated: boolean } =>
    diff ? { diff, truncated: true } : { truncated: true };
  for (const line of output) if (!append(line)) return cut();
  if (!hunks.length && !append('(Only the final line ending differs.)'))
    return cut();
  for (const [start, end] of hunks) {
    let beforeCount = 0;
    let afterCount = 0;
    for (let index = start; index < end; index += 1) {
      if (lines[index].kind !== '+') beforeCount += 1;
      if (lines[index].kind !== '-') afterCount += 1;
    }
    const beforeStart = beforeNumbers[start] - (beforeCount ? 0 : 1);
    const afterStart = afterNumbers[start] - (afterCount ? 0 : 1);
    if (
      !append(
        `@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`,
      )
    )
      return cut();
    for (let index = start; index < end; index += 1) {
      const { kind, line } = lines[index];
      if (
        !append(
          `${kind}${line.length > DIFF_LINE_CHARACTERS ? `${line.slice(0, DIFF_LINE_CHARACTERS)}…` : line}`,
        )
      )
        return cut();
    }
  }
  return { diff, truncated: false };
}

function describePath(file: string): string {
  return file.length > MESSAGE_PATH_CHARACTERS
    ? `…${file.slice(-(MESSAGE_PATH_CHARACTERS - 1))}`
    : file;
}

const ISSUE_PHRASES: Record<
  DelegationApplyIssueReason,
  (file: string) => string
> = {
  parent_changed: (file) => `${file} changed after the delegate copied it`,
  too_large: (file) => `${file} is larger than 32 MiB`,
  not_text: (file) => `${file} isn't a text file`,
  not_regular_file: (file) => `${file} isn't a regular file`,
  protected_path: (file) => `${file} is a protected file`,
  outside_write_grant: (file) =>
    `${file} is outside the delegate's write access`,
  unreconciled: (file) =>
    `the delegate's copy of ${file} doesn't match its recorded edit`,
  approval_denied: (file) => `the change to ${file} wasn't approved`,
  write_failed: (file) => `${file} couldn't be written`,
  not_restored: (file) => `${file} couldn't be restored`,
};

const BLOCKED_BY_FILE: readonly DelegationApplyIssueReason[] = [
  'too_large',
  'not_text',
  'not_regular_file',
  'protected_path',
  'unreconciled',
];

function guidanceFor(
  reason: DelegationApplyFailureReason,
  issues: readonly IssueDraft[],
): string {
  const present = new Set(issues.map((issue) => issue.reason));
  const parts = [
    `The delegate keeps its worktree and changes, and nothing in this checkout changed${present.has('not_restored') ? ' except files marked not_restored' : ''}.`,
  ];
  if (reason === 'unavailable')
    parts.push('Turn off plan mode, then apply again.');
  if (reason === 'cancelled' || reason === 'interrupted')
    parts.push('Apply again when you want these changes.');
  if (present.has('parent_changed'))
    parts.push(
      "For each parent_changed file, send the delegate its parentDiff in a Message Delegate follow_up and ask it to update its own copy to keep both changes, or to undo its edit if this checkout's version should win. When that run finishes, apply again. A reported file is replaced only while it still matches this report and after the delegate has edited it.",
    );
  if (present.has('outside_write_grant'))
    parts.push(
      'For outside_write_grant, grant the path with follow_up permissions or ask the delegate to undo that edit.',
    );
  if (BLOCKED_BY_FILE.some((blocked) => present.has(blocked)))
    parts.push(
      'For the other files listed, ask the delegate to undo its edit or change the file here yourself, then apply again.',
    );
  if (present.has('approval_denied'))
    parts.push('Apply again to ask for approval again.');
  if (present.has('write_failed'))
    parts.push('Apply again; check the file permissions if it keeps failing.');
  if (present.has('not_restored'))
    parts.push('Review files marked not_restored before applying again.');
  parts.push('Discard only if you no longer want any of these changes.');
  return parts
    .join(' ')
    .slice(0, DELEGATION_APPLY_FAILURE_LIMITS.guidanceCharacters);
}

/** Builds the bounded report. Diffs share one byte budget in issue order. */
function applyError(
  reason: DelegationApplyFailureReason,
  drafts: readonly IssueDraft[],
  options: {
    readonly leases?: readonly DelegationApplyLease[];
    /** Replaces the summary derived from the first issue. */
    readonly summary?: string;
    /** Replaces the whole message, when files may still hold written content. */
    readonly message?: string;
  } = {},
): DelegationApplyError {
  let diffBudget = DELEGATION_APPLY_FAILURE_LIMITS.totalDiffBytes;
  const issues = drafts
    .slice(0, DELEGATION_APPLY_FAILURE_LIMITS.issues)
    .map((draft): DelegationApplyIssue => {
      if (!draft.diff) return { path: draft.path, reason: draft.reason };
      const rendered = parentDiff(
        draft.path,
        draft.diff.base,
        draft.diff.parent,
        Math.min(DELEGATION_APPLY_FAILURE_LIMITS.diffBytes, diffBudget),
      );
      diffBudget -= rendered.diff
        ? Buffer.byteLength(rendered.diff, 'utf8')
        : 0;
      return {
        path: draft.path,
        reason: draft.reason,
        ...(rendered.diff ? { parentDiff: rendered.diff } : {}),
        ...(rendered.truncated ? { parentDiffTruncated: true } : {}),
      };
    });
  const failure: DelegationApplyFailure = {
    reason,
    issues,
    ...(drafts.length > issues.length
      ? { omittedIssues: drafts.length - issues.length }
      : {}),
    guidance: guidanceFor(reason, drafts),
  };
  const [first] = drafts;
  const others = drafts.length - 1;
  const summary =
    options.summary ??
    (first
      ? `${ISSUE_PHRASES[first.reason](describePath(first.path))}${others > 0 ? ` (and ${others} more ${others === 1 ? 'file' : 'files'})` : ''}`
      : 'the apply stopped');
  return new DelegationApplyError(
    options.message ?? `Nothing was applied: ${summary}.`,
    failure,
    options.leases,
  );
}

/** Where an apply's journal keeps the content it may restore. */
function journalStoreRoot(directory: string, delegationId: string): string {
  return path.join(directory, 'apply-journal', delegationId);
}

function blobId(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** Flushes a directory entry on platforms that support it. */
async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Writes each image once, durably, named by its sha256. */
async function writeJournalStore(
  store: string,
  images: readonly Content[],
): Promise<void> {
  await fs.mkdir(store, { recursive: true, mode: 0o700 });
  await assertPrivateDirectoryAcl(store);
  for (const content of Array.from(new Set(images))) {
    if (content === null) continue;
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(path.join(store, blobId(content)), 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      throw error;
    }
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  await syncDirectory(store);
  await syncDirectory(path.dirname(store));
}

/** A stored image, verified against its name. */
async function readJournalBlob(store: string, id: string): Promise<string> {
  const content = await fs.readFile(path.join(store, id), 'utf8');
  if (blobId(content) !== id)
    throw new Error('Delegated apply journal content changed.');
  return content;
}

/** Removes journal stores of this delegate that no journal refers to. */
async function removeJournalStores(
  root: string,
  keep: string | undefined,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const store = path.join(root, entry);
    if (store !== keep) await fs.rm(store, { recursive: true, force: true });
  }
}

/** Whether a journal update became durable. */
async function cleared(update: Promise<void>): Promise<boolean> {
  return update.then(
    () => true,
    () => false,
  );
}

/** Removes a store no durable journal refers to; the next apply retries. */
async function removeStore(store: string): Promise<void> {
  await fs.rm(store, { recursive: true, force: true }).catch(() => {
    // Removed by the next apply.
  });
}

/** One journaled file with both of its images in hand. */
interface JournalImage {
  readonly entry: DelegationApplyJournalFile;
  readonly before: Content;
  readonly after: Content;
}

/**
 * Resolves a journal's images. Earlier versions kept them inline. An entry
 * whose stored image cannot be read cannot be restored and stays journaled.
 */
async function resolveJournal(
  journal: Omit<DelegationApplyJournal, 'operationId'>,
  storeRoot: string | undefined,
): Promise<{
  readonly images: JournalImage[];
  readonly unreadable: DelegationApplyJournalFile[];
}> {
  const images: JournalImage[] = [];
  const unreadable: DelegationApplyJournalFile[] = [];
  const store =
    journal.store !== undefined &&
    storeRoot !== undefined &&
    path.dirname(journal.store) === storeRoot
      ? journal.store
      : undefined;
  for (const entry of journal.files) {
    if ('before' in entry) {
      images.push({ entry, before: entry.before, after: entry.after });
      continue;
    }
    try {
      if (!store) throw new Error('Delegated apply journal store is invalid.');
      images.push({
        entry,
        before:
          entry.beforeBlob === null
            ? null
            : await readJournalBlob(store, entry.beforeBlob),
        after:
          entry.afterBlob === null
            ? null
            : await readJournalBlob(store, entry.afterBlob),
      });
    } catch {
      unreadable.push(entry);
    }
  }
  return { images, unreadable };
}

interface RestoreResult {
  /** Paths left unrestored: newer edits and refused restores, in apply order. */
  readonly kept: string[];
  /** Entries whose restore write was refused. They stay journaled so a later
   * apply or restart can still restore them. */
  readonly refused: DelegationApplyJournalFile[];
}

/** Puts back the listed files, newest first. A file that no longer holds
 * what the apply wrote is someone else's newer edit and is left alone. */
async function restoreFiles(
  root: string,
  images: readonly JournalImage[],
): Promise<RestoreResult> {
  if (!images.length) return { kept: [], refused: [] };
  const files = await openDelegationFiles(
    root,
    new AbortController().signal,
    APPLY_FILE_LIMITS,
  );
  const kept: string[] = [];
  const refused: DelegationApplyJournalFile[] = [];
  try {
    for (const image of [...images].reverse()) {
      const file = image.entry.path;
      const state = await readState(files, root, file);
      if (holds(state, image.before)) continue;
      if (!holds(state, image.after)) {
        kept.push(file);
        continue;
      }
      try {
        await files.write(file, image.after, image.before);
      } catch (error) {
        if (
          !(error instanceof DelegationFileAccessError) ||
          error.kind !== 'refused'
        )
          throw error;
        kept.push(file);
        refused.push(image.entry);
      }
    }
  } finally {
    await files.close();
  }
  return { kept: kept.reverse(), refused: refused.reverse() };
}

/** Restores a journal's files. Entries it cannot restore stay journaled.
 * The journal's store stays until the record no longer refers to it: the
 * next apply or discard removes it once the cleared journal is durable. */
async function settleJournal(
  journal: Omit<DelegationApplyJournal, 'operationId'>,
  storeRoot: string | undefined,
): Promise<RestoreResult> {
  const { images, unreadable } = await resolveJournal(journal, storeRoot);
  const restored = await restoreFiles(journal.root, images);
  const pending = [...unreadable, ...restored.refused];
  return {
    kept: [...unreadable.map((entry) => entry.path), ...restored.kept],
    refused: pending,
  };
}

/** Restores the files an apply wrote before the previous host stopped. */
export async function rollbackInterruptedDelegationApply(
  journal: DelegationApplyJournal,
  options: { readonly directory: string; readonly delegationId: string },
): Promise<{
  message: string;
  failure: DelegationApplyFailure;
  pendingJournal?: DelegationApplyJournal;
}> {
  const { kept, refused } = await settleJournal(
    journal,
    journalStoreRoot(options.directory, options.delegationId),
  );
  const [first] = kept;
  const error = applyError(
    'interrupted',
    kept.map((file): IssueDraft => ({ path: file, reason: 'not_restored' })),
    {
      summary: first
        ? `the app stopped during the apply, and ${describePath(first)}${kept.length > 1 ? ` and ${kept.length - 1} more` : ''} kept newer changes`
        : 'the app stopped during the apply, and every file was restored',
    },
  );
  return {
    message: error.message,
    failure: error.failure,
    ...(refused.length
      ? { pendingJournal: { ...journal, files: refused } }
      : {}),
  };
}

/** An apply needs more memory than its budget allows. */
class ApplyTooLargeError extends Error {}

async function planApply(input: {
  record: StoredDelegation;
  /** Files Git lists as changed, and files an earlier apply wrote. */
  paths: readonly string[];
  bases: ReadonlyMap<string, IsolatedDelegationBase>;
  baseDirectory: string;
  files: NativeDelegationFiles;
  root: string;
  delegateFiles: NativeDelegationFiles;
  delegateRoot: string;
  granted: (relativePath: string) => boolean;
  /** Submodules whose recorded commit changed; never written. */
  submodules: ReadonlySet<string>;
}): Promise<ApplyPlan> {
  const writes: PlannedWrite[] = [];
  const issues: IssueDraft[] = [];
  const leases: DelegationApplyLease[] = [];
  const appliedBefore = new Map(
    (input.record.appliedFiles ?? []).map((file) => [file.path, file.delegate]),
  );
  const receipts = new Map(appliedBefore);
  const hold = contentBudget(APPLY_CONTENT_BYTES);
  for (const file of input.paths) {
    if (!validDelegationPath(file)) {
      issues.push({ path: file, reason: 'protected_path' });
      continue;
    }
    if (input.submodules.has(file)) {
      issues.push({ path: file, reason: 'not_regular_file' });
      continue;
    }
    const copy = await readState(input.delegateFiles, input.delegateRoot, file);
    if (copy.kind === 'blocked') {
      issues.push({ path: file, reason: copy.reason });
      continue;
    }
    const delegate = copy.content;
    const delegateHash = contentHash(delegate);
    const earlier = appliedBefore.get(file);
    // An earlier apply already wrote this version of the file.
    if (earlier === delegateHash) continue;
    const baseState = await readBase(
      input.baseDirectory,
      file,
      input.bases.get(file),
    );
    // The delegate's net effect on a file never applied is nothing.
    if (earlier === undefined && holds(baseState, delegate)) continue;
    if (!input.granted(file)) {
      issues.push({ path: file, reason: 'outside_write_grant' });
      continue;
    }
    if (baseState.kind === 'blocked') {
      issues.push({ path: file, reason: baseState.reason });
      continue;
    }
    const base = baseState.content;
    const state = await readState(input.files, input.root, file);
    if (state.kind === 'blocked') {
      issues.push({ path: file, reason: state.reason });
      continue;
    }
    // A file back at its starting copy needs no receipt: Git lists it again
    // if the delegate changes it.
    const receive = (): void => {
      if (delegate === base) receipts.delete(file);
      else receipts.set(file, delegateHash);
    };
    if (state.content === delegate) {
      receive();
      continue;
    }
    // The parent holds the delegate's starting copy, or the version an
    // earlier apply wrote, so the delegate's edits were made on top of it.
    const known =
      state.content === base || earlier === contentHash(state.content);
    // Or a failed apply reported this content and the delegate has since
    // edited its version in response.
    const leased = input.record.applyLeases?.find(
      (entry) =>
        entry.path === file &&
        entry.parent === contentHash(state.content) &&
        entry.delegate !== delegateHash,
    );
    if (!known && !leased) {
      // Over the budget, a report names the file without its diff.
      issues.push(
        hold(base, state.content)
          ? parentIssue(file, base, state)
          : { path: file, reason: 'parent_changed' },
      );
      leases.push(leaseFor(file, state.content, delegate));
      continue;
    }
    if (leased) leases.push(leased);
    if (!hold(base, state.content, delegate)) throw new ApplyTooLargeError();
    writes.push({
      path: file,
      base,
      before: state.content,
      after: delegate,
      toolUseId: `apply:${createHash('sha256').update(file).digest('hex').slice(0, 32)}`,
    });
    receive();
  }
  return {
    writes,
    receipts: Array.from(receipts, ([file, delegate]) => ({
      path: file,
      delegate,
    })),
    issues,
    leases,
  };
}

/** Whether two receipt sets record the same delegate versions. */
function sameReceipts(
  left: readonly DelegationAppliedFile[],
  right: readonly DelegationAppliedFile[],
): boolean {
  if (left.length !== right.length) return false;
  const versions = new Map(left.map((file) => [file.path, file.delegate]));
  return right.every((file) => versions.get(file.path) === file.delegate);
}

/**
 * Applies an isolated delegate's changes to the parent checkout, or discards
 * its worktree. The changes are what Git reports for the delegate's worktree
 * against its starting revision. An apply validates every file and obtains
 * every approval before its first write, journals the writes durably, and
 * restores every written file if a later write fails, so the parent ends
 * either fully applied or as it started. A failed apply throws
 * DelegationApplyError and never touches the delegate or its worktree.
 */
export async function manageIsolatedDelegationWorkspace(options: {
  record: StoredDelegation;
  operation: 'apply' | 'discard';
  directory: string;
  owner: () => AgentSessionOptions | undefined;
  getWindow: Parameters<typeof createApprovalSession>[0]['getWindow'];
  signal: AbortSignal;
  hooks: DelegationWorkspaceHooks;
}): Promise<void> {
  const { record, signal, hooks } = options;
  const owner = options.owner();
  const isolated = path.join(
    options.directory,
    'worktrees',
    record.state.delegationId,
  );
  const storeRoot = journalStoreRoot(
    options.directory,
    record.state.delegationId,
  );
  const executionCwd = record.executionCwd;
  if (
    !owner ||
    !executionCwd ||
    signal.aborted ||
    (await fs.realpath(isolated)) !== executionCwd
  )
    throw new Error('Isolated workspace ownership is unavailable');
  if (owner.planMode)
    throw options.operation === 'apply'
      ? applyError('unavailable', [], { summary: 'plan mode is on' })
      : new Error('Isolated workspace ownership is unavailable');
  // Settle a journal whose restoration failed before doing anything else.
  // Refused restores stay journaled, and an apply waits until they succeed.
  let pendingStore: string | undefined;
  if (record.applyJournal) {
    let refused: DelegationApplyJournalFile[] | undefined;
    try {
      ({ refused } = await settleJournal(record.applyJournal, storeRoot));
      await hooks.journal(
        refused.length
          ? {
              root: record.applyJournal.root,
              ...(record.applyJournal.store
                ? { store: record.applyJournal.store }
                : {}),
              files: refused,
            }
          : undefined,
      );
    } catch {
      refused = undefined;
    }
    if (!refused || refused.length) pendingStore = record.applyJournal.store;
    if (options.operation === 'apply' && (!refused || refused.length))
      throw applyError(
        'write_failed',
        (refused ?? []).map(
          (entry): IssueDraft => ({ path: entry.path, reason: 'not_restored' }),
        ),
        { summary: "files from an earlier apply couldn't be restored yet" },
      );
  }
  // Content no journal refers to: an apply that ended before removing it.
  await removeJournalStores(storeRoot, pendingStore).catch(() => undefined);
  const capturedSessionApprovalRules = JSON.stringify(
    owner.sessionApprovalRules ?? [],
  );
  const approval = createApprovalSession({
    sessionKey: `${record.parent.sessionKey}:delegation-workspace:${record.state.delegationId}`,
    projectId: record.parent.projectId,
    worktreeId: record.parent.worktreeId,
    chatId: record.parent.chatId,
    provider:
      record.parent.harnessId === 'codex'
        ? 'codex'
        : record.parent.harnessId === 'opencode'
          ? 'opencode'
          : record.parent.harnessId === 'copilot'
            ? 'copilot'
            : record.parent.harnessId === 'cursor'
              ? 'cursor'
              : 'claude',
    workspaceRoot: owner.cwd,
    mode: owner.approvalMode ?? 'auto',
    sessionRules: [...(owner.sessionApprovalRules ?? [])],
    getWindow: options.getWindow,
    onAwaitingUser: (): void => hooks.awaitingUser(),
  });
  const cancel = (): void => approval.invalidatePending?.();
  const approvalContextKey = (): string => {
    const mode = options.owner()?.approvalMode ?? 'auto';
    approval.setMode(mode);
    return JSON.stringify([mode, approval.policyContextKey?.() ?? null]);
  };
  const livePolicyAllows = (): boolean => {
    const current = options.owner();
    if (
      !current ||
      current.planMode ||
      JSON.stringify(current.sessionApprovalRules ?? []) !==
        capturedSessionApprovalRules
    )
      return false;
    approval.setMode(current.approvalMode ?? 'auto');
    return true;
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (options.operation === 'discard') {
      const approvedContextKey = approvalContextKey();
      await hooks.approvalPending(true);
      const allowed = await approval.check(
        { kind: 'file-write', path: isolated },
        {
          title: 'Discard isolated delegated changes',
          details: { kind: 'file-write', path: isolated },
          subagentId: record.state.delegationId,
        },
      );
      await hooks.approvalPending(false);
      if (
        allowed.decision !== 'allow' ||
        !livePolicyAllows() ||
        approvalContextKey() !== approvedContextKey ||
        signal.aborted
      )
        throw new Error('Discard was not authorized');
      if (signal.aborted) throw new Error('Discard was cancelled');
      await discardIsolatedDelegationWorktree(owner.cwd, isolated, signal);
      return;
    }
    const revision = record.isolationRevision;
    if (!revision)
      throw applyError('unavailable', [], {
        summary: "the delegate's starting revision is unknown",
      });
    const listed = await isolatedDelegationChanges(
      executionCwd,
      revision,
      signal,
    );
    // Files an earlier apply wrote stay in scope after the delegate reverts
    // them, so a later apply writes the revert back.
    const work = Array.from(
      new Set([
        ...listed.map((change) => change.path),
        ...(record.appliedFiles ?? []).map((file) => file.path),
      ]),
    ).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    if (!work.length) return;
    if (work.length > DELEGATION_APPLY_FILE_BOUND)
      throw applyError('unavailable', [], {
        summary: `the delegate changed more than ${DELEGATION_APPLY_FILE_BOUND.toLocaleString('en-US')} files`,
      });
    const tooLarge = (): DelegationApplyError =>
      applyError('unavailable', [], {
        summary: `the delegate's changes hold more than ${APPLY_CONTENT_BYTES / 1024 / 1024} MiB of file content`,
      });
    const writePaths = record.task.permissions?.writePaths ?? [];
    const granted = (relativePath: string): boolean =>
      writePaths.some(
        (scope) =>
          scope === '.' ||
          relativePath === scope ||
          relativePath.startsWith(`${scope}/`),
      );
    const writeAllowed = (relativePath: string): boolean =>
      !signal.aborted &&
      validDelegationPath(relativePath) &&
      granted(relativePath) &&
      livePolicyAllows();
    const cancelled = (
      drafts: readonly IssueDraft[] = [],
    ): DelegationApplyError =>
      applyError('cancelled', drafts, { summary: 'the apply was cancelled' });
    const root = await canonicalDelegationRoot(owner.cwd);
    const bases = await baseDirectory(options.directory);
    // File sessions outlive a cancelled command so its writes can be undone.
    let files: NativeDelegationFiles | undefined;
    let delegateFiles: NativeDelegationFiles | undefined;
    try {
      const baseEntries = await materializeIsolatedDelegationBases(
        executionCwd,
        revision,
        work,
        bases,
        signal,
        { fileBytes: FILE_BYTES, totalBytes: APPLY_CONTENT_BYTES },
      );
      // A file over the per-file limit is reported by name; past the total,
      // the apply as a whole is too large.
      for (const entry of Array.from(baseEntries.values()))
        if (
          entry.kind === 'file' &&
          !entry.checkedOut &&
          entry.size <= FILE_BYTES
        )
          throw tooLarge();
      files = await openDelegationFiles(
        root,
        new AbortController().signal,
        APPLY_FILE_LIMITS,
      );
      delegateFiles = await openDelegationFiles(
        executionCwd,
        new AbortController().signal,
        APPLY_FILE_LIMITS,
      );
      let plan: ApplyPlan;
      try {
        plan = await planApply({
          record,
          paths: work,
          bases: baseEntries,
          baseDirectory: bases,
          files,
          root,
          delegateFiles,
          delegateRoot: executionCwd,
          granted,
          submodules: new Set(
            listed.flatMap((change) => (change.submodule ? [change.path] : [])),
          ),
        });
      } catch (error) {
        if (error instanceof ApplyTooLargeError) throw tooLarge();
        throw error;
      }
      if (signal.aborted) throw cancelled();
      if (plan.issues.length)
        throw applyError('conflict', plan.issues, { leases: plan.leases });
      if (!plan.writes.length) {
        if (!sameReceipts(record.appliedFiles ?? [], plan.receipts))
          await hooks.applied(plan.receipts);
        return;
      }
      // Every write is approved under one policy context before any parent
      // file changes.
      const approvedContextKey = approvalContextKey();
      const denied = (file?: string): DelegationApplyError =>
        signal.aborted
          ? cancelled()
          : applyError(
              'approval_denied',
              file ? [{ path: file, reason: 'approval_denied' }] : [],
              {
                leases: plan.leases,
                ...(file
                  ? {}
                  : {
                      summary: 'the approval settings changed during the apply',
                    }),
              },
            );
      for (const write of plan.writes) {
        if (!writeAllowed(write.path)) throw denied(write.path);
        const target = path.join(owner.cwd, write.path);
        await hooks.approvalPending(true);
        let allowed: Awaited<ReturnType<typeof approval.check>>;
        try {
          allowed = await approval.check(
            { kind: 'file-write', path: target },
            {
              title: 'Edit delegated task file',
              details: { kind: 'file-write', path: target },
              toolUseId: write.toolUseId,
              subagentId: record.state.delegationId,
            },
          );
        } finally {
          await hooks.approvalPending(false);
        }
        if (
          allowed.decision !== 'allow' ||
          !writeAllowed(write.path) ||
          approvalContextKey() !== approvedContextKey
        )
          throw denied(write.path);
      }
      // Approval can take a while. Recheck every base before the first write.
      const moved: Array<{ write: PlannedWrite; state: FileState }> = [];
      for (const write of plan.writes) {
        const state = await readState(files, root, write.path);
        if (!holds(state, write.before)) moved.push({ write, state });
      }
      if (moved.length)
        throw applyError(
          'conflict',
          moved.map(({ write, state }) =>
            parentIssue(write.path, write.base, state),
          ),
          {
            leases: mergeLeases(
              plan.leases,
              moved.flatMap(({ write, state }) =>
                state.kind === 'content'
                  ? [leaseFor(write.path, state.content, write.after)]
                  : [],
              ),
            ),
          },
        );
      if (
        approvalContextKey() !== approvedContextKey ||
        !plan.writes.every(({ path: file }) => writeAllowed(file))
      )
        throw denied();
      const store = path.join(storeRoot, randomUUID());
      const images = plan.writes.map(
        ({ path: file, before, after }): JournalImage => ({
          entry: {
            path: file,
            beforeBlob: before === null ? null : blobId(before),
            afterBlob: after === null ? null : blobId(after),
          },
          before,
          after,
        }),
      );
      try {
        await writeJournalStore(
          store,
          plan.writes.flatMap(({ before, after }) => [before, after]),
        );
        await hooks.journal({
          root,
          store,
          files: images.map(({ entry }) => entry),
        });
      } catch {
        // The store goes only once no durable journal can refer to it.
        if (await cleared(hooks.journal(undefined))) await removeStore(store);
        throw applyError('write_failed', [], {
          leases: plan.leases,
          summary: "the apply couldn't be recorded safely",
        });
      }
      const written: JournalImage[] = [];
      let failed:
        | { issue: IssueDraft; lease?: DelegationApplyLease }
        | undefined;
      let stopped = false;
      let revoked = false;
      for (let index = 0; index < plan.writes.length; index += 1) {
        const write = plan.writes[index];
        if (signal.aborted) {
          stopped = true;
          break;
        }
        // Journaling awaited I/O: recheck the live policy before every write.
        if (
          !writeAllowed(write.path) ||
          approvalContextKey() !== approvedContextKey
        ) {
          revoked = true;
          break;
        }
        const image = images[index];
        try {
          await files.write(write.path, write.before, write.after);
          written.push(image);
        } catch {
          // A write that landed without its reply is restored like the rest.
          written.push(image);
          const state = await readState(files, root, write.path).catch(
            () => undefined,
          );
          failed =
            state && !holds(state, write.before) && !holds(state, write.after)
              ? {
                  issue: parentIssue(write.path, write.base, state),
                  ...(state.kind === 'content'
                    ? {
                        lease: leaseFor(write.path, state.content, write.after),
                      }
                    : {}),
                }
              : { issue: { path: write.path, reason: 'write_failed' } };
          break;
        }
      }
      if (!failed && !stopped && !revoked)
        try {
          await hooks.applied(plan.receipts);
          await removeStore(store);
          return;
        } catch {
          // Unrecorded writes are restored below, like a failed write.
        }
      let kept: string[];
      let restorePending: string | undefined;
      try {
        const restored = await restoreFiles(root, written);
        kept = restored.kept;
        // Refused restores stay journaled for the next apply or a restart.
        const journalCleared = await cleared(
          hooks.journal(
            restored.refused.length
              ? { root, store, files: restored.refused }
              : undefined,
          ),
        );
        if (journalCleared && !restored.refused.length)
          await removeStore(store);
        if (restored.refused.length) {
          const first = restored.refused[0]?.path ?? '';
          restorePending = `The apply stopped partway. ${describePath(first)}${restored.refused.length > 1 ? ` and ${restored.refused.length - 1} more` : ''} will be restored when you apply again or restart the app.`;
        }
      } catch {
        // The journal stays; the next apply or a restart restores these first.
        kept = written.map(({ entry }) => entry.path);
        restorePending = `The apply stopped partway. ${describePath(kept[0] ?? '')}${kept.length > 1 ? ` and ${kept.length - 1} more` : ''} will be restored when you apply again or restart the app.`;
      }
      const unrestored = kept.map(
        (file): IssueDraft => ({ path: file, reason: 'not_restored' }),
      );
      const message = restorePending ? { message: restorePending } : {};
      if (stopped)
        throw applyError('cancelled', unrestored, {
          summary: 'the apply was cancelled',
          ...message,
        });
      if (revoked)
        throw applyError('approval_denied', unrestored, {
          leases: plan.leases,
          summary: 'the approval settings changed during the apply',
          ...message,
        });
      if (!failed)
        throw applyError('write_failed', unrestored, {
          leases: plan.leases,
          summary: "the applied changes couldn't be recorded",
          ...message,
        });
      const { issue, lease } = failed;
      throw applyError(
        issue.reason === 'parent_changed' ? 'conflict' : 'write_failed',
        [issue, ...unrestored],
        {
          leases: lease ? mergeLeases(plan.leases, [lease]) : plan.leases,
          ...message,
        },
      );
    } finally {
      await files?.close();
      await delegateFiles?.close();
      await fs.rm(bases, { recursive: true, force: true }).catch(() => {
        // An abandoned copy is removed with the delegation's data.
      });
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    approval.dispose();
    await hooks.approvalPending(false);
  }
}

/** Changed files one listing shows, and the diff bytes it shows per file and
 * in total. Display bounds only; apply reads every change. */
const CHANGE_LIST_FILES = 200;
const CHANGE_DIFF_BYTES = 64 * 1024;
const CHANGE_LISTING_DIFF_BYTES = 512 * 1024;
/** Starting copies one listing checks out; files past it show no diff. */
const CHANGE_BASE_BYTES = 16 * 1024 * 1024;

function delegationApplyState(
  record: StoredDelegation,
): ManagedDelegationWorktreeSummary['applyState'] {
  if (record.workspaceDiscarded) return 'discarded';
  const commands = [
    ...(record.controls ?? []),
    ...(record.control ? [record.control] : []),
  ].filter(
    (command) =>
      command.operation === 'apply' || command.operation === 'discard',
  );
  const latest = commands[commands.length - 1];
  if (latest?.operation === 'discard' && latest.status === 'completed')
    return 'discarded';
  if (latest?.operation === 'apply' && latest.status === 'failed')
    return 'apply_failed';
  if (
    (latest?.operation === 'apply' && latest.status === 'completed') ||
    (record.appliedFiles?.length ?? 0) > 0 ||
    commands.some(
      (command) =>
        command.operation === 'apply' && command.status === 'completed',
    )
  )
    return 'applied';
  return 'not_applied';
}

function emptyWorktreeSummary(
  delegationId: string,
  revision: string,
  checkout: 'discarded' | 'missing',
  applyState: ManagedDelegationWorktreeSummary['applyState'],
): ManagedDelegationWorktreeSummary {
  return {
    delegationId,
    checkout,
    startingRevision: revision,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    commitsAhead: 0,
    untrackedFiles: 0,
    applyState,
    topFiles: [],
    truncated: false,
  };
}

/**
 * Reads bounded, content-free summary statistics from a retained isolated
 * delegate checkout. The revision must still be the one stored for that
 * delegation; only relative worktree paths are projected to the caller.
 */
export async function readIsolatedDelegationWorktreeSummary(options: {
  directory: string;
  delegationId: string;
  revision: string;
  record: StoredDelegation;
  signal: AbortSignal;
}): Promise<ManagedDelegationWorktreeSummary> {
  const { directory, delegationId, revision, record, signal } = options;
  const applyState = delegationApplyState(record);
  if (
    !delegationId ||
    delegationId.includes('/') ||
    delegationId.includes('\\') ||
    !validDelegationPath(delegationId) ||
    record.state.delegationId !== delegationId ||
    record.isolationRevision !== revision ||
    !/^[a-f0-9]{40,64}$/.test(revision)
  )
    throw new Error("The revision isn't this delegate's starting revision.");
  if (signal.aborted)
    throw new Error('Isolated workspace summary could not be read.');
  if (applyState === 'discarded')
    return emptyWorktreeSummary(
      delegationId,
      revision,
      'discarded',
      applyState,
    );

  const isolated = path.join(directory, 'worktrees', delegationId);
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(isolated);
  } catch (error) {
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
      return emptyWorktreeSummary(
        delegationId,
        revision,
        'missing',
        applyState,
      );
    throw new Error('Isolated workspace summary could not be read.');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Isolated workspace summary could not be read.');

  try {
    const cwd = await canonicalDelegationRoot(isolated);
    const stats = await isolatedDelegationWorktreeStats(cwd, revision, signal);
    return {
      delegationId,
      checkout: 'retained',
      startingRevision: revision,
      ...(stats.startingSubject
        ? { startingSubject: stats.startingSubject }
        : {}),
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
      commitsAhead: stats.commitsAhead,
      untrackedFiles: stats.untrackedFiles,
      applyState,
      topFiles: [...stats.topFiles],
      truncated: stats.truncated,
    };
  } catch {
    throw new Error('Isolated workspace summary could not be read.');
  }
}

/**
 * An isolated delegate's changes, read from its retained worktree for
 * display: the same files an apply would consider, each with a bounded diff
 * from its starting copy. Files are read one at a time, through the confined
 * boundary, and only until the display budget is spent: a protected or linked
 * path, and any file past the budget, is listed without its content.
 */
export async function readIsolatedDelegationChanges(options: {
  directory: string;
  delegationId: string;
  revision: string;
  signal: AbortSignal;
}): Promise<DelegationWorkspaceChanges> {
  const cwd = await canonicalDelegationRoot(
    path.join(options.directory, 'worktrees', options.delegationId),
  );
  const listed = await isolatedDelegationChanges(
    cwd,
    options.revision,
    options.signal,
  );
  const shownChanges = listed.slice(0, CHANGE_LIST_FILES);
  const shown = shownChanges.map(({ path: file }) => file);
  const submodules = new Map<string, DelegationWorkspaceChange['change']>();
  for (const change of shownChanges)
    if (change.submodule) submodules.set(change.path, change.submodule);
  const bases = await baseDirectory(options.directory);
  let files: NativeDelegationFiles | undefined;
  const result: DelegationWorkspaceChange[] = [];
  let budget = CHANGE_LISTING_DIFF_BYTES;
  // Delegate copies one listing reads; files past it show no diff.
  let copyBudget = CHANGE_BASE_BYTES;
  try {
    const baseEntries = await materializeIsolatedDelegationBases(
      cwd,
      options.revision,
      shown,
      bases,
      options.signal,
      { fileBytes: FILE_BYTES, totalBytes: CHANGE_BASE_BYTES },
    );
    files = await openDelegationFiles(cwd, options.signal, APPLY_FILE_LIMITS);
    for (const file of shown) {
      // A submodule's commit lives in another repository: list it, no diff.
      const submodule = submodules.get(file);
      if (submodule) {
        result.push({ path: file, change: submodule });
        continue;
      }
      const added = !baseEntries.has(file);
      const candidate: unknown = file;
      // The delegate's copy is read only for a diff that can still be
      // shown; any other file is listed from its status alone.
      const stat = await fs
        .lstat(path.join(cwd, ...file.split('/')))
        .catch(() => undefined);
      const base =
        validDelegationPath(candidate) && budget > 0
          ? await readBase(bases, file, baseEntries.get(file))
          : undefined;
      const size = stat?.isFile() ? stat.size : 0;
      if (
        !base ||
        base.kind === 'blocked' ||
        size > FILE_BYTES ||
        size > copyBudget
      ) {
        result.push({
          path: file,
          change: !stat ? 'deleted' : added ? 'added' : 'modified',
        });
        continue;
      }
      const copy = await readState(files, cwd, file);
      if (copy.kind === 'content' && copy.content !== null)
        copyBudget -= Buffer.byteLength(copy.content, 'utf8');
      const change = holds(copy, null)
        ? 'deleted'
        : added
          ? 'added'
          : 'modified';
      if (copy.kind === 'blocked') {
        result.push({ path: file, change });
        continue;
      }
      const limit = Math.min(CHANGE_DIFF_BYTES, budget);
      const rendered = unifiedDiff(file, base.content, copy.content, limit, [
        'a',
        'b',
      ]);
      budget -= rendered.diff ? Buffer.byteLength(rendered.diff, 'utf8') : 0;
      // Only the listing's total, not one file's own cap, ends later diffs.
      if (rendered.truncated && limit < CHANGE_DIFF_BYTES) budget = 0;
      result.push({
        path: file,
        change,
        ...(rendered.diff ? { diff: rendered.diff } : {}),
        ...(rendered.truncated ? { diffTruncated: true } : {}),
      });
    }
  } finally {
    await files?.close();
    await fs.rm(bases, { recursive: true, force: true }).catch(() => {
      // An abandoned copy is removed with the delegation's data.
    });
  }
  return {
    files: result,
    ...(listed.length > shown.length
      ? { omittedFiles: listed.length - shown.length }
      : {}),
  };
}
