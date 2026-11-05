import { hasLiveDelegations } from './activity';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { applyDelegationTranscriptEvent } from '@canopy/agent-transcript';
import {
  DELEGATION_TRANSCRIPT_CHAT_LOG,
  type AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import { persistedDelegationSnapshot } from './card-persistence';
import {
  delegationPhase,
  projectStoredDelegationSnapshot,
  type StoredDelegation,
} from '@canopy/desktop-shared/node/delegation/broker';
import {
  legacyCurrentTranscript,
  legacyPrefixView,
} from '@canopy/desktop-shared/node/delegation/record-v3';
import {
  readDelegationRecordMetadata,
  type DelegationReadMetadataSource,
  type DelegationRecordReadMetadata,
} from '@canopy/desktop-shared/node/delegation/record-read-metadata';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import type {
  ArchivedChatsFile,
  ChatCoreMutation,
  ChatTabsFile,
  PersistedChatTab,
  PersistedChatMessage,
} from '@canopy/desktop-shared/types';
import { getWorktreeDataDir } from '../../lib/paths';
import type { DelegationRecoveryLoaderOptions } from './record-reader-contract';

export interface DelegationReplayEvidence {
  readonly anchored: ReadonlySet<number>;
  readonly loggedRuns: ReadonlySet<string>;
}

/**
 * Summarize one leased parent scan. Keep only retained-run lookup keys and
 * matches, never parent messages or a transcript-sized message-id index.
 * The caller excludes committed-id active echoes before this consumer runs.
 * Stream descriptor overlays need not be expanded: they preserve the anchor
 * and storage identity fields inspected here.
 */
export async function scanDelegationReplayEvidence(
  messages: AsyncIterable<PersistedChatMessage>,
  transcripts: readonly AgentDelegationTranscript[],
): Promise<DelegationReplayEvidence> {
  const turns = new Map<string, number[]>();
  const tools = new Map<string, number[]>();
  const delegations = new Map<string, number[]>();
  const wantedRuns = new Set<string>();
  const add = (
    map: Map<string, number[]>,
    key: string,
    index: number,
  ): void => {
    const indices = map.get(key);
    if (indices) indices.push(index);
    else map.set(key, [index]);
  };
  transcripts.forEach((transcript, index): void => {
    add(turns, transcript.parentTurnId, index);
    add(tools, transcript.parentToolCallId, index);
    add(delegations, transcript.delegationId, index);
    wantedRuns.add(
      `${transcript.delegationId}:${String(transcript.runGeneration)}`,
    );
  });
  const anchored = new Set<number>();
  const loggedRuns = new Set<string>();
  const match = (indices: readonly number[] | undefined): void => {
    for (const index of indices ?? []) anchored.add(index);
  };
  // Do not stop after the first anchor: a later card may supply a logged
  // storage marker for that same run, including an older run generation.
  for await (const message of messages) {
    match(turns.get(message.id));
    for (const block of message.blocks) {
      if (block.type === 'tool_use') match(tools.get(block.toolUseId));
      if (block.type !== 'delegated_agent_call') continue;
      match(delegations.get(block.delegationId));
      if (block.transcriptStore !== DELEGATION_TRANSCRIPT_CHAT_LOG) continue;
      const key = `${block.delegationId}:${String(block.runGeneration)}`;
      if (wantedRuns.has(key)) loggedRuns.add(key);
    }
  }
  return { anchored, loggedRuns };
}

export function delegationTranscriptHasRetainedAnchor(
  messages: readonly PersistedChatMessage[],
  transcript: {
    delegationId: string;
    parentTurnId: string;
    parentToolCallId: string;
  },
): boolean {
  return messages.some(
    (message) =>
      message.id === transcript.parentTurnId ||
      message.blocks.some(
        (block) =>
          (block.type === 'tool_use' &&
            block.toolUseId === transcript.parentToolCallId) ||
          (block.type === 'delegated_agent_call' &&
            block.delegationId === transcript.delegationId),
      ),
  );
}

/** Restore retained evidence without constructing a broker, runner, or delivery transport. */
export function delegationRecoveryMutations(
  scope: { projectId: string; worktreeId: string },
  tabs: ChatTabsFile,
  archives: ArchivedChatsFile,
  records: readonly StoredDelegation[],
  readMetadata?: DelegationReadMetadataSource,
): ChatCoreMutation[] {
  const scopedRecords: Array<{
    record: StoredDelegation;
    readMetadata?: DelegationRecordReadMetadata;
  }> = [];
  for (const record of records) {
    if (
      record.parent.projectId !== scope.projectId ||
      record.parent.worktreeId !== scope.worktreeId
    )
      continue;
    try {
      const recordMetadata = readMetadata
        ? readDelegationRecordMetadata(readMetadata, record)
        : undefined;
      scopedRecords.push({
        record,
        ...(recordMetadata ? { readMetadata: recordMetadata } : {}),
      });
    } catch (error) {
      logMainProcessWarn(
        '[delegation] Unable to validate retained child transcript read metadata',
        error,
      );
    }
  }
  const recover = (tab: PersistedChatTab): PersistedChatTab => {
    // A chat no record names is unchanged, and a caller may not have read it.
    if (
      tab.kind === 'file' ||
      !scopedRecords.some(({ record }) => record.parent.chatId === tab.id)
    )
      return tab;
    let state = {
      messages: tab.messages,
      status: 'idle' as const,
      error: null,
      planMode: false,
    };
    for (const entry of scopedRecords) {
      const { record, readMetadata: recordReadMetadata } = entry;
      if (record.parent.chatId !== tab.id) continue;
      const recordedTurnId =
        record.parent.userMessageId ?? record.parent.turnId;
      const toolIndex = tab.messages.findIndex((message) =>
        message.blocks.some(
          (block) =>
            block.type === 'tool_use' &&
            block.toolUseId === record.parent.toolCallId,
        ),
      );
      const parentTurnId = tab.messages.some(
        (message) => message.id === recordedTurnId,
      )
        ? recordedTurnId
        : tab.messages
            .slice(0, toolIndex + 1)
            .reverse()
            .find((message) => message.role === 'user')?.id;
      // Old Codex records carry only a provider turn id; resolve their host turn from the retained native call.
      // Cleared/deleted turns must not be resurrected by the independent evidence registry.
      if (
        !parentTurnId &&
        !tab.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'delegated_agent_call' &&
              block.delegationId === record.state.delegationId,
          ),
        )
      )
        continue;
      // A card whose children are in the chat's delegate log is recovered
      // as a card patch: its children stay in the log. Each run generation
      // keeps its own storage; an earlier one may still hold child rows.
      const logged = (runGeneration: number): boolean =>
        state.messages.some((message) =>
          message.blocks.some(
            (block) =>
              block.type === 'delegated_agent_call' &&
              block.delegationId === record.state.delegationId &&
              block.runGeneration === runGeneration &&
              block.transcriptStore === DELEGATION_TRANSCRIPT_CHAT_LOG,
          ),
        );
      const asLogged = <T extends AgentDelegationTranscript>(
        delegation: T,
      ): AgentDelegationTranscript =>
        logged(delegation.runGeneration)
          ? {
              ...delegation,
              snapshot: persistedDelegationSnapshot(delegation.snapshot),
              transcriptStore: DELEGATION_TRANSCRIPT_CHAT_LOG,
              transcriptMode: 'patch',
              transcript: [],
            }
          : delegation;
      for (const prior of legacyPrefixView(record).history ?? []) {
        if (!delegationTranscriptHasRetainedAnchor(tab.messages, prior))
          continue;
        const recovered = applyDelegationTranscriptEvent(state, {
          type: 'canopy_delegation',
          delegation: asLogged(prior),
        });
        state = { ...state, messages: recovered.messages };
      }
      // A stream-backed current generation has no recovery-owned outcome. Its
      // legacy prefix above remains recoverable, but startup must not invent a
      // new interruption or cancellation for the stream generation.
      if (recordReadMetadata?.current.store === 'stream') continue;
      const snapshot = {
        ...projectStoredDelegationSnapshot(record),
        approvalPending: false,
      };
      const interrupted =
        snapshot.status === 'pending' || snapshot.status === 'running';
      // Work that never reached a native runtime (still queued for a slot, or
      // reserved but never dispatched) is cleanly cancelled rather than shown
      // as an uncertain interruption; either way it settles as idle.
      const neverDispatched =
        delegationPhase(record) === 'queued' ||
        (record.state.status === 'pending' &&
          record.launch.phase === 'reserved');
      const recoveredSnapshot: typeof snapshot = interrupted
        ? neverDispatched
          ? {
              ...snapshot,
              status: 'cancelled',
              stopReason: 'shutdown',
              cancelledByUser: false,
              phase: 'idle',
              error: undefined,
            }
          : {
              ...snapshot,
              status: 'interrupted',
              phase: 'idle',
              error: {
                code: 'launch_uncertain',
                message:
                  'The previous host stopped before child completion was confirmed.',
                retryable: false,
              },
            }
        : snapshot;
      const next = applyDelegationTranscriptEvent(state, {
        type: 'canopy_delegation',
        delegation: asLogged({
          delegationId: record.state.delegationId,
          runGeneration: record.state.runGeneration,
          sequence:
            (record.transcriptRevision ?? record.state.sequence) +
            (interrupted ? 1 : 0),
          createdAt: record.createdAt,
          parentHarnessId: record.parent.harnessId,
          parentTurnId: parentTurnId ?? recordedTurnId,
          parentToolCallId: record.parent.toolCallId,
          task: record.task,
          transcript: legacyCurrentTranscript(record),
          snapshot: recoveredSnapshot,
        }),
      });
      state = { ...state, messages: next.messages };
    }
    return state.messages === tab.messages
      ? tab
      : { ...tab, messages: state.messages };
  };
  const mutations: ChatCoreMutation[] = [];
  for (const tab of tabs.tabs) {
    const updated = recover(tab);
    if (updated !== tab)
      mutations.push({
        type: 'messages.replaced',
        chatId: tab.id,
        messages: updated.messages,
        removedMessageIds: [],
      });
  }
  for (const entry of archives.archived) {
    const updated = recover(entry.tab);
    if (updated !== entry.tab)
      mutations.push({
        type: 'archive.upserted',
        entry: { ...entry, tab: updated },
      });
  }
  return mutations;
}

async function retainedDelegationRecords(scope: {
  projectId: string;
  worktreeId: string;
}): Promise<StoredDelegation[]> {
  const directory = path.join(
    getWorktreeDataDir(scope.projectId, scope.worktreeId),
    'delegation',
    'runs',
  );
  await stat(directory);
  const records = await new FileDelegationStorage(directory).load();
  return records.filter(
    (record) => !hasLiveDelegations(record.parent.sessionKey),
  );
}

function warnUnrecoverable(error: unknown): void {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  )
    return;
  // The optional child registry must not make an otherwise valid chat unreadable.
  logMainProcessWarn(
    '[delegation] Unable to recover retained child transcript',
    error,
  );
}

/** The records startup recovery may restore; none when they cannot be read. */
export async function loadDelegationRecoveryRecords(scope: {
  projectId: string;
  worktreeId: string;
}): Promise<StoredDelegation[]> {
  try {
    return await retainedDelegationRecords(scope);
  } catch (error) {
    warnUnrecoverable(error);
    return [];
  }
}

/** Pass `records` from loadDelegationRecoveryRecords to read the registry once. */
export async function loadDelegationRecoveryMutations(
  scope: { projectId: string; worktreeId: string },
  tabs: ChatTabsFile,
  archives: ArchivedChatsFile,
  options?: DelegationRecoveryLoaderOptions,
  records?: readonly StoredDelegation[],
): Promise<ChatCoreMutation[]> {
  try {
    return delegationRecoveryMutations(
      scope,
      tabs,
      archives,
      records ?? (await retainedDelegationRecords(scope)),
      options?.readMetadata,
    );
  } catch (error) {
    warnUnrecoverable(error);
    return [];
  }
}

/** Avoid loading every transcript on ordinary cold scopes with no retained children. */
export async function hasDelegationRecoveryRecords(scope: {
  projectId: string;
  worktreeId: string;
}): Promise<boolean> {
  try {
    const directory = path.join(
      getWorktreeDataDir(scope.projectId, scope.worktreeId),
      'delegation',
      'runs',
    );
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return false;
    logMainProcessWarn(
      '[delegation] Unable to inspect optional child registry',
      error,
    );
    return false;
  }
}
