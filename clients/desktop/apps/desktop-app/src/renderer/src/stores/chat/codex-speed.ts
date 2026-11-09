// Renderer-side reads of the canonical three-state Codex speed. The shared
// semantics (speed is the source of truth, `fastMode` is its derived
// projection) live in `@canopy/execution-engine/lib/codex-speed`; these helpers
// only adapt them to runtime chat tabs and persisted tab records.
import {
  DEFAULT_CODEX_SPEED,
  codexSpeedFastMode,
  isCodexSpeed,
  readCodexSpeedRecord,
  type CodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import type {
  AgentModelConfig,
  ResolvedAgentModelConfig,
} from '@canopy/desktop-shared/types';
import type { ChatTab } from './types';

/**
 * The Codex speed a runtime tab requests: its resolved config's `speed`,
 * then the legacy boolean projections, else Regular. Reading through the
 * record helper keeps a stale compatibility boolean from ever outranking an
 * exact speed.
 */
export function tabRequestedCodexSpeed(
  tab: Pick<ChatTab, 'modelConfig' | 'codexFastModeEnabled'>,
): CodexSpeed {
  return (
    readCodexSpeedRecord(tab.modelConfig, tab.codexFastModeEnabled) ??
    DEFAULT_CODEX_SPEED
  );
}

/** The canonical speed pair: the exact speed and its derived boolean. */
export function codexSpeedFields(
  speed: CodexSpeed,
): Pick<ResolvedAgentModelConfig, 'speed' | 'fastMode'> {
  return { speed, fastMode: codexSpeedFastMode(speed) };
}

/** A copy of `config` without any speed information. */
export function withoutCodexSpeed(
  config: AgentModelConfig | undefined,
): AgentModelConfig {
  const next: AgentModelConfig = { ...config };
  delete next.speed;
  delete next.fastMode;
  return next;
}

interface PendingSpeedWrites {
  /** Writes started and not yet settled. */
  count: number;
  /** Increments per write; the highest is the newest choice. */
  generation: number;
  /** The speed main last confirmed, or the speed before the first write. */
  canonical: CodexSpeed;
  /** Whether the newest write was rejected. */
  newestFailed: boolean;
}

const pendingSpeedWrites = new Map<string, PendingSpeedWrites>();

function pendingSpeedWriteKey(
  projectId: string,
  worktreeId: string,
  chatId: string,
): string {
  return JSON.stringify([projectId, worktreeId, chatId]);
}

/**
 * Marks a local speed write in flight until the returned release runs. Main
 * echoes each committed speed back, so quick changes would otherwise briefly
 * restore an older speed over a newer optimistic one; while a write is
 * pending the tab keeps its local speed. Main commits writes in order and
 * echoes each before its reply, so the last echo matches the last write.
 *
 * `previous` is the speed shown before this write. Release takes whether the
 * write failed; once every write has settled it returns the speed to roll
 * back to when the newest write failed (the last confirmed one), else
 * `undefined`.
 */
export function beginLocalCodexSpeedWrite(
  projectId: string,
  worktreeId: string,
  chatId: string,
  previous: CodexSpeed,
): (failed: boolean) => CodexSpeed | undefined {
  const key = pendingSpeedWriteKey(projectId, worktreeId, chatId);
  const entry = pendingSpeedWrites.get(key) ?? {
    count: 0,
    generation: 0,
    canonical: previous,
    newestFailed: false,
  };
  entry.count += 1;
  entry.generation += 1;
  entry.newestFailed = false;
  const generation = entry.generation;
  pendingSpeedWrites.set(key, entry);
  let released = false;
  return (failed: boolean): CodexSpeed | undefined => {
    if (released) return undefined;
    released = true;
    if (failed && generation === entry.generation) entry.newestFailed = true;
    entry.count -= 1;
    if (entry.count > 0) return undefined;
    pendingSpeedWrites.delete(key);
    return entry.newestFailed ? entry.canonical : undefined;
  };
}

/**
 * Records a speed main committed while local writes were pending, so a
 * rejected newest write can fall back to it.
 */
export function recordCanonicalCodexSpeedWhilePending(
  projectId: string,
  worktreeId: string,
  chatId: string,
  speed: CodexSpeed,
): void {
  const entry = pendingSpeedWrites.get(
    pendingSpeedWriteKey(projectId, worktreeId, chatId),
  );
  if (entry) entry.canonical = speed;
}

/** Whether a local speed write for this chat has not settled yet. */
export function hasPendingLocalCodexSpeedWrite(
  projectId: string,
  worktreeId: string,
  chatId: string,
): boolean {
  return pendingSpeedWrites.has(
    pendingSpeedWriteKey(projectId, worktreeId, chatId),
  );
}

/**
 * Mirror of the main-owned `retainedCodexSpeed` tab field. Invalid values are
 * dropped (legacy-read safety); valid ones are carried verbatim so renderer
 * copies and compatibility snapshots never erase them.
 */
export function retainedCodexSpeedFields(
  value: unknown,
): Pick<ChatTab, 'retainedCodexSpeed'> {
  return isCodexSpeed(value) ? { retainedCodexSpeed: value } : {};
}
