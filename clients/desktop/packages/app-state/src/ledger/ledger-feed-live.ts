import type {
  LedgerAgentLiveState,
  LedgerAgentWaitKind,
} from '@canopy/app-core';
import type {
  LedgerActorKind,
  LedgerLeftOpen,
} from '@canopy/protocol/canopy-core';

/*
 * Live agent state for the Feed page (L12): one projection from a host's
 * canonical chat, delegation and pipeline state to the state a row reads.
 * The host reads its inputs through the same stores and helpers as its
 * sidebar, tabs and tray; nothing here reads tool inputs or transcripts.
 */

/** A chat's canonical facts, as the host's sidebar and tabs read them. */
export interface LedgerChatLiveInput {
  readonly kind: 'chat';
  /** The tab's status is `streaming`: a turn runs (canonical runtime). */
  readonly turnRunning: boolean;
  readonly pendingQuestion: boolean;
  readonly pendingPlan: boolean;
  readonly pendingApproval: boolean;
  /** The chat's background tasks (delegations and live provider tasks). */
  readonly backgroundTasks: number;
  readonly unread: boolean;
  /** A fresh Catching up lag sample for the chat (desktop only). */
  readonly catchingUp: boolean;
}

/** A managed delegate: queued or running counts as working. */
export interface LedgerDelegationLiveInput {
  readonly kind: 'delegation';
  readonly running: boolean;
}

/** A pipeline run's state. */
export interface LedgerPipelineLiveInput {
  readonly kind: 'pipeline';
  readonly status: 'running' | 'waiting_approval' | 'failed' | 'idle';
}

export type LedgerAgentLiveInput =
  | LedgerChatLiveInput
  | LedgerDelegationLiveInput
  | LedgerPipelineLiveInput;

export const LEDGER_AGENT_IDLE: LedgerAgentLiveState = {
  phase: 'idle',
  waitingOn: null,
  backgroundTasks: 0,
  unread: false,
  catchingUp: false,
};

function chatWait(input: LedgerChatLiveInput): LedgerAgentWaitKind | null {
  if (input.pendingQuestion) return 'question';
  if (input.pendingPlan) return 'plan';
  if (input.pendingApproval) return 'approval';
  return null;
}

/**
 * Projects one actor's canonical state. A chat parked on the person waits
 * even while its tab still streams, as the sidebar shows it. A chat whose
 * turn ended but whose background tasks run is `background`, never waiting:
 * background work makes a row Working, never Needs you. Catching up holds
 * only while the chat works.
 */
export function projectAgentLiveState(
  input: LedgerAgentLiveInput,
): LedgerAgentLiveState {
  switch (input.kind) {
    case 'chat': {
      const backgroundTasks = Math.max(0, input.backgroundTasks);
      const waitingOn = chatWait(input);
      const phase: LedgerAgentLiveState['phase'] =
        waitingOn !== null
          ? 'waiting'
          : input.turnRunning
            ? 'working'
            : backgroundTasks > 0
              ? 'background'
              : 'idle';
      return {
        phase,
        waitingOn,
        backgroundTasks,
        unread: input.unread,
        catchingUp: phase === 'working' && input.catchingUp,
      };
    }
    case 'delegation':
      return input.running
        ? { ...LEDGER_AGENT_IDLE, phase: 'working' }
        : LEDGER_AGENT_IDLE;
    case 'pipeline':
      switch (input.status) {
        case 'running':
          return { ...LEDGER_AGENT_IDLE, phase: 'working' };
        case 'waiting_approval':
          return {
            ...LEDGER_AGENT_IDLE,
            phase: 'waiting',
            waitingOn: 'approval',
          };
        case 'failed':
          return {
            ...LEDGER_AGENT_IDLE,
            phase: 'waiting',
            waitingOn: 'failed_run',
          };
        case 'idle':
          return LEDGER_AGENT_IDLE;
      }
  }
}

/** Whether the actor is moving its work: a turn, background tasks or a run. */
export function ledgerAgentIsWorking(state: LedgerAgentLiveState): boolean {
  return state.phase === 'working' || state.phase === 'background';
}

/**
 * Whether the actor leaves its work alone: idle, or a failed run waiting on
 * the person. An agent waiting on an answer or a plan goes on afterwards.
 */
export function ledgerAgentIsResting(state: LedgerAgentLiveState): boolean {
  return (
    state.phase === 'idle' ||
    (state.phase === 'waiting' && state.waitingOn === 'failed_run')
  );
}

/** How long an owner's whole line of agents rests before Left open shows. */
export const LEDGER_LEFT_OPEN_IDLE_MS = 10 * 60_000;

/**
 * When an entry a session left open says so (epoch ms): once its owner and
 * every agent above it have rested ten minutes past both the hand-back and
 * the last time any of them was seen active. Null while any of them works,
 * since it may still close the entry itself, and for an agent owner whose
 * live state is unknown here (such as one only an open tree names). A person
 * runs no agents, so their entries count from the hand-back.
 */
export function ledgerLeftOpenShowsAt(
  leftOpen: LedgerLeftOpen,
  ownerKind: LedgerActorKind,
  live: LedgerAgentLiveState | undefined,
): number | null {
  if (live === undefined && ownerKind !== 'user') return null;
  const ancestry = live?.ancestry;
  if (ancestry !== undefined) {
    if (!ancestry.idle) return null;
  } else if (live !== undefined && !ledgerAgentIsResting(live)) {
    return null;
  }
  const handedBack = Date.parse(leftOpen.at);
  const lastActive =
    ancestry?.lastActiveAt === undefined
      ? Number.NEGATIVE_INFINITY
      : Date.parse(ancestry.lastActiveAt);
  const since = Math.max(
    Number.isFinite(handedBack) ? handedBack : 0,
    Number.isFinite(lastActive) ? lastActive : 0,
  );
  return since + LEDGER_LEFT_OPEN_IDLE_MS;
}

/**
 * A key that changes only when a snapshot's agents change, for hosts that
 * keep one snapshot object while streaming changes nothing it holds.
 */
export function ledgerAgentLiveStateKey(
  agents: Readonly<Record<string, LedgerAgentLiveState>>,
): string {
  return Object.keys(agents)
    .sort()
    .map((actorId) => {
      const state = agents[actorId];
      if (state === undefined) return actorId;
      return [
        actorId,
        state.phase,
        state.waitingOn ?? '',
        String(state.backgroundTasks),
        state.unread ? 'u' : '',
        state.catchingUp ? 'c' : '',
      ].join(':');
    })
    .join(',');
}
