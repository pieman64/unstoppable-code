import {
  clampThinkingLevelForModel,
  type AgentModelConfig,
  type ThinkingLevel,
} from '../types';
import {
  DEFAULT_CODEX_SPEED,
  readCodexSpeedRecord,
  type CodexSpeed,
} from './codex-speed';

export type CodexConfigValue =
  | null
  | boolean
  | number
  | string
  | CodexConfigValue[]
  | { [key: string]: CodexConfigValue | undefined };

export type CodexConfig = {
  [key: string]: CodexConfigValue | undefined;
};

export type CodexReasoningEffort =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface CodexThreadOptions {
  model?: string;
  workingDirectory?: string;
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  skipGitRepoCheck?: boolean;
  webSearchMode?: 'disabled' | 'cached' | 'live';
  modelReasoningEffort?: CodexReasoningEffort;
}

export function isCodexConfig(value: unknown): value is CodexConfig {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mapThinkingToReasoningEffort(
  level: ThinkingLevel,
  model?: string,
  aiCreditsRouted = false,
): CodexReasoningEffort {
  const clamped = clampThinkingLevelForModel(
    level,
    model,
    'codex',
    aiCreditsRouted,
  );
  switch (clamped) {
    case 'off':
      return 'none';
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'xhigh':
      return 'xhigh';
    case 'max':
      return 'max';
    case 'ultra':
      return 'xhigh';
    default:
      return 'high';
  }
}

/** App-server service-tier request values for each Codex speed. */
export type CodexServiceTier = 'default' | 'priority' | 'ultrafast';

/**
 * Wire mapping: Regular → `default`, Fast → `priority`, Ultra fast →
 * `ultrafast`. Always explicit: `default` must clear a resumed thread's
 * inherited tier, so callers never translate Regular into an omitted field.
 */
export function codexServiceTierForSpeed(speed: CodexSpeed): CodexServiceTier {
  switch (speed) {
    case 'fast':
      return 'priority';
    case 'ultrafast':
      return 'ultrafast';
    case 'standard':
      return 'default';
  }
}

/**
 * Shared service-tier mapper for start, resume, fork, and each turn. Reads the
 * record with canonical precedence (`speed`, then legacy `fastMode`); a record
 * without speed information requests Regular explicitly.
 */
export function codexServiceTierForModelConfig(
  config?: Pick<AgentModelConfig, 'speed' | 'fastMode'> | null,
): CodexServiceTier {
  return codexServiceTierForSpeed(
    readCodexSpeedRecord(config) ?? DEFAULT_CODEX_SPEED,
  );
}
