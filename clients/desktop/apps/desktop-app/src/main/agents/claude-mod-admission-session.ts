import {
  isSkippedClaudeMod,
  type SkippedClaudeMod,
} from '@canopy/execution-engine/types/claude-mod-admission';
import {
  CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE,
  type ClaudeModsSkippedEntry,
} from '@canopy/agent-transcript/types';

export interface ClaudeModsSkippedEvent {
  type: typeof CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE;
  sourceEventId: string;
  timestamp: number;
  mods: ClaudeModsSkippedEntry[];
}

const skippedModsBySession = new Map<string, readonly SkippedClaudeMod[]>();
let skippedModsEventSequence = 0;
const MAX_CLAUDE_MODS_SKIPPED_NOTICE_ENTRIES = 50;

function deduplicateSkippedMods(
  entries: readonly SkippedClaudeMod[],
): SkippedClaudeMod[] {
  const seen = new Set<string>();
  const result: SkippedClaudeMod[] = [];
  for (const entry of entries) {
    if (!isSkippedClaudeMod(entry)) continue;
    const key = `${entry.pluginId}\0${entry.source}\0${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...entry });
  }
  return result;
}

/** Replace the launch snapshot when a session starts a new Claude process. */
export function replaceClaudeModAdmissionSessionRecords(
  sessionKey: string,
  skippedMods: readonly SkippedClaudeMod[],
): void {
  if (sessionKey.length === 0) return;
  skippedModsBySession.set(sessionKey, deduplicateSkippedMods(skippedMods));
}

/** Return an immutable copy of the current launch snapshot for phase 05. */
export function getClaudeModAdmissionSessionRecords(
  sessionKey: string,
): readonly SkippedClaudeMod[] {
  return (skippedModsBySession.get(sessionKey) ?? []).map((entry) => ({
    ...entry,
  }));
}

/**
 * Whether a Mod change should relaunch this session at its next turn: every
 * session for `all`; for `skipped`, one whose launch skipped a Mod or whose
 * launch has not decided admission yet (it may have used the old consent).
 */
export function shouldReloadForClaudeModChange(
  sessionKey: string,
  scope: 'skipped' | 'all',
): boolean {
  if (scope === 'all') return true;
  const records = skippedModsBySession.get(sessionKey);
  return records === undefined || records.length > 0;
}

/** Build the private, path-free skipped-Mod notice for one real process start. */
export function buildClaudeModsSkippedEvent(
  sessionKey: string,
  timestamp = Date.now(),
): ClaudeModsSkippedEvent | undefined {
  const seen = new Set<string>();
  const mods: ClaudeModsSkippedEntry[] = [];
  for (const entry of getClaudeModAdmissionSessionRecords(sessionKey)) {
    const key = `${entry.pluginId}\0${entry.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mods.push({ pluginId: entry.pluginId, reason: entry.reason });
    if (mods.length >= MAX_CLAUDE_MODS_SKIPPED_NOTICE_ENTRIES) break;
  }
  if (mods.length === 0) return undefined;
  skippedModsEventSequence += 1;
  return {
    type: CANOPY_CLAUDE_MODS_SKIPPED_EVENT_TYPE,
    sourceEventId: `claude-mods-skipped:${String(timestamp)}:${String(skippedModsEventSequence)}`,
    timestamp,
    mods,
  };
}

/** Emit after `spawn` returns; a rejected spawn must not produce a notice. */
export function spawnWithClaudeModsSkippedEvent<T>(
  sessionKey: string,
  spawn: () => T,
  emit: (event: ClaudeModsSkippedEvent) => void,
  timestamp?: number,
): T {
  const spawned = spawn();
  const event = buildClaudeModsSkippedEvent(
    sessionKey,
    timestamp ?? Date.now(),
  );
  if (event) {
    try {
      emit(event);
    } catch {
      // A transcript notice must not invalidate an already-started process.
    }
  }
  return spawned;
}

/** Clear the process-local launch snapshot when its session is disposed. */
export function clearClaudeModAdmissionSessionRecords(
  sessionKey: string,
): void {
  skippedModsBySession.delete(sessionKey);
}
