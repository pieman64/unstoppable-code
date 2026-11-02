// ---------------------------------------------------------------------------
// Renderer-local history of how long worktree setup took, per project.
//
// A queued message waiting for a new worktree shows "about 0:15 left" when
// this renderer has seen a setup of the same project finish before, and the
// elapsed time otherwise. A sample is the time from the worktree row's
// `createdAt` to this renderer receiving its git-ready event: the event that
// releases setup-queued messages. It is an approximate, best-effort sample
// for this renderer only, not authoritative or cross-device history.
//
// Storage failures are swallowed: this history must never interrupt git-ready
// handling or queue dispatch.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'canopy.worktreeSetupDurations.v1';
/** At most this many projects keep a sample; the oldest recorded go first. */
export const MAX_SETUP_DURATION_PROJECTS = 50;
/** Samples must be shorter than this to count. */
export const MAX_SETUP_DURATION_MS = 60 * 60 * 1000;

export interface WorktreeSetupDurationSample {
  readonly durationMs: number;
  readonly recordedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDuration(durationMs: number): boolean {
  return (
    Number.isFinite(durationMs) &&
    durationMs > 0 &&
    durationMs < MAX_SETUP_DURATION_MS
  );
}

function parseSample(value: unknown): WorktreeSetupDurationSample | null {
  if (!isRecord(value)) return null;
  const { durationMs, recordedAt } = value;
  if (typeof durationMs !== 'number' || typeof recordedAt !== 'number') {
    return null;
  }
  if (!isValidDuration(durationMs) || !Number.isFinite(recordedAt)) {
    return null;
  }
  return { durationMs, recordedAt };
}

function readAll(): Map<string, WorktreeSetupDurationSample> {
  const samples = new Map<string, WorktreeSetupDurationSample>();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return samples;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.projects)) return samples;
    for (const [projectId, value] of Object.entries(parsed.projects)) {
      const sample = parseSample(value);
      if (sample) samples.set(projectId, sample);
    }
  } catch {
    // Unreadable or malformed history reads as none.
  }
  return samples;
}

function writeAll(samples: Map<string, WorktreeSetupDurationSample>): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ projects: Object.fromEntries(samples) }),
    );
  } catch {
    // Best effort: a full or unavailable store keeps the old history.
  }
}

/** The last valid setup duration seen for `projectId`, in ms. */
export function readWorktreeSetupDuration(projectId: string): number | null {
  return readAll().get(projectId)?.durationMs ?? null;
}

/**
 * Record one setup's duration for `projectId`. The newest observation wins;
 * a replayed event for an observation already recorded at the same or a
 * later time is ignored, so a duplicate can't stretch the estimate.
 */
export function recordWorktreeSetupDuration(
  projectId: string,
  durationMs: number,
  recordedAt: number = Date.now(),
): void {
  if (!isValidDuration(durationMs) || !Number.isFinite(recordedAt)) return;
  const samples = readAll();
  const existing = samples.get(projectId);
  if (existing && existing.recordedAt >= recordedAt) return;
  samples.delete(projectId);
  samples.set(projectId, { durationMs, recordedAt });
  while (samples.size > MAX_SETUP_DURATION_PROJECTS) {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    samples.forEach((sample, id) => {
      if (sample.recordedAt < oldestAt) {
        oldestAt = sample.recordedAt;
        oldestId = id;
      }
    });
    if (oldestId === null) break;
    samples.delete(oldestId);
  }
  writeAll(samples);
}

/**
 * Record the setup that just finished, when the worktree row shows a real
 * first-time setup: it was `git-pending` with a valid `createdAt` no later
 * than now. Anything else (a missing row, a row already ready, which a
 * replayed event finds) is skipped.
 */
export function recordWorktreeSetupFromRow(
  projectId: string,
  row: { readonly createdAt: string; readonly setupPhase?: string } | undefined,
  nowMs: number = Date.now(),
): void {
  if (!row || row.setupPhase !== 'git-pending') return;
  const createdAtMs = Date.parse(row.createdAt);
  if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs) return;
  recordWorktreeSetupDuration(projectId, nowMs - createdAtMs, nowMs);
}
