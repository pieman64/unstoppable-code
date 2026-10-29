import {
  botChatWatcherAddressSchema,
  botChatWatcherScopeSchema,
  projectChatWatcherAddressSchema,
  projectChatWatcherScopeSchema,
  type CanonicalChatWatcherEntry,
  type CanonicalChatWatcherTrigger,
} from '@canopy/agent-actions';
import type {
  AppAdvisorWatcherDestination,
  AppAdvisorWatcherStatus,
  AppAdvisorWatcherSummary,
  ChatWatcherAvailability,
  ChatWatcherHeldOutcome,
  ProjectOwnerContext,
  PublicChatWatcherTargetKind,
  SetupAppAdvisorWatchersInput,
} from '../types';
import type { ProjectChatAddress, ProjectType } from './project-discovery';
import type { BotChatAddress } from './bot-discovery';

export type {
  ChatWatcherAvailability,
  ChatWatcherHeldOutcome,
  PublicChatWatcherTargetKind,
} from '../types';
export type { ProjectChatAddress } from './project-discovery';
export type { BotChatAddress } from './bot-discovery';

export {
  CANONICAL_CHAT_WATCHER_TRIGGERS,
  type CanonicalChatWatcherTrigger,
  projectChatWatcherAddressSchema,
  projectChatWatcherScopeSchema,
  botChatWatcherAddressSchema,
  botChatWatcherScopeSchema,
  projectTaskChatCompletionWatcherSchema,
  projectNewChatStartedWatcherSchema,
  botTaskChatCompletionWatcherSchema,
  botNewChatStartedWatcherSchema,
  canonicalChatWatcherEntrySchema,
  type CanonicalChatWatcherEntry,
  canonicalChatWatcherEnvelopeSchema,
  isCanonicalChatWatcherTrigger,
  containsCanonicalChatWatcher,
  chatWatcherSetupSchema,
  canonicalChatWatcherEntryJsonSchema,
  extendChatWatcherSetupJsonSchema,
} from '@canopy/agent-actions';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// These are unresolved historical facts, not canonical addresses. In particular
// a cowork completion has no taskId until C resolves its real owning entry.
type LegacyMetadata = {
  label?: string;
  followUpInstruction?: string;
  allowDuplicate?: boolean;
};
export type UnresolvedLegacyWorktreeChatCompletion = LegacyMetadata & {
  trigger: 'worktree_chat_completion';
  target: {
    kind: 'worktree_chat';
    projectId: string;
    worktreeId: string;
    chatId: string;
  };
  armForNextCompletion?: boolean;
};
export type UnresolvedLegacyStandaloneChatCompletion = LegacyMetadata & {
  trigger: 'standalone_chat_completion';
  target: { kind: 'standalone_chat'; projectId: string; chatId: string };
  armForNextCompletion?: boolean;
};
export type UnresolvedLegacyWorktreeNewChatStarted = LegacyMetadata & {
  trigger: 'worktree_new_chat_started';
  target: {
    kind: 'worktree_chat_scope';
    projectId: string;
    worktreeId: string;
  };
};
export type UnresolvedLegacyStandaloneNewChatStarted = LegacyMetadata & {
  trigger: 'standalone_new_chat_started';
  target: { kind: 'standalone_chat_project'; projectId: string };
};
export type UnresolvedLegacyChatWatcher =
  | UnresolvedLegacyWorktreeChatCompletion
  | UnresolvedLegacyStandaloneChatCompletion
  | UnresolvedLegacyWorktreeNewChatStarted
  | UnresolvedLegacyStandaloneNewChatStarted;

export type CanonicalChatAddress = ProjectChatAddress | BotChatAddress;
export type ProjectChatScope = { projectId: string; taskId?: string };
export type BotChatScope = { botId: string; taskId?: string };
export type ResolvedChatWatcherTarget =
  | {
      kind: 'project';
      projectType: ProjectType;
      address: ProjectChatAddress | ProjectChatScope;
    }
  | { kind: 'bot'; address: BotChatAddress | BotChatScope };

/** Main-only acceptance evidence. Null owner means the ownerless Advisor. */
export type ChatWatcherEvidence = {
  sourceOwner: ProjectOwnerContext | null;
  /**
   * Legacy: an in-memory counter that resets per launch. Never persist it or
   * compare it across awaits; stored values are ignored.
   */
  accountEpoch?: number;
  resourceIncarnation?: string;
};
type CanonicalChatEventBase = {
  eventId: string;
  address: CanonicalChatAddress;
  sourceInputId: string;
  /** Original accepted/terminal ISO time, never a replay time. */
  occurredAt: string;
  observedAt: string;
  evidence: ChatWatcherEvidence;
};
export type CanonicalChatStartedEvent = CanonicalChatEventBase & {
  kind: 'started';
};
export type ChatTerminalDisposition =
  | 'completed'
  | 'interrupted'
  | 'error'
  | 'no_output';
/**
 * Why an input ended without a turn of its own: no provider accepted it
 * (`unaccepted`: a cancelled queued send, a failed setup, admission or
 * dispatch), or another turn superseded the turn an app restart interrupted
 * (`abandoned`).
 */
export type ChatTerminalEndReason = 'unaccepted' | 'abandoned';
export type CanonicalChatTerminalEvent = CanonicalChatEventBase & {
  kind: 'terminal';
  disposition: ChatTerminalDisposition;
  /**
   * Durable acceptance time of `sourceInputId`; binds `next` cursors. Empty
   * when the input was never accepted, which binds no `next` cursor.
   */
  sourceInputAcceptedAt: string;
  /**
   * Set when `sourceInputId` ended without a turn of its own. Such an end
   * satisfies only watchers bound to that input and carries no report.
   */
  endReason?: ChatTerminalEndReason;
  /**
   * Earlier roots, interrupted by app restarts, that this turn carried on.
   * A watcher bound to one of them is satisfied by this terminal.
   */
  resumesInputIds?: readonly string[];
};
export type CanonicalChatEvent =
  | CanonicalChatStartedEvent
  | CanonicalChatTerminalEvent;

/**
 * The lifecycle facts a raw provider or chat-state terminal payload stamps
 * (`canopy_turn_unaccepted`, `canopy_turn_abandoned`, `canopy_turn_resumes`),
 * in the canonical terminal's shape. Unknown or malformed stamps are ignored.
 */
export function chatTerminalLifecycle(
  data: unknown,
): Pick<CanonicalChatTerminalEvent, 'endReason' | 'resumesInputIds'> {
  if (!isRecord(data)) return {};
  const resumes = Array.isArray(data.canopy_turn_resumes)
    ? data.canopy_turn_resumes.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      )
    : [];
  return {
    ...(data.canopy_turn_unaccepted === true
      ? { endReason: 'unaccepted' as const }
      : data.canopy_turn_abandoned === true
        ? { endReason: 'abandoned' as const }
        : {}),
    ...(resumes.length > 0 ? { resumesInputIds: resumes } : {}),
  };
}
export type ChatObservationCursor = {
  mode: 'current' | 'next';
  boundInputId?: string;
  armedAt: string;
};

export type ChatWatcherStore =
  | { store: 'v1'; legacy: UnresolvedLegacyChatWatcher }
  | { store: 'sidecar' };

/** Lossless old-matcher encoding only. Never widen a cowork task scope. */
export function storeFor(
  trigger: CanonicalChatWatcherTrigger,
  target: ResolvedChatWatcherTarget,
): ChatWatcherStore {
  if (target.kind === 'bot') {
    if (
      trigger !== 'bot_task_chat_completion' &&
      trigger !== 'bot_new_chat_started'
    )
      throw new Error('Trigger/address mismatch');
    if (trigger === 'bot_task_chat_completion')
      botChatWatcherAddressSchema.parse(target.address);
    else botChatWatcherScopeSchema.parse(target.address);
    return { store: 'sidecar' };
  }
  const address = target.address;
  if (trigger === 'project_task_chat_completion') {
    const chat = projectChatWatcherAddressSchema.parse(address);
    return target.projectType === 'code'
      ? {
          store: 'v1',
          legacy: {
            trigger: 'worktree_chat_completion',
            target: {
              kind: 'worktree_chat',
              projectId: chat.projectId,
              worktreeId: chat.taskId,
              chatId: chat.chatId,
            },
          },
        }
      : {
          store: 'v1',
          legacy: {
            trigger: 'standalone_chat_completion',
            target: {
              kind: 'standalone_chat',
              projectId: chat.projectId,
              chatId: chat.chatId,
            },
          },
        };
  }
  if (trigger !== 'project_new_chat_started')
    throw new Error('Trigger/address mismatch');
  const scope = projectChatWatcherScopeSchema.parse(address);
  if (target.projectType === 'code' && scope.taskId !== undefined) {
    return {
      store: 'v1',
      legacy: {
        trigger: 'worktree_new_chat_started',
        target: {
          kind: 'worktree_chat_scope',
          projectId: scope.projectId,
          worktreeId: scope.taskId,
        },
      },
    };
  }
  if (target.projectType === 'cowork' && scope.taskId === undefined) {
    return {
      store: 'v1',
      legacy: {
        trigger: 'standalone_new_chat_started',
        target: { kind: 'standalone_chat_project', projectId: scope.projectId },
      },
    };
  }
  return { store: 'sidecar' };
}

/** Reverse adapter for a newly validated entry; preserves setup metadata. */
export function canonicalChatWatcherToLegacy(
  entry: CanonicalChatWatcherEntry,
  projectType: ProjectType,
): ChatWatcherStore {
  const target: ResolvedChatWatcherTarget =
    'projectId' in entry.target
      ? { kind: 'project', projectType, address: entry.target }
      : { kind: 'bot', address: entry.target };
  const encoding = storeFor(entry.trigger, target);
  if (encoding.store === 'sidecar') return encoding;
  const metadata = {
    label: entry.label,
    followUpInstruction: entry.followUpInstruction,
    allowDuplicate: entry.allowDuplicate,
  };
  if (
    'armForNextCompletion' in entry &&
    (encoding.legacy.trigger === 'worktree_chat_completion' ||
      encoding.legacy.trigger === 'standalone_chat_completion')
  ) {
    return {
      store: 'v1',
      legacy: {
        ...encoding.legacy,
        ...metadata,
        armForNextCompletion: entry.armForNextCompletion,
      },
    };
  }
  return { store: 'v1', legacy: { ...encoding.legacy, ...metadata } };
}

export type LegacyChatWatcherResolution =
  | { ok: true; entry: CanonicalChatWatcherEntry }
  | { ok: false; reason: 'migration_required' };

/** The caller supplies trusted, already-resolved parent and project type. */
export function legacyChatWatcherToCanonical(
  legacy: UnresolvedLegacyChatWatcher,
  resolved: ResolvedChatWatcherTarget,
): LegacyChatWatcherResolution {
  if (resolved.kind !== 'project')
    return { ok: false, reason: 'migration_required' };
  const completion =
    legacy.trigger === 'worktree_chat_completion' ||
    legacy.trigger === 'standalone_chat_completion';
  const trigger = completion
    ? 'project_task_chat_completion'
    : 'project_new_chat_started';
  let encoding: ChatWatcherStore;
  try {
    encoding = storeFor(trigger, resolved);
  } catch {
    return { ok: false, reason: 'migration_required' };
  }
  if (encoding.store !== 'v1' || encoding.legacy.trigger !== legacy.trigger)
    return { ok: false, reason: 'migration_required' };
  const expected = encoding.legacy.target;
  const actual = legacy.target;
  if (
    expected.kind !== actual.kind ||
    expected.projectId !== actual.projectId ||
    ('worktreeId' in expected &&
      (!('worktreeId' in actual) ||
        actual.worktreeId !== expected.worktreeId)) ||
    ('chatId' in expected &&
      (!('chatId' in actual) || actual.chatId !== expected.chatId))
  ) {
    return { ok: false, reason: 'migration_required' };
  }
  const common = {
    label: legacy.label,
    followUpInstruction: legacy.followUpInstruction,
    allowDuplicate: legacy.allowDuplicate,
  };
  if (
    completion &&
    'chatId' in resolved.address &&
    resolved.address.taskId !== undefined
  ) {
    return {
      ok: true,
      entry: {
        ...common,
        trigger: 'project_task_chat_completion',
        target: resolved.address,
        armForNextCompletion: legacy.armForNextCompletion,
      },
    };
  }
  if (!completion)
    return {
      ok: true,
      entry: {
        ...common,
        trigger: 'project_new_chat_started',
        target: resolved.address,
      },
    };
  return { ok: false, reason: 'migration_required' };
}

/** Call after legacy resolution; recipient/context is supplied by main. */
export function canonicalChatWatcherEquivalenceKey(
  entry: CanonicalChatWatcherEntry,
  recipientKey = '',
): string {
  const target = entry.target;
  return JSON.stringify([
    recipientKey,
    entry.trigger,
    'projectId' in target ? target.projectId : target.botId,
    target.taskId ?? null,
    'chatId' in target ? target.chatId : null,
  ]);
}
export function publicTargetKind(
  trigger: CanonicalChatWatcherTrigger,
): PublicChatWatcherTargetKind {
  switch (trigger) {
    case 'project_task_chat_completion':
      return 'project_task_chat';
    case 'project_new_chat_started':
      return 'project_chat_scope';
    case 'bot_task_chat_completion':
      return 'bot_task_chat';
    case 'bot_new_chat_started':
      return 'bot_chat_scope';
  }
}

export interface ActiveChatInputProvider {
  getActiveChatInput(address: CanonicalChatAddress): Promise<{
    inputId?: string;
    state: 'active' | 'pending' | 'idle' | 'unknown';
  }>;
}
/**
 * Target is the receiving root chat, or null when it has no canonical address.
 * Only chat watcher deliveries need one; others pass through.
 */
export type WatcherDeliveryIngressCheck = (
  deliveryId: string,
  target: CanonicalChatAddress | null,
) => Promise<{ allowed: true } | ({ allowed: false } & ChatWatcherHeldOutcome)>;
export type TrustedChatWatcherRecipient = {
  destination: AppAdvisorWatcherDestination;
  recipient: { kind: 'root' } | { kind: 'delegate'; delegationId: string };
};
/** Legacy entries arrive already normalized; the batch applies atomically in order. */
export type CanonicalChatWatcherSetupInput = TrustedChatWatcherRecipient & {
  watchers: Array<
    CanonicalChatWatcherEntry | SetupAppAdvisorWatchersInput['watchers'][number]
  >;
  /** The creating tool call, so scoped DeleteWatchers can cancel these rows. */
  createdByToolUseId?: string;
};
/** Never include target-derived information on an unavailable projection. */
export type CanonicalChatWatcherProjection = {
  id: string;
  trigger: CanonicalChatWatcherTrigger;
} & (
  | {
      availability: ChatWatcherAvailability;
      target?: never;
      targetKind?: never;
      label?: never;
      followUpInstruction?: never;
      deliveryError?: never;
      status?: never;
    }
  | {
      availability?: never;
      status: AppAdvisorWatcherStatus;
      target: CanonicalChatWatcherEntry['target'];
      targetKind: PublicChatWatcherTargetKind;
      label: string;
      followUpInstruction?: string;
      createdAt: string;
      completedAt?: string;
      firedAt?: string;
      deliveryError?: string;
    }
);
export type CanonicalChatWatcherSetupResult =
  | {
      ok: true;
      results: Array<{
        status: 'created' | 'deduped';
        watcher: CanonicalChatWatcherProjection | AppAdvisorWatcherSummary;
      }>;
    }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'unsupported'
        | 'invalid_arguments'
        | ChatWatcherAvailability;
      error: string;
      rejectedIndex?: number;
    };
export interface CanonicalChatWatcherService {
  setupCanonicalChatWatchers(
    input: CanonicalChatWatcherSetupInput,
  ): Promise<CanonicalChatWatcherSetupResult>;
  projectCanonicalChatWatchers(
    recipient: TrustedChatWatcherRecipient,
  ): Promise<CanonicalChatWatcherProjection[]>;
}
