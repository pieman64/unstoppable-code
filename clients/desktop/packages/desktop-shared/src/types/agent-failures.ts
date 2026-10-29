import type { AgentProviderType } from '../types';
import type { ModelHarness } from './model-harnesses';
import type { PipelineStatusReasonCode } from './pipeline';

export type AgentFailureAccountScope = 'native' | 'ai_credits' | 'local';

export interface AgentFailureClassificationContext {
  provider: AgentProviderType;
  model?: string;
  accountScope: AgentFailureAccountScope;
  events?: readonly unknown[];
  error?: unknown;
  now?: Date;
}

export interface AgentFailureClassification {
  kind:
    | 'provider_authentication_required'
    | 'provider_usage_limit'
    | 'provider_temporarily_unavailable';
  code: PipelineStatusReasonCode;
  provider: AgentProviderType;
  account_scope: AgentFailureAccountScope;
  model?: string;
  resets_at?: string;
  diagnostic_message: string;
}

export interface TransientAgentRetryNotice {
  /** 1-based attempt that just failed. */
  attempt: number;
  /** 1-based attempt that will run after the delay. */
  nextAttempt: number;
  delayMs: number;
  classification: AgentFailureClassification;
}

export interface TransientAgentRetryOptions<T> {
  provider: AgentProviderType;
  model?: string;
  accountScope?: AgentFailureAccountScope;
  signal?: AbortSignal;
  delaysMs?: readonly number[];
  /** Host-owned proxy capacity wait; native quotas retain their normal failure path. */
  waitForQuotaRecovery?: (
    failure: AgentFailureClassification,
    signal?: AbortSignal,
  ) => Promise<void>;
  runAttempt: (
    captureEvent: (event: unknown) => void,
    attempt: number,
  ) => Promise<T>;
  onRetry?: (notice: TransientAgentRetryNotice) => void | Promise<void>;
}

export interface AgentActionFailureMetadata {
  version: 1;
  provider: AgentProviderType;
  /** Execution harness captured for this attempt. Absent on legacy metadata. */
  agent_harness?: ModelHarness;
  session_id?: string;
  had_agent_activity: boolean;
  transcript_file?: string;
  classification?: AgentFailureClassification;
  message: string;
}
