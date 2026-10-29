import type { ThinkingLevel } from '../thinking';

/** Advisory discovery only; launch always revalidates the exact route and authority. */
export interface DelegationModelChoice {
  readonly modelId: string;
  readonly label: string;
  readonly harnessId: string;
  readonly runtimeKind: string;
  readonly supportedThinkingLevels: readonly ThinkingLevel[];
  readonly capabilities: readonly string[];
  readonly availability: 'available' | 'unavailable' | 'unknown';
  readonly authState: 'ready' | 'required' | 'unknown';
  readonly disabledReason?: string;
}

export interface DelegationModelDiscovery {
  readonly models: readonly DelegationModelChoice[];
  readonly recommendedModelId?: string;
  readonly truncated: boolean;
}

export type ManagedDelegationMode = 'off' | 'explicit-only' | 'proactive';

export function normalizeManagedDelegationMode(
  value: unknown,
): ManagedDelegationMode {
  return value === 'explicit-only' || value === 'proactive' ? value : 'off';
}

export const DEFAULT_MANAGED_DELEGATION_MAX_CONCURRENT = 5;
/**
 * Highest “Maximum concurrent subagents” setting and application-wide cap on
 * concurrently running delegated tasks.
 */
export const MAX_MANAGED_DELEGATION_CONCURRENCY = 64;

export const DEFAULT_MANAGED_DELEGATION_MAX_DEPTH = 1;
export const MAX_MANAGED_DELEGATION_DEPTH = 10;

export function normalizeManagedDelegationMaxDepth(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MANAGED_DELEGATION_DEPTH
    ? value
    : DEFAULT_MANAGED_DELEGATION_MAX_DEPTH;
}

export function normalizeManagedDelegationMaxConcurrent(
  value: unknown,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_MANAGED_DELEGATION_CONCURRENCY
    ? value
    : DEFAULT_MANAGED_DELEGATION_MAX_CONCURRENT;
}
