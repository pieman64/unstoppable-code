import {
  query as claudeQuery,
  type SettingSource,
  type SpawnOptions,
  type SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeThinkingOptions,
  clampThinkingLevelForModel,
  getExecutionHarnessForModel,
  getProviderForModel,
  isOllamaModel,
  stripOllamaModelPrefix,
  type AgentModelConfig,
  type AgentProviderType,
  type ResolveEnvironmentRequest,
  type ThinkingLevel,
} from '../types';
import {
  getBundledClaudeBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';
import type { CodexConfig } from './codex-model-config';
import { claudeNativeMemoryOptions } from '../node/lib/native-memory';
import {
  emptyHelperAgentPluginRuntime,
  type HelperAgentPluginRuntime,
} from './helper-agent-plugins';
import {
  extractStructuredToolInput,
  parseStructuredJsonResult,
} from './claude-structured-output';
import type { HelperTranscriptObserver } from './helper-transcript';
import { readHelperUsage, type HelperUsage } from './helper-usage';
import {
  isTransientAgentRetryExhaustedError,
  runWithTransientAgentRetry,
  type TransientAgentRetryNotice,
  type TransientAgentRetryOptions,
} from '../agent-failures/transient-retry';
import {
  AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT,
  readClaudeRetrySessionId,
} from '../agent-failures/resume';

interface StructuredHelperQueryOptions<T> {
  waitForQuotaRecovery?: TransientAgentRetryOptions<T>['waitForQuotaRecovery'];
  repoPath: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  /**
   * Resolved opt-in local memory preference (CAN-1969). When `true`,
   * harness-native memory is suppressed on the helper launch; when `false`,
   * provider defaults apply. Electron-main callers read the preferences file;
   * subprocess callers resolve it via `localMemoryEnabledFromEnv()`.
   */
  localMemoryEnabled: boolean;
  thinkingLevel?: ThinkingLevel;
  modelConfig?: AgentModelConfig;
  workspaceId?: string;
  transcriptObserver?: HelperTranscriptObserver;
  pluginRuntime?: HelperAgentPluginRuntime;
  schema: Record<string, unknown>;
  isResult: (value: unknown) => value is T;
  onTransientRetry?: (
    notice: TransientAgentRetryNotice,
  ) => void | Promise<void>;
}

export interface ClaudeStructuredHelperQueryOptions<
  T,
> extends StructuredHelperQueryOptions<T> {
  provider: 'claude' | 'ollama';
  maxTurns: number;
  abortController?: AbortController;
  claudeEnvOverride?: Record<string, string>;
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  settingSources?: SettingSource[];
  /**
   * Restrict the launch to the MCP servers passed in `pluginRuntime`, ignoring
   * every other source, including the signed-in account's connectors, which
   * `settingSources` does not govern.
   */
  strictMcpConfig?: boolean;
  spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess;
}

export interface CodexStructuredHelperQueryOptions<
  T,
> extends StructuredHelperQueryOptions<T> {
  combinedPrompt: string;
  /**
   * `report-only` keeps structured generation available while denying the
   * model access to workspace/user files, network tools, MCP servers, and
   * selected capabilities. Defaults to the normal read-only helper posture.
   */
  permissionMode?: 'read-only' | 'report-only';
  /**
   * Thread-scoped Codex provider config used when AI Credits routing is
   * active. Plain data resolved in the main process — no
   * boundary violation. When set, `model` should already be the gateway slug.
   */
  codexConfigOverride?: CodexConfig;
  /** Gateway bearer-token env for the routed Codex path. */
  abortController?: AbortController;
  runner: CodexStructuredHelperRunner;
}

export interface StructuredHelperQueryResult<T> {
  value: T | null;
  usage: HelperUsage;
}

export interface CodexStructuredHelperRunner {
  run<T>(
    options: Omit<CodexStructuredHelperQueryOptions<T>, 'runner'>,
  ): Promise<StructuredHelperQueryResult<T>>;
}

export class StructuredHelperQueryError extends Error {
  readonly usage: HelperUsage;

  constructor(message: string, usage: HelperUsage) {
    super(message);
    this.name = 'StructuredHelperQueryError';
    this.usage = usage;
  }
}

export function getStructuredHelperQueryErrorUsage(
  error: unknown,
): HelperUsage | undefined {
  const directUsage = readHelperUsage(error);
  if (directUsage) {
    return directUsage;
  }
  if (isTransientAgentRetryExhaustedError(error)) {
    return getStructuredHelperQueryErrorUsage(error.originalError);
  }
  return undefined;
}

/**
 * Provider for helper transcript/runner purposes; never throws.
 *
 * AI Credits routing hands helpers a gateway slug (for example
 * `anthropic/claude-sonnet-5.5`) that is not a registry model id, so
 * `requireProviderForModel` would reject it before the first attempt. Gateway
 * slugs are attributed to the harness that runs them instead (CAN-3866).
 */
export function resolveHelperTranscriptProvider(
  model: string,
  executionHarness?: 'claude' | 'codex',
): AgentProviderType {
  const registryProvider = getProviderForModel(model);
  if (registryProvider) {
    return registryProvider;
  }
  if (executionHarness) {
    return executionHarness;
  }
  try {
    return getExecutionHarnessForModel(model) === 'codex' ? 'codex' : 'claude';
  } catch {
    return 'claude';
  }
}

export { formatBranchAsTitle } from '@canopy/protocol/pull-requests';

function resolveAgentEnvironment(
  workspaceId: string | undefined,
): ResolveEnvironmentRequest {
  return workspaceId ? { runtime: 'agent', workspaceId } : { runtime: 'agent' };
}

function captureClaudeUsage(usage: HelperUsage, event: unknown): void {
  const record = toRecord(event);
  const usageRecord = toRecord(record?.usage);
  if (usageRecord) {
    usage.inputTokens = readNumberField(usageRecord, 'input_tokens');
    usage.outputTokens = readNumberField(usageRecord, 'output_tokens');
    usage.cacheReadInputTokens = readNumberField(
      usageRecord,
      'cache_read_input_tokens',
    );
    usage.cacheCreationInputTokens = readNumberField(
      usageRecord,
      'cache_creation_input_tokens',
    );
  }
  const totalCostUsd = record
    ? readNumberField(record, 'total_cost_usd')
    : undefined;
  if (totalCostUsd !== undefined) {
    usage.totalCostUsd = totalCostUsd;
  }
  usage.messageCount = 1;
  usage.assistantMessageCount = 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readStringField(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value.trim().length > 0
    ? value
    : undefined;
}

function readNumberField(
  record: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = record[field];
  return typeof value === 'number' ? value : undefined;
}

export function formatClaudeStreamError(event: unknown): string | undefined {
  const record = toRecord(event);
  if (!record) {
    return undefined;
  }

  if (record.type === 'error') {
    const errorRecord = toRecord(record.error);
    const message =
      readStringField(record, 'message') ??
      readStringField(record, 'error') ??
      (errorRecord ? readStringField(errorRecord, 'message') : undefined);
    return message ? `Claude query failed: ${message}` : 'Claude query failed';
  }

  if (record.type === 'assistant') {
    const error = readStringField(record, 'error');
    if (error) {
      const message = readStringField(record, 'message');
      return message
        ? `Claude SDK error: ${error}: ${message}`
        : `Claude SDK error: ${error}`;
    }
  }

  if (record.type === 'result' && record.is_error === true) {
    const errors = Array.isArray(record.errors)
      ? record.errors.filter(
          (value): value is string =>
            typeof value === 'string' && value.trim().length > 0,
        )
      : [];
    const result = readStringField(record, 'result');
    const message = errors.join('; ') || result;
    return message ? `Claude query failed: ${message}` : 'Claude query failed';
  }

  return undefined;
}

async function runClaudeStructuredHelperQueryAttempt<T>(
  options: ClaudeStructuredHelperQueryOptions<T>,
  captureEvent: (event: unknown) => void,
  resumeSessionId: string | undefined,
  rememberSessionId: (sessionId: string) => void,
): Promise<StructuredHelperQueryResult<T>> {
  const thinkingOptions = options.thinkingLevel
    ? buildClaudeThinkingOptions(
        clampThinkingLevelForModel(options.thinkingLevel, options.model),
      )
    : undefined;
  const pluginRuntime =
    options.pluginRuntime ?? emptyHelperAgentPluginRuntime();
  const environment = resolveAgentEnvironment(options.workspaceId);
  const queryResult = claudeQuery({
    prompt: resumeSessionId
      ? AGENT_TRANSIENT_RETRY_CONTINUE_PROMPT
      : options.userMessage,
    options: {
      cwd: options.repoPath,
      model: isOllamaModel(options.model)
        ? stripOllamaModelPrefix(options.model)
        : options.model,
      maxTurns: options.maxTurns,
      abortController: options.abortController,
      pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
      ...(options.spawnClaudeCodeProcess
        ? { spawnClaudeCodeProcess: options.spawnClaudeCodeProcess }
        : {}),
      env: {
        ...getEnhancedEnv({ environment }),
        ...(options.claudeEnvOverride ?? {}),
      },
      sandbox: {
        ripgrep: {
          command: getBundledRgBinaryPath(),
        },
      },
      permissionMode: 'plan',
      settingSources: options.settingSources ?? ['user', 'project', 'local'],
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
      ...(options.disallowedTools
        ? { disallowedTools: options.disallowedTools }
        : {}),
      systemPrompt: options.systemPrompt,
      mcpServers: pluginRuntime.claudeMcpServers,
      ...(options.strictMcpConfig ? { strictMcpConfig: true } : {}),
      ...(pluginRuntime.claudePlugins.length > 0
        ? { plugins: pluginRuntime.claudePlugins }
        : {}),
      ...(thinkingOptions ?? {}),
      // Merge with the thinking settings (Ultra sets `ultracode`) so the
      // spread cannot drop the native-memory suppression applied while local
      // memory is enabled (CAN-1969).
      ...claudeNativeMemoryOptions(
        options.localMemoryEnabled,
        thinkingOptions?.settings,
      ),
      outputFormat: {
        type: 'json_schema',
        schema: options.schema,
      },
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
  });

  const usage: HelperUsage = {};
  let structuredToolInput: unknown;
  let pendingErrorMessage: string | undefined;
  for await (const sdkEvent of queryResult) {
    const event: unknown = sdkEvent;
    captureEvent(event);
    await options.transcriptObserver?.appendEvent(event);
    const eventSessionId = readClaudeRetrySessionId(event);
    if (eventSessionId) {
      rememberSessionId(eventSessionId);
      await options.transcriptObserver?.markSessionId?.(eventSessionId);
    }
    const eventRecord = toRecord(event);
    if (eventRecord?.type === 'result') {
      captureClaudeUsage(usage, event);
    }

    const errorMessage = formatClaudeStreamError(event);
    if (errorMessage) {
      if (eventRecord?.type === 'result') {
        throw new StructuredHelperQueryError(errorMessage, usage);
      }
      pendingErrorMessage ??= errorMessage;
      continue;
    }
    if (eventRecord?.type === 'result' && pendingErrorMessage) {
      throw new StructuredHelperQueryError(pendingErrorMessage, usage);
    }

    const latestStructuredToolInput = extractStructuredToolInput(event);
    if (latestStructuredToolInput !== undefined) {
      structuredToolInput = latestStructuredToolInput;
    }

    if (eventRecord?.type !== 'result') {
      continue;
    }

    const structuredOutput = eventRecord.structured_output;
    const output = structuredOutput ?? structuredToolInput;
    if (options.isResult(output)) {
      return { value: output, usage };
    }

    const rawResult = readStringField(eventRecord, 'result') ?? '';
    if (rawResult.length > 0) {
      const parsed = parseStructuredJsonResult(rawResult);
      if (options.isResult(parsed)) {
        return { value: parsed, usage };
      }
    }
  }

  if (pendingErrorMessage) {
    throw new StructuredHelperQueryError(pendingErrorMessage, usage);
  }
  return { value: null, usage };
}

export async function runClaudeStructuredHelperQuery<T>(
  options: ClaudeStructuredHelperQueryOptions<T>,
): Promise<StructuredHelperQueryResult<T>> {
  let resumeSessionId: string | undefined;
  await options.transcriptObserver?.markAttempt?.(1);
  return runWithTransientAgentRetry({
    waitForQuotaRecovery: options.waitForQuotaRecovery,
    provider: options.provider,
    model: options.model,
    signal: options.abortController?.signal,
    runAttempt: (captureEvent) =>
      runClaudeStructuredHelperQueryAttempt(
        options,
        captureEvent,
        resumeSessionId,
        (sessionId) => {
          resumeSessionId = sessionId;
        },
      ),
    onRetry: async (notice) => {
      await options.onTransientRetry?.(notice);
      await options.transcriptObserver?.markAttempt?.(notice.nextAttempt);
    },
  });
}

export async function runCodexStructuredHelperQuery<T>(
  options: CodexStructuredHelperQueryOptions<T>,
): Promise<StructuredHelperQueryResult<T>> {
  const { runner, ...request } = options;
  return runner.run(request);
}
