import { LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE } from '@canopy/desktop-shared/types/local-memory';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  getStructuredHelperQueryErrorUsage,
  StructuredHelperQueryError,
  type StructuredHelperQueryResult,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import {
  resolveHelperInvocation,
  type HelperInvocation,
} from '../../ollama/helper-invocation';
import { markObservedHelperTaskAiCreditsRouted } from '../../lib/helper-observed-task';
import {
  codexStructuredHelperRunner,
  runStructuredHelper,
  structuredHelperReportOnlyPermission,
} from '../../integration/structured-helper-dispatch';
import type { LocalMemoryHelperModel } from './helper-model';
import { isLocalMemoryModelBlockedByPolicy } from './model-policy';
import { ensureOwnerOnlyDir } from './store';

/**
 * Consolidation reads up to a few hundred KB of memory and rewrites the whole
 * index, which takes far longer than the generic background-worker backstop
 * on reasoning models.
 */
export const LOCAL_MEMORY_HELPER_TIMEOUT_MS = 25 * 60_000;

export interface LocalMemoryStructuredHelperOptions<T> {
  /** Observed task already started by the caller; routing is recorded on it. */
  taskKey: string;
  kind: string;
  label: string;
  /** Working directory: the memory scope the helper reports on. */
  scopeDir: string;
  workspaceId?: string;
  /**
   * Owner the background work is bound to. When present it replaces the
   * owner resolved from `workspaceId` and navigation, for both the policy
   * check and the invocation. Omit it to keep that resolution.
   */
  workOwner?: WorkOwner | null;
  /**
   * Whether local memory is on for this run. Defaults to `true`; a caller
   * that runs with local memory off passes `false` so the runner does not
   * claim it is on.
   */
  localMemoryEnabled?: boolean;
  helperModel: LocalMemoryHelperModel;
  systemPrompt: string;
  userMessage: string;
  schema: Record<string, unknown>;
  /** Claude terminal workers validate against this instead of `schema`. */
  resultValidationSchema?: Record<string, unknown>;
  onResultRejected?: (payload: unknown) => void;
  isResult: (value: unknown) => value is T;
  /** Defaults to {@link LOCAL_MEMORY_HELPER_TIMEOUT_MS}. */
  timeoutMs?: number;
}

function timeoutError(timeoutMs: number, cause: unknown): Error {
  const message = `Local memory helper timed out after ${Math.round(timeoutMs / 60_000)} minutes.`;
  const usage = getStructuredHelperQueryErrorUsage(cause);
  return usage
    ? new StructuredHelperQueryError(message, usage)
    : new Error(message);
}

/**
 * Runs one report-only structured helper for local memory on the user's
 * local memory model: no tools, no plugins, only the structured result.
 * Refuses a model the stored organization policy blocks. The caller owns the
 * observed task's start and finalization.
 */
export async function runLocalMemoryStructuredHelper<T>(
  options: LocalMemoryStructuredHelperOptions<T>,
): Promise<StructuredHelperQueryResult<T>> {
  const { model, thinkingLevel, modelConfig } = options.helperModel;
  // `undefined` (including a spread one) keeps the workspace owner; `null`
  // is an explicit override.
  const ownerOverride =
    options.workOwner !== undefined ? { workOwner: options.workOwner } : null;
  const blocked = ownerOverride
    ? await isLocalMemoryModelBlockedByPolicy(
        model,
        options.workspaceId,
        ownerOverride,
      )
    : await isLocalMemoryModelBlockedByPolicy(model, options.workspaceId);
  if (blocked) {
    throw new Error(LOCAL_MEMORY_MODEL_BLOCKED_MESSAGE);
  }
  const localMemoryEnabled = options.localMemoryEnabled ?? true;
  // The helper process starts in the scope folder, and a spawn into a
  // missing working directory fails as ENOENT. A user who has never saved a
  // memory has no user scope folder yet.
  await ensureOwnerOnlyDir(options.scopeDir);
  const timeoutMs = options.timeoutMs ?? LOCAL_MEMORY_HELPER_TIMEOUT_MS;
  const abortController = new AbortController();
  const deadline = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  deadline.unref?.();
  let invocation: HelperInvocation | undefined;
  try {
    invocation = await resolveHelperInvocation(model, undefined, {
      allowNoNativeAuthFallback: false,
      workspaceId: options.workspaceId,
      ...(ownerOverride ?? {}),
      signal: abortController.signal,
    });
    markObservedHelperTaskAiCreditsRouted(
      options.taskKey,
      invocation.aiCreditsRouted,
      invocation.accountProxyRouted === true,
    );
    if (invocation.harness === 'codex') {
      return await codexStructuredHelperRunner.run<T>({
        repoPath: options.scopeDir,
        model: invocation.sdkModel ?? model,
        systemPrompt: options.systemPrompt,
        userMessage: options.userMessage,
        combinedPrompt: options.userMessage,
        permissionMode: 'report-only',
        schema: options.schema,
        thinkingLevel,
        modelConfig,
        workspaceId: options.workspaceId,
        localMemoryEnabled,
        isResult: options.isResult,
        codexConfigOverride: invocation.codexConfig,
        waitForQuotaRecovery: invocation.waitForQuotaRecovery,
        abortController,
      });
    }
    return await runStructuredHelper<T>({
      kind: options.kind,
      label: options.label,
      repoPath: options.scopeDir,
      model: invocation.sdkModel ?? model,
      provider: invocation.providerType === 'ollama' ? 'ollama' : 'claude',
      executionHarness: invocation.harness,
      maxTurns: 10,
      systemPrompt: options.systemPrompt,
      userMessage: options.userMessage,
      schema: options.schema,
      ...(options.resultValidationSchema
        ? { resultValidationSchema: options.resultValidationSchema }
        : {}),
      ...(options.onResultRejected
        ? { onResultRejected: options.onResultRejected }
        : {}),
      thinkingLevel,
      workspaceId: options.workspaceId,
      localMemoryEnabled,
      isResult: options.isResult,
      claudeEnvOverride: invocation.envOverride,
      waitForQuotaRecovery: invocation.waitForQuotaRecovery,
      permission: structuredHelperReportOnlyPermission(),
      abortController,
      timeoutMs,
    });
  } catch (error) {
    if (abortController.signal.aborted) throw timeoutError(timeoutMs, error);
    throw error;
  } finally {
    clearTimeout(deadline);
    invocation?.dispose();
  }
}
