import type { AgentAuditEventType } from '@canopy/desktop-shared/types';

export type CloudOAuthDiagnosticOutcome =
  | 'state_mismatch'
  | 'missing_code'
  | 'provider_error'
  | 'exchange_failed'
  | 'persist_failed'
  | 'commit_queue_timeout'
  | 'listener_failed'
  | 'browser_open_failed'
  | 'callback_failed'
  | 'timeout'
  | 'cancelled'
  | 'replaced';

export type CloudOAuthDiagnosticStage =
  | 'start'
  | 'browser_opened'
  | 'callback_rejected'
  | 'callback_received'
  | 'exchange'
  | 'persist'
  | 'success';

export type CloudOAuthFailureClass =
  | 'network_error'
  | 'http_error'
  | 'invalid_response';

export type CloudOAuthProviderError =
  | 'access_denied'
  | 'invalid_request'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'unauthorized_client'
  | 'unsupported_response_type'
  | 'other';

export interface TranscriptIndexRecord {
  version: 1;
  projectId: string;
  worktreeId: string;
  entryId: string;
  eventType: AgentAuditEventType;
  startedAt: string;
  transcriptPath: string;
}
