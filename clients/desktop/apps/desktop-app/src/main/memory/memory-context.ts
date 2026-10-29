import type { UsageInitiationSource } from '@canopy/desktop-shared/types';
import { isDefaultWorktreeBranchName } from '@canopy/desktop-shared/lib/default-worktree-branch';
import { CLIENT_FETCH_TIMEOUT_MS } from './memory-client';

export function isTrivialMemoryInput(userText: string): boolean {
  const trimmed = userText.trim();
  return trimmed.length < 20 || trimmed.startsWith('/');
}

/**
 * Text that reaches dispatch as a chat message but was not typed by a human
 * with retrieval intent: pipeline/builtin action invocations and watcher
 * notification follow-ups. These queries retrieve facts that are topically
 * on-target to the reranker (a `$builtin-gh:handle-pr-comments` invocation
 * matches facts about that very workflow), so no score threshold can silence
 * them — they must be excluded before retrieval runs. Calibration against
 * staging search logs measured 42% of all memory searches firing on this
 * traffic. String matching is the fallback for persisted transcript text;
 * live dispatches also carry the structural signals consumed by
 * `shouldFetchMemory` (watcher hiddenContext kind, initiation source).
 */
export function isMachineGeneratedMemoryText(userText: string): boolean {
  const trimmed = userText.trim();
  if (/^\$builtin-[a-z0-9-]+:[a-z0-9-]+\b/i.test(trimmed)) return true;
  return (
    /^[^\r\n]+ watcher (fired|deleted)\.\r?\n[^\r\n]+$/i.test(trimmed) ||
    /^GitHub workflow watcher update: (?:a job completed with [^\r\n.]+|a workflow run [^\r\n]+|\d+ changes observed; \d+ of \d+ runs remain active)\.$/i.test(
      trimmed,
    )
  );
}

export function shouldFetchMemory(options: {
  userText: string;
  memoryInjectionEnabled: boolean;
  capabilityPresent: boolean;
  /** Kind of out-of-band hidden context attached to the dispatch, if any. */
  hiddenContextKind?: string;
  /** What initiated the turn; automation/hook turns carry no human query. */
  initiationSource?: UsageInitiationSource;
}): boolean {
  return (
    options.memoryInjectionEnabled &&
    options.capabilityPresent &&
    options.hiddenContextKind !== 'canopy-watcher-event' &&
    options.hiddenContextKind !== 'agent-sender-context' &&
    options.initiationSource !== 'automation' &&
    options.initiationSource !== 'hook' &&
    !isTrivialMemoryInput(options.userText) &&
    !isMachineGeneratedMemoryText(options.userText)
  );
}

/** Server-side request validation rejects queries longer than this. */
export const MEMORY_QUERY_MAX_CHARS = 2_000;
export const MEMORY_CONTEXT_MAX_RECENT_MESSAGES = 3;
const CONTEXT_MESSAGE_EXCERPT_CHARS = 200;
const CONTEXT_SUMMARY_EXCERPT_CHARS = 240;

export interface MemoryQueryContext {
  /** Prior visible user messages, oldest first, excluding the current one. */
  recentUserMessages: string[];
  /** Chat or worktree summary description, when one has been generated. */
  summaryDescription: string | null;
}

/**
 * Keep generated worktree placeholders out of semantic retrieval queries.
 * A branch becomes useful context only after it differs from the app-generated
 * worktree-id branch (including the legacy and timestamped placeholder forms).
 */
export function getMemoryQueryBranchName(
  worktreeId: string,
  branchName: string | null | undefined,
): string | undefined {
  const normalized = branchName?.trim();
  if (!normalized || isDefaultWorktreeBranchName(normalized, worktreeId)) {
    return undefined;
  }
  return normalized;
}

function contextExcerpt(text: string, maxChars: number): string {
  return text.trim().replace(/\s+/g, ' ').slice(0, maxChars);
}

export function buildMemoryQuery(
  userText: string,
  branchName?: string,
  repoName?: string,
  context?: MemoryQueryContext,
): string {
  const base = [repoName, branchName, userText]
    .filter((part): part is string => Boolean(part))
    .join(' — ')
    .slice(0, MEMORY_QUERY_MAX_CHARS);
  if (!context) return base;
  // The base query (repo/meaningful-branch labels plus the current message) keeps the
  // full char budget; conversation context only fills whatever remains after
  // it. Recent messages are listed newest first so that
  // when the excerpt cap bites, it drops the stalest turns.
  const lines: string[] = [];
  const recent = context.recentUserMessages
    .slice(-MEMORY_CONTEXT_MAX_RECENT_MESSAGES)
    .reverse()
    .map((text) => contextExcerpt(text, CONTEXT_MESSAGE_EXCERPT_CHARS))
    .filter((text) => text.length > 0);
  if (recent.length > 0) {
    lines.push(`Earlier requests: ${recent.join(' | ')}`);
  }
  const summary = context.summaryDescription
    ? contextExcerpt(context.summaryDescription, CONTEXT_SUMMARY_EXCERPT_CHARS)
    : '';
  if (summary) lines.push(`Task: ${summary}`);
  let query = base;
  for (const line of lines) {
    const next = `${query}\n${line}`;
    if (next.length > MEMORY_QUERY_MAX_CHARS) continue;
    query = next;
  }
  return query;
}

/**
 * Minimum wait the memory race grants an in-flight fetch regardless of how
 * much of the budget dispatch setup consumed. Observed race_timeout drops
 * cluster at 1000–1500 ms of server-side latency — well inside the budget —
 * so a fetch that would land just after a slow setup now wins instead of
 * being discarded at a 0 ms wait. Tune with the delivery-attribution
 * `clientElapsedMs` data (CAN-2252).
 */
export const MEMORY_RACE_FLOOR_MS = 500;

/**
 * The budget is anchored at dispatch start so fetch time overlapped with
 * session setup is subtracted from the wait rather than added to the turn.
 * The floor bounds the anchor's downside: only turns whose setup already
 * consumed the whole budget pay anything, and never more than
 * MEMORY_RACE_FLOOR_MS of added latency. This never returns <= 0, which makes
 * `raceWithTimeout`'s zero-timeout fast path unreachable from this caller
 * (the helper stays generic on purpose).
 */
export function remainingMemoryBudgetMs(
  dispatchStartedAt: number,
  now = Date.now(),
): number {
  return Math.min(
    CLIENT_FETCH_TIMEOUT_MS,
    Math.max(
      MEMORY_RACE_FLOOR_MS,
      CLIENT_FETCH_TIMEOUT_MS - (now - dispatchStartedAt),
    ),
  );
}

export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  if (timeoutMs <= 0) {
    return Promise.race<T | null>([promise, Promise.resolve(null)]).catch(
      (): null => null,
    );
  }
  const safePromise = promise.then(
    (value): T | null => value,
    (): null => null,
  );
  return new Promise<T | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    if (typeof timeout === 'object' && 'unref' in timeout) timeout.unref();
    void safePromise.then((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });
}

export function composeSubmittedText(
  visibleSubmittedText: string,
  hiddenContextText?: string,
  renderedMemoryBlocks?: string,
): string {
  const hiddenParts = [hiddenContextText, renderedMemoryBlocks].filter(
    (part): part is string => Boolean(part),
  );
  return hiddenParts.length > 0
    ? [hiddenParts.join('\n\n'), '', visibleSubmittedText].join('\n')
    : visibleSubmittedText;
}

export function joinHiddenBlocks(
  ...blocks: (string | null | undefined)[]
): string | undefined {
  const present = blocks.filter(
    (block): block is string => typeof block === 'string' && block.length > 0,
  );
  return present.length > 0 ? present.join('\n\n') : undefined;
}
