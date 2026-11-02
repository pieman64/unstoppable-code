export type ChatTurnPhase = 'idle' | 'background' | 'foreground';

/** Transient host-owned reason an explicit queued retry cannot send yet. */
export type QueuedMessageRetryBlockedReason = 'insufficient_credits';

/**
 * Why a queued message is waiting when the host can say. `steer_unavailable`:
 * a turn is running and it cannot take a new message right now.
 * `background_work`: sending it would restart the agent with changed settings
 * and stop background work that is still running, so it waits for that work.
 */
export type QueuedMessageWaitingReason =
  | 'steer_unavailable'
  | 'background_work';

/**
 * A kind of setting that differs from the one the chat's live agent runs
 * with, named so a host can say what a held send is waiting to apply. Names
 * only; never the old or new values.
 */
export type SettingsHeldChange =
  | 'model'
  | 'agent'
  | 'plan_mode'
  | 'plugins'
  | 'tools'
  | 'instructions'
  | 'approval_rules'
  | 'delegation'
  | 'codex_preferences'
  | 'account'
  | 'organization';
