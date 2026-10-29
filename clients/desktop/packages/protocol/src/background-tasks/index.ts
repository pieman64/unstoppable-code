// ---------------------------------------------------------------------------
// Portable background-task contract.
//
// A background task is work an agent turn started that keeps running on its
// own: a shell launched in the background, a background subagent, or a
// workflow. Each host projects its own tracking record into this shape so
// shared UI can render the same cards on desktop and web. Desktop adapts its
// `BackgroundProcess` (`@canopy/desktop-shared`) with `backgroundProcessToTask`.
//
// The shape stays serializable and host-neutral: no host paths (output files,
// transcript directories, script files), no provider session handles. Hosts
// keep those beside the task and resolve them through their own actions.
//
// IMPORTANT: this module must stay dependency-free (no React, no Node APIs,
// no Electron, no other workspace packages).
// ---------------------------------------------------------------------------

export type BackgroundTaskKind = 'agent' | 'bash' | 'task' | 'workflow';

export type BackgroundTaskStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface BackgroundTask {
  /** Stable per host (desktop: the existing `BackgroundProcess` id). */
  readonly id: string;
  readonly kind: BackgroundTaskKind;
  readonly status: BackgroundTaskStatus;
  /**
   * The label hosts show for the task: a shell's description or command, an
   * agent's description or prompt.
   */
  readonly title: string;
  /** The tool use that launched the task, which ties it to its turn. */
  readonly ownerToolUseId: string | null;
  /** The task that started this one, when the host tracks nesting. */
  readonly parentTaskId: string | null;
  /** Epoch ms. */
  readonly startedAt: number | null;
  /** Epoch ms the task reached a terminal status; null while it is live. */
  readonly settledAt: number | null;
  /** Epoch ms of the latest change; cards list the newest first. */
  readonly updatedAt: number;
  /** The latest progress line the provider reported, when it has one. */
  readonly lastDescription: string | null;
  /** The provider's summary of the task or its result, when it has one. */
  readonly summary: string | null;
  readonly outputLines: readonly string[];
  /** Whether the host can stop the task now; gates the Stop action. */
  readonly canStop: boolean;
}
