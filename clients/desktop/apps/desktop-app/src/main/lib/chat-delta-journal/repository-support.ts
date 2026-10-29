/**
 * Delta-journal plumbing the chat state repository applies to every scope:
 * the backend's journal settings from the repository's options, and the
 * content-free session diagnostics it records. Pure; the repository owns
 * every effect.
 */
import type { ChatStateV2BackendOptions } from '../../services/chat-state-v2-backend';
import type {
  ChatScopeKey,
  ChatStateStorageDiagnostic,
} from '../../services/chat-state-contracts';
import type { DeltaJournalDiagnostic } from './writer';

/** The repository options that tune a scope's delta journal. */
export interface DeltaJournalRepositorySettings {
  deltaJournalCheckpointBytes?: number;
  deltaJournalLargeRecordBytes?: number;
  deltaJournalPromotionRetryMs?: number;
  deltaJournalPromotionRetryLimit?: number;
}

export function deltaJournalBackendOptions(
  settings: DeltaJournalRepositorySettings,
  onDiagnostic: (diagnostic: DeltaJournalDiagnostic) => void,
): NonNullable<ChatStateV2BackendOptions['deltaJournal']> {
  return {
    onDiagnostic,
    ...(settings.deltaJournalCheckpointBytes !== undefined
      ? { checkpointJournalBytes: settings.deltaJournalCheckpointBytes }
      : {}),
    ...(settings.deltaJournalLargeRecordBytes !== undefined
      ? { largeRecordBytes: settings.deltaJournalLargeRecordBytes }
      : {}),
    promotionRetry: {
      delayMs: settings.deltaJournalPromotionRetryMs,
      limit: settings.deltaJournalPromotionRetryLimit,
    },
  };
}

/** A promotion or demotion outcome, as a session-events storage record. */
export function deltaJournalLifecycleDiagnostic(
  scope: ChatScopeKey,
  kind: ChatStateStorageDiagnostic['kind'],
): ChatStateStorageDiagnostic {
  return {
    kind,
    occurredAt: new Date().toISOString(),
    storageAuthority: 'v2',
    ...scope,
    journalBytes: 0,
  };
}

/** A writer diagnostic, as a session-events storage record. */
export function deltaJournalWriterDiagnostic(
  scope: ChatScopeKey,
  diagnostic: DeltaJournalDiagnostic,
): ChatStateStorageDiagnostic {
  return {
    occurredAt: new Date().toISOString(),
    storageAuthority: 'v2',
    ...scope,
    ...diagnostic,
  };
}
