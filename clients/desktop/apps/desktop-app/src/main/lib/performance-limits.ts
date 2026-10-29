import type { PreferencesData } from '@canopy/desktop-shared/types';
import {
  DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE,
  DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
  DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED,
  DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
  DEFAULT_MAX_ACTIVE_CHAT_TURNS,
  DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS,
} from '@canopy/desktop-shared/constants/preferences';

export interface PerformanceLimits {
  maxActiveChatTurns: number | null;
  maxActivePipelineExecutions: number | null;
  memoryPressureGuardEnabled: boolean;
  bypassCodexAppServerIdleTimeoutUnderCriticalPressure: boolean;
  memoryPressureWarningThresholdBytes: number;
  memoryPressureCriticalThresholdBytes: number;
}

const DEFAULT_PERFORMANCE_LIMITS: PerformanceLimits = {
  maxActiveChatTurns: DEFAULT_MAX_ACTIVE_CHAT_TURNS,
  maxActivePipelineExecutions: DEFAULT_MAX_ACTIVE_PIPELINE_EXECUTIONS,
  memoryPressureGuardEnabled: DEFAULT_MEMORY_PRESSURE_GUARD_ENABLED,
  bypassCodexAppServerIdleTimeoutUnderCriticalPressure:
    DEFAULT_BYPASS_CODEX_APP_SERVER_IDLE_TIMEOUT_UNDER_CRITICAL_PRESSURE,
  memoryPressureWarningThresholdBytes:
    DEFAULT_MEMORY_PRESSURE_WARNING_THRESHOLD_BYTES,
  memoryPressureCriticalThresholdBytes:
    DEFAULT_MEMORY_PRESSURE_CRITICAL_THRESHOLD_BYTES,
};

let currentPerformanceLimits: PerformanceLimits = {
  ...DEFAULT_PERFORMANCE_LIMITS,
};
let performanceLimitsVersion = 0;

export function getPerformanceLimits(): PerformanceLimits {
  return { ...currentPerformanceLimits };
}

export function getPerformanceLimitsVersion(): number {
  return performanceLimitsVersion;
}

export function updatePerformanceLimits(limits: PerformanceLimits): void {
  currentPerformanceLimits = {
    maxActiveChatTurns: limits.maxActiveChatTurns,
    maxActivePipelineExecutions: limits.maxActivePipelineExecutions,
    memoryPressureGuardEnabled: limits.memoryPressureGuardEnabled,
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure:
      limits.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    memoryPressureWarningThresholdBytes:
      limits.memoryPressureWarningThresholdBytes,
    memoryPressureCriticalThresholdBytes:
      limits.memoryPressureCriticalThresholdBytes,
  };
  performanceLimitsVersion += 1;
}

export function updatePerformanceLimitsFromPreferences(
  preferences: Pick<
    PreferencesData,
    | 'maxActiveChatTurns'
    | 'maxActivePipelineExecutions'
    | 'memoryPressureGuardEnabled'
    | 'bypassCodexAppServerIdleTimeoutUnderCriticalPressure'
    | 'memoryPressureWarningThresholdBytes'
    | 'memoryPressureCriticalThresholdBytes'
  >,
): void {
  updatePerformanceLimits({
    maxActiveChatTurns: preferences.maxActiveChatTurns,
    maxActivePipelineExecutions: preferences.maxActivePipelineExecutions,
    memoryPressureGuardEnabled: preferences.memoryPressureGuardEnabled,
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure:
      preferences.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    memoryPressureWarningThresholdBytes:
      preferences.memoryPressureWarningThresholdBytes,
    memoryPressureCriticalThresholdBytes:
      preferences.memoryPressureCriticalThresholdBytes,
  });
}

export function resetPerformanceLimitsForTests(): void {
  updatePerformanceLimits(DEFAULT_PERFORMANCE_LIMITS);
}
