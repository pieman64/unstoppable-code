import type {
  LedgerActorKind,
  LedgerActorLabel,
  LedgerActorRef,
  LedgerEntrySearchItem,
  LedgerEntryType,
  LedgerMutation,
  LedgerOrigin,
  LedgerOwnerCandidate,
  LedgerPublicEntryType,
  LedgerStatus,
  LedgerSyncState,
} from '@canopy/protocol/canopy-core';
import type { LedgerViewSource } from '@canopy/protocol/ledger-view';

/*
 * Display vocabulary for Agent Ledger entries, shared by the scope panel and
 * the Feed. Wire enums stay uppercase; people read these labels.
 */

export const LEDGER_ENTRY_TYPE_LABELS: Readonly<
  Record<LedgerEntryType, string>
> = {
  TASK: 'Task',
  ACTION: 'Action',
  DECISION: 'Decision',
  OBSERVATION: 'Observation',
  SUMMARY: 'Summary',
  OPERATION: 'Operation',
};

export const LEDGER_STATUS_LABELS: Readonly<Record<LedgerStatus, string>> = {
  TODO: 'To do',
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  BLOCKED: 'Blocked',
  NEEDS_REVIEW: 'Needs review',
  INFO: 'Info',
};

/**
 * How an entry's latest revision syncs to the cloud (LD02). `Synced` is the
 * routine outcome, so lists leave it out and only an entry's details say it.
 */
export const LEDGER_SYNC_STATE_LABELS: Readonly<
  Record<LedgerSyncState, string>
> = {
  local_only: 'Saved on this device',
  pending: 'Waiting to sync',
  mirrored: 'Synced',
  policy_restricted: 'Sync off for this workspace',
  repair_needed: 'Needs repair',
};

/**
 * Whether an entry is closed: its status and owner can no longer change.
 * Mirrors the protocol's `isLedgerTerminalStatus`, kept here so display code
 * never loads the protocol's schemas.
 */
export function isLedgerEntryClosed(status: LedgerStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'INFO';
}

/** The ink a status label takes; every status also reads as text. */
export type LedgerStatusTone =
  | 'quiet'
  | 'active'
  | 'success'
  | 'failed'
  | 'paused'
  | 'attention';

export function ledgerStatusTone(status: LedgerStatus): LedgerStatusTone {
  switch (status) {
    case 'IN_PROGRESS':
      return 'active';
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
      return 'failed';
    case 'BLOCKED':
      return 'paused';
    case 'NEEDS_REVIEW':
      return 'attention';
    case 'TODO':
    case 'INFO':
      return 'quiet';
  }
}

/** Neutral names for actors a read did not label. */
export const LEDGER_ACTOR_KIND_LABELS: Readonly<
  Record<LedgerActorKind, string>
> = {
  user: 'You',
  chat: 'Chat',
  pipeline_agent: 'Workflow agent',
  managed_delegation: 'Delegate',
  background: 'Background task',
  ledger_sidecar: 'Feed sidecar',
};

/** Indexes actor labels by actor ID. */
export function indexLedgerActorLabels(
  labels: readonly LedgerActorLabel[] | undefined,
): Readonly<Record<string, LedgerActorLabel>> {
  const index: Record<string, LedgerActorLabel> = {};
  for (const label of labels ?? []) index[label.actorId] = label;
  return index;
}

/** The name an actor was registered under, or its kind's neutral name. */
export function ledgerActorName(
  actor: LedgerActorRef,
  labels: Readonly<Record<string, LedgerActorLabel>>,
): string {
  return (
    labels[actor.actorId]?.displayName ?? LEDGER_ACTOR_KIND_LABELS[actor.kind]
  );
}

const SAME_YEAR_DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});
const OTHER_YEAR_DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});
const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const FULL_DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'full',
  timeStyle: 'long',
});

/** A time of day, such as when a pipeline agent paused. */
export function formatLedgerTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : TIME_FORMAT.format(date);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago an entry was recorded, for a row: `Just now` under a minute,
 * `12 min ago` under an hour, `3 h ago` under a day, then its date (`Oct 3`,
 * with the year when it is not this year). It does not tick; the exact time
 * is among the entry's details. A time ahead of `now` reads as `Just now`.
 */
export function formatLedgerRelativeTime(
  iso: string,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return 'Just now';
  if (elapsed < HOUR_MS) {
    return `${String(Math.floor(elapsed / MINUTE_MS))} min ago`;
  }
  if (elapsed < DAY_MS) {
    return `${String(Math.floor(elapsed / HOUR_MS))} h ago`;
  }
  return date.getFullYear() === now.getFullYear()
    ? SAME_YEAR_DAY_FORMAT.format(date)
    : OTHER_YEAR_DAY_FORMAT.format(date);
}

/** An exact local date and time, for the detail view. */
export function formatLedgerDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_TIME_FORMAT.format(date);
}

/** The full local date and time, for a timestamp's tooltip; the input when unreadable. */
export function formatLedgerFullDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isFinite(Date.parse(iso))
    ? FULL_DATE_TIME_FORMAT.format(date)
    : iso;
}

/** The first characters of an entry's content, on one line. */
export function ledgerExcerpt(content: string, maxCodePoints = 160): string {
  const singleLine = content.replace(/\s+/g, ' ').trim();
  const codePoints = Array.from(singleLine);
  return codePoints.length <= maxCodePoints
    ? singleLine
    : `${codePoints
        .slice(0, maxCodePoints - 1)
        .join('')
        .trimEnd()}…`;
}

/** What a source action's glyph stands for: where the source opens. */
export type LedgerSourceActionGlyph = 'chat' | 'run' | 'archived';

/** An entry's source action as a row shows it. */
export interface LedgerSourceAction {
  readonly label: string;
  readonly glyph: LedgerSourceActionGlyph;
  /** Says whose chat is archived; null when the label says it all. */
  readonly tooltip: string | null;
}

const OPEN_CHAT_ACTION: LedgerSourceAction = {
  label: 'Open chat',
  glyph: 'chat',
  tooltip: null,
};

const OPEN_RUN_ACTION: LedgerSourceAction = {
  label: 'Open run',
  glyph: 'run',
  tooltip: null,
};

const OPEN_ARCHIVED_CHAT_ACTION: LedgerSourceAction = {
  label: 'Open archived chat',
  glyph: 'archived',
  tooltip: 'This chat is archived. It opens read-only.',
};

const OPEN_ARCHIVED_PARENT_CHAT_ACTION: LedgerSourceAction = {
  label: 'Open archived chat',
  glyph: 'archived',
  tooltip:
    'The chat that started this delegate is archived. It opens read-only.',
};

/**
 * What opening an entry's read source does. A delegate's chat is its own
 * subagent chat while the chat that started it is live; once that chat is
 * archived, the archived chat opens instead.
 */
export function ledgerSourceAction(
  source: LedgerViewSource,
): LedgerSourceAction | null {
  const target = source.target;
  if (target === null) return null;
  switch (target.kind) {
    case 'chat':
      if (!target.archived) return OPEN_CHAT_ACTION;
      return target.delegationId === undefined
        ? OPEN_ARCHIVED_CHAT_ACTION
        : OPEN_ARCHIVED_PARENT_CHAT_ACTION;
    case 'pipeline':
      return OPEN_RUN_ACTION;
    case 'summary':
      return null;
  }
}

/**
 * The source action a list item alone can promise: a chat author's chat, a
 * delegate's chat or the run that started it, or a pipeline agent's run,
 * while it is still there. Anything else waits for the entry's own read,
 * which resolves its real source.
 */
export function ledgerSearchItemSourceAction(
  item: Pick<
    LedgerEntrySearchItem,
    'author' | 'sourceAvailability' | 'sourceKind'
  >,
): LedgerSourceAction | null {
  switch (item.author.kind) {
    case 'chat':
      if (item.sourceAvailability === 'available') return OPEN_CHAT_ACTION;
      return item.sourceAvailability === 'archived'
        ? OPEN_ARCHIVED_CHAT_ACTION
        : null;
    case 'pipeline_agent':
      return item.sourceAvailability === 'available' ? OPEN_RUN_ACTION : null;
    case 'managed_delegation':
      // A delegate's source is its root's: a chat, or a pipeline run.
      if (item.sourceKind === 'pipeline') {
        return item.sourceAvailability === 'available' ? OPEN_RUN_ACTION : null;
      }
      if (item.sourceKind !== 'chat') return null;
      if (item.sourceAvailability === 'available') return OPEN_CHAT_ACTION;
      return item.sourceAvailability === 'archived'
        ? OPEN_ARCHIVED_PARENT_CHAT_ACTION
        : null;
    case 'user':
    case 'background':
    case 'ledger_sidecar':
      return null;
  }
}

/**
 * Whether a row shows an entry's status: always for a task or an action,
 * otherwise only when it says more than `Info`.
 */
export function ledgerEntryShowsStatus(
  entry: Pick<LedgerEntrySearchItem, 'type' | 'status'>,
): boolean {
  return (
    entry.type === 'TASK' || entry.type === 'ACTION' || entry.status !== 'INFO'
  );
}

/**
 * Whether a row names an entry's owner: while it is open and someone other
 * than its author owns it, since that is who should act.
 */
export function ledgerEntryShowsOwner(
  entry: Pick<LedgerEntrySearchItem, 'status' | 'owner' | 'author'>,
): boolean {
  return (
    !isLedgerEntryClosed(entry.status) &&
    entry.owner.actorId !== entry.author.actorId
  );
}

/** One piece of a change sentence: fixed copy, or an actor's name. */
export type LedgerMutationSentencePart =
  | string
  | { readonly actor: LedgerActorRef; readonly name: string };

/**
 * {@link describeLedgerMutation}'s sentence in pieces, with each actor's name
 * its own part, so a view can treat a person's name on its own (session
 * replay blocks a teammate's name). Adjacent copy is merged.
 */
export function ledgerMutationSentenceParts(
  mutation: LedgerMutation,
  nameOf: (actor: LedgerActorRef) => string,
): LedgerMutationSentencePart[] {
  const parts: LedgerMutationSentencePart[] = [];
  const push = (part: LedgerMutationSentencePart): void => {
    const last = parts[parts.length - 1];
    if (typeof part === 'string' && typeof last === 'string') {
      parts[parts.length - 1] = last + part;
    } else {
      parts.push(part);
    }
  };
  const actorPart = (actor: LedgerActorRef): LedgerMutationSentencePart => ({
    actor,
    name: nameOf(actor),
  });
  push(actorPart(mutation.attribution.effectiveActor));
  if (mutation.kind === 'create') {
    push(
      mutation.status === undefined
        ? ' added this entry'
        : ` added this entry as ${LEDGER_STATUS_LABELS[mutation.status.to]}`,
    );
    return parts;
  }
  const changes: LedgerMutationSentencePart[][] = [];
  if (mutation.status !== undefined) {
    changes.push([
      mutation.status.from === null
        ? `set the status to ${LEDGER_STATUS_LABELS[mutation.status.to]}`
        : `changed the status from ${LEDGER_STATUS_LABELS[mutation.status.from]} to ${LEDGER_STATUS_LABELS[mutation.status.to]}`,
    ]);
  }
  if (mutation.owner !== undefined) {
    changes.push(['made ', actorPart(mutation.owner.to), ' the owner']);
  }
  if (changes.length === 0) {
    push(' updated this entry');
    return parts;
  }
  push(' ');
  changes.forEach((change, index) => {
    if (index > 0) push(' and ');
    for (const part of change) push(part);
  });
  return parts;
}

/**
 * What one change did, in a sentence that names who made it: "Theme support
 * changed the status from Blocked to In progress". `nameOf` names an actor
 * the way the surrounding view does.
 */
export function describeLedgerMutation(
  mutation: LedgerMutation,
  nameOf: (actor: LedgerActorRef) => string,
): string {
  return ledgerMutationSentenceParts(mutation, nameOf)
    .map((part) => (typeof part === 'string' ? part : part.name))
    .join('');
}

/**
 * Where an entry came from, as one sentence. `source` is null when this
 * device could not check it.
 */
export function ledgerSourceDescription(
  origin: LedgerOrigin,
  source: LedgerViewSource | null,
): string {
  if (origin.kind === 'user') return 'Added in the Feed.';
  if (source === null) return "The source can't be checked right now.";
  switch (source.availability) {
    case 'available':
      break;
    case 'archived':
      return 'Recorded in a chat that is now archived.';
    case 'deleted':
      return origin.kind === 'summary'
        ? 'The summary that recorded this entry was deleted.'
        : 'The chat that recorded this entry was deleted.';
    case 'expired':
      return origin.kind === 'summary'
        ? 'The summary that recorded this entry is no longer kept.'
        : 'The run that recorded this entry is no longer kept.';
    case 'not_on_this_device':
      return 'The source of this entry is on another device.';
    case 'access_denied':
      return "You don't have access to the source of this entry.";
    case 'anchor_missing':
      return 'The exact moment this entry was recorded is no longer available.';
  }
  switch (origin.kind) {
    case 'chat':
      return 'Recorded in a chat.';
    case 'managed_delegation':
      return 'Recorded by a delegate.';
    case 'pipeline_agent':
      return 'Recorded by a workflow agent.';
    case 'summary':
      return 'Recorded from the Summary panel.';
  }
}

/** The types a person can add, in the form's order. */
export const LEDGER_FORM_TYPE_OPTIONS: readonly LedgerPublicEntryType[] = [
  'TASK',
  'ACTION',
  'DECISION',
  'OBSERVATION',
  'OPERATION',
];

/** Statuses that keep an entry open to further changes. */
export const LEDGER_OPEN_STATUS_OPTIONS: readonly LedgerStatus[] = [
  'TODO',
  'IN_PROGRESS',
  'BLOCKED',
  'NEEDS_REVIEW',
];

/** Statuses that close an entry: its status and owner never change again. */
export const LEDGER_CLOSING_STATUS_OPTIONS: readonly LedgerStatus[] = [
  'COMPLETED',
  'FAILED',
  'INFO',
];

/** Text length as the Ledger limits it: in code points, not UTF-16 units. */
export function countLedgerCodePoints(text: string): number {
  return Array.from(text).length;
}

/** Why a closed entry offers no status or owner change. */
export function ledgerClosedEntryExplanation(status: LedgerStatus): string {
  return `${LEDGER_STATUS_LABELS[status]} entries can't change. Add a correction to record something new.`;
}

const OWNER_KIND_DESCRIPTIONS: Readonly<
  Partial<Record<LedgerActorKind, string>>
> = {
  chat: 'Chat',
  managed_delegation: 'Delegate',
};

/**
 * One line telling an owner candidate apart from others of the same name. A
 * paused pipeline agent names its exact run, job, step and pause time; the
 * full locator, checkpoint included, is in {@link ledgerOwnerCandidateTitle}.
 */
export function ledgerOwnerCandidateDescription(
  candidate: LedgerOwnerCandidate,
): string {
  const agent = candidate.pipelineAgent;
  if (agent !== undefined) {
    const paused =
      agent.pausedAt === null
        ? ''
        : `, paused ${formatLedgerTime(agent.pausedAt)}`;
    return `Workflow run ${agent.executionId.slice(0, 8)}, job ${agent.jobId}, step ${agent.stepId}${paused}`;
  }
  if (candidate.isSelf) return '';
  return OWNER_KIND_DESCRIPTIONS[candidate.actor.kind] ?? '';
}

/** Every detail of an owner candidate, for its tooltip. */
export function ledgerOwnerCandidateTitle(
  candidate: LedgerOwnerCandidate,
): string {
  const agent = candidate.pipelineAgent;
  if (agent === undefined) return candidate.displayName;
  return [
    candidate.displayName,
    `Run ${agent.executionId}`,
    `Job ${agent.jobId}, step ${agent.stepId}, attempt ${agent.attempt}`,
    `Checkpoint ${agent.checkpointId}`,
  ].join('\n');
}
