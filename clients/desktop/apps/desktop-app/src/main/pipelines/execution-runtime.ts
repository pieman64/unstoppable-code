import {
  authorizeProjectPipelineRequest,
  readStoredPipelineContext,
} from './pipeline-install-context';
import {
  validateDependencyGraph,
  type ResourceContextInput,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import { getStoredPipelinePathWithSource } from '@canopy/desktop-shared/pipelines/store';
import {
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
} from './canopy-server-client';
import {
  assertPipelineContext,
  pipelineResourceContextEnabled,
} from './resource-lanes';
import { classifyResourceOwner } from '@canopy/desktop-shared/lib/resource-context';
import { parseSharedPipelineLocalId } from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import { parsePipelineText } from '@canopy/desktop-shared/pipelines/parse-pipeline';
import * as os from 'node:os';
import { stepTimedOutMessage } from '@canopy/desktop-shared/node/pipelines/step-timeout';
import * as path from 'node:path';
import type { BrowserWindow } from 'electron';
import { getDataDir } from '../lib/paths';
import { isPathInside } from '../lib/path-safety';
import {
  getBundledActionsDir,
  getBundledPipelinesDir,
  getProjectActionsDir,
  getProjectActionsDirCandidates,
  getProjectPipelinesDir,
  getProjectPipelinesDirCandidates,
} from './config-paths';
import type {
  AgentPromptWorkerResult,
  CodexPromptRunnerResult,
  CursorPromptRunnerRequest,
  CursorPromptRunnerResult,
  ExecutionRuntime,
  PipelineAgentModelAliasResolution,
  ResolvePipelineTargetRequest,
  ResolvePipelineTargetResult,
  SpawnedProcessResult,
} from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  createDesktopLifecycleHooks,
  createDesktopStepPostProcess,
} from './execution-runtime-hooks';
import { createTrackedPlan, updateTrackedPlan } from '../lib/plan-persistence';
import { resolvePipelinePluginCollections } from './plugin-collection-resolver';
import { resolveClaudeCompatibleInvocation } from '../ollama/claude-compatible';
import { resolveAiCreditsRoutingOverride } from '../agents/ai-credits-routing';
import { resolveBackgroundWorkOwner } from '../agents/work-owner';
import {
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
} from '../lib/model-policy-state';
import { getObservabilityService } from '../observability';
import { getProviderForModel } from '@canopy/desktop-shared/types';
import { getCodexGatewayProxyService } from '../agents/codex-gateway-proxy-service';
import { getAgentModel } from '../agents/agent-model-store';
import { resolveAgentDestinationDefaultModel } from '../agents/agent-default-model';
import { isAgentDefaultBaseModel } from '@canopy/protocol/agents';
import { getClaudeWorkerSessionService } from '../integration/claude-worker-session-service';
import { getWorktreeCliRecord } from '../lib/worktree-service';
import type { PipelineAiCreditsRoutingOverride } from '@canopy/desktop-shared/node/pipelines/executor/types';
import {
  classifyAgentFailure,
  classifyRetryableCodexTransportFailure,
} from '@canopy/desktop-shared/agent-failures';
import {
  classifyCodexTransportError,
  codexTurnOutcomeError,
} from '@canopy/desktop-shared/node/codex-runtime/transport-errors';
import { transcriptHasAgentActivity } from '@canopy/desktop-shared/lib/usage-limit-resume-prompt';
import { getCodexRuntimeService } from '../codex/runtime-service';
import {
  codexTranscriptEventsHaveAgentActivity,
  createCodexCapabilitySnapshotId,
  createHeadlessMcpElicitationPolicy,
  isForeignThreadTokenUsageEvent,
  projectCodexRuntimeEvent,
  type CodexRuntimeEvent,
} from '@canopy/desktop-shared/node/codex-runtime';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { resolveCodexMockAppServerOverride } from '@canopy/desktop-shared/node/e2e-mock-env';
import { resolveAnthropicMockEnvOverride } from '@canopy/desktop-shared/node/e2e-mock-env';
import {
  appendCodexSchemaInstruction,
  buildCodexPrompt,
  buildCodexStructuredOutputRetryPrompt,
  buildCodexSystemPrompt,
  CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS,
  isRetryableCodexStructuredOutputError,
  parseStructuredResponseText,
} from '@canopy/desktop-shared/builtin-actions/agent-prompt/logic';
import { mapThinkingToReasoningEffort } from '@canopy/desktop-shared/lib/codex-model-config';
import { buildPipelineGlobalInstructionsBlock } from '@canopy/desktop-shared/lib/global-instructions';
import { getBrandEnv } from '@canopy/desktop-shared/brand/env';
import type { CodexPromptRunnerRequest } from '@canopy/desktop-shared/node/pipelines/executor/types';
import { resolveCodexRuntimeEnvironmentProfile } from '../lib/user-environment-runtime';
import { runPipelineProcessInUtilityProcess } from './process-host-runner';
import { buildCodexPipelineThreadConfig } from '@canopy/desktop-shared/node/pipelines/codex-preferences';
import {
  codexNativeMemoryThreadConfig,
  localMemoryEnabledFromEnv,
} from '@canopy/desktop-shared/node/lib/native-memory';
import {
  getExecutionHarnessForModel,
  getModelSource,
} from '@canopy/desktop-shared/types';
import { resolveCodexCompatibleOllamaInvocation } from '../ollama/codex-compatible';
import {
  createDesktopPipelineLedgerPort,
  getPipelineLedgerAttemptTools,
  openPipelineLedgerCodexTools,
  type PipelineLedgerCodexTools,
} from './pipeline-ledger';
import { createDesktopPipelineHostActions } from './host-actions';
import { createDesktopPipelineOwnershipPort } from './pipeline-owner-policy';

function parseTranscriptEvents(jsonl: string): unknown[] {
  return jsonl
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event: unknown = JSON.parse(line);
        return [event];
      } catch {
        return [];
      }
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCodexRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function readCodexString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' ? value : undefined;
}

function readCodexFiniteNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function projectCodexSubagentUsageBreakdown(
  value: Record<string, unknown>,
): Record<string, number> {
  const projected: Record<string, number> = {};
  const fields: Array<[string, string]> = [
    ['inputTokens', 'input_tokens'],
    ['cachedInputTokens', 'cached_input_tokens'],
    ['cacheWriteInputTokens', 'cache_write_input_tokens'],
    ['outputTokens', 'output_tokens'],
    ['reasoningOutputTokens', 'reasoning_output_tokens'],
  ];
  for (const [sourceKey, targetKey] of fields) {
    const count = readCodexFiniteNumber(value, sourceKey);
    if (count !== undefined) projected[targetKey] = count;
  }
  return projected;
}

function projectCodexPipelineThreadStartedEvent(
  event: CodexRuntimeEvent,
): Record<string, unknown> {
  const thread = readCodexRecord(event.params.thread);
  if (!thread) return projectCodexRuntimeEvent(event);

  const source = readCodexRecord(thread.source);
  const subAgent =
    readCodexRecord(source?.subAgent) ?? readCodexRecord(source?.subagent);
  const threadSpawn =
    readCodexRecord(subAgent?.thread_spawn) ??
    readCodexRecord(subAgent?.threadSpawn);
  const threadId = readCodexString(thread, 'id');
  const agentNickname =
    readCodexString(thread, 'agentNickname') ??
    readCodexString(thread, 'agent_nickname') ??
    readCodexString(threadSpawn, 'agent_nickname') ??
    readCodexString(threadSpawn, 'agentNickname');
  const agentRole =
    readCodexString(thread, 'agentRole') ??
    readCodexString(thread, 'agent_role') ??
    readCodexString(threadSpawn, 'agent_role') ??
    readCodexString(threadSpawn, 'agentRole');
  const parentThreadId =
    readCodexString(thread, 'parentThreadId') ??
    readCodexString(thread, 'parent_thread_id') ??
    readCodexString(subAgent, 'parentThreadId') ??
    readCodexString(subAgent, 'parent_thread_id') ??
    readCodexString(threadSpawn, 'parentThreadId') ??
    readCodexString(threadSpawn, 'parent_thread_id');
  const model = readCodexString(thread, 'model');
  const reasoningEffort =
    readCodexString(thread, 'reasoningEffort') ??
    readCodexString(thread, 'reasoning_effort');

  return {
    ...event.params,
    type: 'thread.started',
    ...(typeof thread.source !== 'undefined' ? { source: thread.source } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(agentNickname ? { agent_nickname: agentNickname } : {}),
    ...(agentRole ? { agent_role: agentRole } : {}),
    ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

function projectCodexPipelineRuntimeEvent(
  event: CodexRuntimeEvent,
  rootThreadId: string,
): Record<string, unknown> | null {
  if (isForeignThreadTokenUsageEvent(event, rootThreadId)) {
    const threadId = readCodexString(event.params, 'threadId');
    const turnId = readCodexString(event.params, 'turnId');
    const tokenUsage = readCodexRecord(event.params.tokenUsage);
    const total = readCodexRecord(tokenUsage?.total);
    const last = readCodexRecord(tokenUsage?.last);
    if (!threadId || !turnId || !total || !last) return null;
    return {
      type: 'thread.subagent_token_usage.updated',
      thread_id: threadId,
      turn_id: turnId,
      total: projectCodexSubagentUsageBreakdown(total),
      last: projectCodexSubagentUsageBreakdown(last),
    };
  }
  if (event.method === 'thread/started') {
    return projectCodexPipelineThreadStartedEvent(event);
  }
  return projectCodexRuntimeEvent(event);
}

const PIPELINE_AGENT_SESSION_START_TIMEOUT_MS = 10 * 60_000;

function codexSandboxForPermission(
  permission: CodexPromptRunnerRequest['permissionPreset'],
): 'read-only' | 'workspace-write' | 'danger-full-access' {
  if (permission === 'dangerous_all') return 'danger-full-access';
  if (permission === 'none') return 'workspace-write';
  return 'read-only';
}

async function runCodexPipelinePrompt(
  request: CodexPromptRunnerRequest,
): Promise<CodexPromptRunnerResult> {
  const transcript: string[] = [];
  const transcriptEvents: unknown[] = [];
  const pushTranscriptLine = (line: string): void => {
    transcript.push(line);
    try {
      request.onTranscriptLine?.(line);
    } catch {
      // Live forwarding is best-effort; the resolved transcript stays
      // authoritative, and a listener failure must not fail the turn.
    }
  };
  const routeSessionId = `pipeline:${request.executionId}:${request.jobId}${request.childId ? `:${request.childId}` : ''}:${request.stepId}:${request.attempt}`;
  let handle:
    | Awaited<
        ReturnType<ReturnType<typeof getCodexRuntimeService>['startThread']>
      >
    | undefined;
  let aiCreditsRouted = false;
  let modelGatewayRouted = false;
  let ledgerCodex: PipelineLedgerCodexTools | undefined;
  const failureProvider =
    request.harnessInvocation?.source === 'ollama' ? 'ollama' : 'codex';
  const failureAccountScope =
    failureProvider === 'ollama'
      ? 'local'
      : request.harnessInvocation?.aiCreditsRouted
        ? 'ai_credits'
        : 'native';
  const service = getCodexRuntimeService();
  try {
    const resolved =
      request.pluginSelections || request.packageOverlay
        ? await resolvePlugins(
            request.pluginSelections ?? {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [],
            },
            request.projectId ?? 'pipeline',
            request.worktreeId ?? request.executionId,
            routeSessionId,
            {
              purpose: 'codex-session',
              installExternalPlugins: true,
              enableHttpMcpProxy: true,
              mcpHttpProxyService: getMcpHttpProxyService(),
              mcpStdioBroker: service,
              sessionId: routeSessionId,
              packageOverlay: request.packageOverlay,
            },
          )
        : undefined;
    for (const warning of resolved?.warnings ?? []) {
      pushTranscriptLine(JSON.stringify({ type: 'warning', message: warning }));
    }
    const roots = resolved?.selectedCapabilityRoots ?? [];
    const mcpServers = resolved?.codexMcpServers ?? {};
    const mcpAuthorityIds =
      getMcpHttpProxyService().getCodexCapabilityAuthorityIds(mcpServers);
    const snapshotId = createCodexCapabilitySnapshotId({
      roots,
      mcpServers,
      mcpAuthorityIds,
    });
    const mockOverride = resolveCodexMockAppServerOverride();
    const aiCredits = request.harnessInvocation
      ? request.harnessInvocation.aiCreditsRouted
        ? {
            model: request.harnessInvocation.runtimeModel,
            env: request.harnessInvocation.envOverride ?? {},
            codexConfig: request.harnessInvocation.codexConfig,
            modelGatewayRouted:
              request.harnessInvocation.modelGatewayRouted === true,
            accountProxyRouted: false,
          }
        : null
      : request.model
        ? await resolveAiCreditsRoutingOverride(
            request.model,
            'codex',
            undefined,
            routeSessionId,
            {
              environmentRuntime: 'pipeline',
              ...(request.projectId ? { workspaceId: request.projectId } : {}),
              ...(request.worktreeId ? { worktreeId: request.worktreeId } : {}),
              ...(request.allowNoNativeAuthFallback !== undefined
                ? {
                    allowNoNativeAuthFallback:
                      request.allowNoNativeAuthFallback,
                  }
                : {}),
              ...(request.executionContext !== undefined
                ? { executionContext: request.executionContext }
                : {}),
            },
          )
        : null;
    // The account proxy brings its own provider route but bills a proxy
    // account, so a proxy-routed step is not an AI Credits step.
    aiCreditsRouted =
      request.harnessInvocation?.aiCreditsRouted ??
      (aiCredits !== null && !aiCredits.accountProxyRouted);
    modelGatewayRouted =
      request.harnessInvocation?.modelGatewayRouted ??
      aiCredits?.modelGatewayRouted === true;
    const workspaceEnvironment = resolveCodexRuntimeEnvironmentProfile({
      runtime: 'pipeline',
      ...(request.projectId ? { workspaceId: request.projectId } : {}),
    });
    const profile = {
      environment: {
        ...workspaceEnvironment.environment,
        ...request.environment,
        ...(request.harnessInvocation?.envOverride ?? {}),
        ...(mockOverride?.env ?? {}),
      },
      configArgs: mockOverride?.configArgs ?? [],
      logicalWorkspaceEnvironmentId:
        workspaceEnvironment.logicalWorkspaceEnvironmentId,
      ...(workspaceEnvironment.secretVersionFingerprint
        ? {
            secretVersionFingerprint:
              workspaceEnvironment.secretVersionFingerprint,
          }
        : {}),
      ...(mockOverride ? { mockProviderId: 'canopy-e2e' } : {}),
    };
    // Global Instructions (Instructions settings), pipelines section: resolved from
    // the step environment and carried as developer instructions so the block
    // reaches the thread as a system-prompt addition.
    const globalInstructionsBlock = request.resumeSessionId
      ? ''
      : buildPipelineGlobalInstructionsBlock(
          getBrandEnv(
            request.environment,
            'PREF_GLOBAL_INSTRUCTIONS_PIPELINES',
          ),
          { harness: failureProvider, model: request.model ?? '' },
        );
    // The step's Ledger tools. Dynamic tools are fixed when a thread starts:
    // a new thread gets them with the Ledger block, and a resumed thread
    // keeps whatever it started with, which this attempt's binding serves.
    // The capability snapshot leaves them out, so a resume matches its
    // thread's lease whether or not the thread started with them. Their
    // calls pass an approval session that ends with the step.
    ledgerCodex = openPipelineLedgerCodexTools(
      request.ledgerAttemptKey,
      request.cwd,
    );
    const developerInstructions =
      [
        buildCodexSystemPrompt(
          globalInstructionsBlock || undefined,
          request.permissionPreset,
        ),
        ledgerCodex !== undefined && !request.resumeSessionId
          ? ledgerCodex.instructions
          : undefined,
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n') || undefined;
    const threadConfig = buildCodexPipelineThreadConfig(request.environment, {
      ...(request.harnessInvocation?.codexConfig ?? {}),
      ...(aiCredits?.codexConfig ?? {}),
      ...(Object.keys(mcpServers).length > 0
        ? { mcp_servers: mcpServers }
        : {}),
      // Merged last so no override spread can drop the native-memory
      // suppression applied while local memory is enabled (CAN-1969). The
      // preference reaches pipeline steps through the branded
      // `PREF_LOCAL_MEMORY_ENABLED` execution environment variable.
      ...codexNativeMemoryThreadConfig(
        localMemoryEnabledFromEnv(request.environment),
      ),
    });
    const commonParams = {
      cwd: request.cwd,
      approvalPolicy: 'never' as const,
      sandbox: codexSandboxForPermission(request.permissionPreset),
      serviceTier: request.fastMode ? 'priority' : 'default',
      ...(request.model
        ? {
            model:
              aiCredits?.model ??
              request.harnessInvocation?.runtimeModel ??
              request.model,
          }
        : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
      config: threadConfig,
    };
    handle = request.resumeSessionId
      ? await service.resumeThread({
          params: {
            threadId: request.resumeSessionId,
            ...commonParams,
          },
          capabilitySnapshotId: snapshotId,
          capabilityLeaseKind: 'persisted-helper',
          profile,
        })
      : await service.startThread({
          params: {
            ...commonParams,
            selectedCapabilityRoots: roots,
            experimentalRawEvents: false,
            ...(ledgerCodex ? { dynamicTools: ledgerCodex.specs } : {}),
          },
          capabilitySnapshotId: snapshotId,
          capabilityLeaseKind: 'persisted-helper',
          profile,
        });
    pushTranscriptLine(
      JSON.stringify({ type: 'thread.started', thread_id: handle.threadId }),
    );
    const rootThreadId = handle.threadId;
    const maxAttempts = request.schema
      ? CODEX_STRUCTURED_OUTPUT_RETRY_ATTEMPTS + 1
      : 1;
    let prompt = appendCodexSchemaInstruction(
      buildCodexPrompt(request.prompt, request.systemPrompt),
      request.schema,
    );
    let lastError: Error | undefined;
    // ONE deadline for the whole step. Handing every structured-output
    // retry the full `totalTimeoutMs` again let a step declaring
    // `timeout_minutes: N` spend ~3N minutes in turns before failing. The
    // Cursor runner enforces the same single deadline, so the declared
    // timeout means the same thing on both providers.
    const deadline = Date.now() + request.totalTimeoutMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remainingTimeoutMs = deadline - Date.now();
      if (remainingTimeoutMs <= 0) {
        // Report the timeout, not the previous attempt's schema-validation
        // error. Preferring `lastError` explained a step that genuinely
        // exhausted its wall clock as a content problem, and gave the same
        // declared `timeout_minutes` two different user-facing explanations on
        // Codex and Cursor. The last error is
        // still visible in the step's own attempt logs, so nothing is lost by
        // reporting the reason the step actually ended.
        throw new Error(stepTimedOutMessage(request.totalTimeoutMs));
      }
      const outcome = await handle.runTurn({
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(request.schema ? { outputSchema: request.schema } : {}),
        ...(request.thinkingLevel && request.model
          ? {
              effort: mapThinkingToReasoningEffort(
                request.thinkingLevel,
                request.model,
                aiCreditsRouted,
              ),
            }
          : {}),
        signal: request.signal,
        startupTimeoutMs: PIPELINE_AGENT_SESSION_START_TIMEOUT_MS,
        totalTimeoutMs: remainingTimeoutMs,
        mcpElicitationPolicy: createHeadlessMcpElicitationPolicy({
          allowedServers: Object.keys(mcpServers),
          allowExternalMutation: request.permissionPreset === 'dangerous_all',
        }),
        ...(ledgerCodex
          ? { hostToolPolicy: ledgerCodex.policy(handle.threadId) }
          : {}),
        onEvent: (event) => {
          const projected = projectCodexPipelineRuntimeEvent(
            event,
            rootThreadId,
          );
          if (!projected) return;
          transcriptEvents.push(projected);
          pushTranscriptLine(JSON.stringify(projected));
        },
      });
      if (outcome.status === 'interrupted') {
        if (request.signal?.aborted) {
          return {
            status: 'cancelled',
            transcript: `${transcript.join('\n')}\n`,
            aiCreditsRouted,
            modelGatewayRouted,
            failure: {
              version: 1,
              provider: failureProvider,
              agent_harness: 'codex',
              session_id: handle.threadId,
              had_agent_activity:
                codexTranscriptEventsHaveAgentActivity(transcriptEvents),
              message: 'Codex pipeline turn was cancelled.',
            },
          };
        }
        throw codexTurnOutcomeError(
          outcome,
          'Codex pipeline turn was interrupted before completion',
        );
      }
      try {
        if (outcome.status !== 'completed') {
          throw codexTurnOutcomeError(outcome, 'Codex pipeline turn failed');
        }
        // The shared safe parser, not `JSON.parse`: V8's message quotes the
        // text it choked on, and that excerpt reached the retry prompt and the
        // reported failure. `SyntaxError` is preserved so
        // `isRetryableCodexStructuredOutputError` still retries malformed
        // structured output.
        const structured = request.schema
          ? parseStructuredResponseText(outcome.finalText)
          : undefined;
        return {
          status: 'success',
          sessionId: handle.threadId,
          rawText: outcome.finalText,
          ...(structured !== undefined ? { structured } : {}),
          transcript: `${transcript.join('\n')}\n`,
          proposedPlan: outcome.proposedPlanText,
          usage: outcome.usage,
          aiCreditsRouted,
          modelGatewayRouted,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (
          request.schema &&
          attempt < maxAttempts &&
          isRetryableCodexStructuredOutputError(lastError)
        ) {
          prompt = buildCodexStructuredOutputRetryPrompt(
            request.schema,
            lastError.message,
          );
          continue;
        }
        throw lastError;
      }
    }
    throw lastError ?? new Error('Codex pipeline turn failed');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const accountScope = aiCreditsRouted ? 'ai_credits' : failureAccountScope;
    const classification =
      classifyAgentFailure({
        provider: failureProvider,
        accountScope,
        model: request.model,
        events: transcriptEvents,
        error,
      }) ??
      // The local app-server transport failed (unanswered thread setup, a
      // shared restart for another turn, a thread still closing). Pause as a
      // temporary outage so the run resumes; never for an unanswered
      // `turn/start`, which may already be running.
      classifyRetryableCodexTransportFailure(
        classifyCodexTransportError(error),
        { provider: failureProvider, accountScope, model: request.model },
        message,
      );
    return {
      status: request.signal?.aborted ? 'cancelled' : 'failure',
      transcript: `${transcript.join('\n')}\n`,
      aiCreditsRouted,
      modelGatewayRouted,
      failure: {
        version: 1,
        provider: failureProvider,
        agent_harness: 'codex',
        // A resume that failed during setup has no handle yet, but the step
        // still belongs to that session. Activity reports only this attempt;
        // the step runner carries over activity from a checkpoint it continued.
        ...(handle
          ? { session_id: handle.threadId }
          : request.resumeSessionId
            ? { session_id: request.resumeSessionId }
            : {}),
        had_agent_activity:
          codexTranscriptEventsHaveAgentActivity(transcriptEvents),
        ...(classification ? { classification } : {}),
        message,
      },
    };
  } finally {
    ledgerCodex?.dispose();
    await handle?.unsubscribe().catch(() => {});
    getMcpHttpProxyService().unregisterRoutesForSession(routeSessionId);
    getCodexGatewayProxyService().unregisterRoutesForSession(routeSessionId);
    await service.revokeStdioMcpRoutes(routeSessionId);
  }
}

export function createElectronExecutionRuntime(
  getWindow?: () => BrowserWindow | null,
): ExecutionRuntime {
  const runtime: ExecutionRuntime = {
    resolvePipelineContextResource: async (parent, executionContext) => {
      if (!pipelineResourceContextEnabled()) return undefined;
      if (!parent.pipelineId)
        throw new Error('Pipeline unavailable (unknown-provenance)');
      const parentShared = parseSharedPipelineLocalId(parent.pipelineId);
      let resource: ResourceContextInput['resource'];
      if (parentShared) {
        resource = {
          owner: (
            await (executionContext !== undefined
              ? getSharedPipelineForExecutionContext(parentShared.remoteId)
              : getSharedPipeline(parentShared.remoteId))
          ).owner,
        };
      } else if (
        parent.pipelineFileDir &&
        isPathInside(getBundledPipelinesDir(), parent.pipelineFileDir)
      ) {
        resource = { owner: { type: 'system' } };
      } else if (
        parent.pipelineId.startsWith('project--') ||
        (parent.pipelineFileDir &&
          !getStoredPipelinePathWithSource(parent.pipelineId).success)
      ) {
        if (!parent.cwd || !parent.pipelineFileDir)
          throw new Error('Pipeline unavailable (unknown-provenance)');
        const { owner, projectId } = await authorizeProjectPipelineRequest({
          id: parent.pipelineId,
          cwd: parent.pipelineSource?.cwd ?? parent.cwd,
          filePath:
            parent.pipelineSource?.filePath ??
            path.join(
              parent.pipelineFileDir,
              path.basename(parent.pipelineId.replace(/^project--/, '')),
            ),
        });
        if (!parent.pipelineSource && projectId !== parent.projectId)
          throw new Error('Pipeline unavailable (context-mismatch)');
        resource = { owner };
      } else {
        resource = await readStoredPipelineContext(
          parent.pipelineId,
          executionContext,
        );
        const stored = getStoredPipelinePathWithSource(parent.pipelineId);
        if (
          !resource.provenance &&
          stored.success &&
          stored.data?.source === 'bundled'
        )
          resource = { owner: { type: 'system' } };
      }
      await assertPipelineContext(resource, parent.projectId, executionContext);
      return resource;
    },
    resolvePipelineResource: async (
      reference,
      parent,
      file,
      target,
      executionContext,
    ) => {
      if (!pipelineResourceContextEnabled()) return undefined;
      if (target) {
        if (!parent)
          throw new Error('Pipeline unavailable (unknown-provenance)');
        if (
          target.target.scope === 'directory' &&
          !target.projectId &&
          typeof classifyResourceOwner(effectivePipelineOwner(parent), {
            strict: true,
          }) === 'object'
        )
          throw new Error('Pipeline unavailable (unsupported-target)');
        await assertPipelineContext(parent, target.projectId, executionContext);
      }
      if (file) {
        // Bundled presets resolved by relative file name are system-owned and
        // live outside every project root, so they never go through the
        // project resolver.
        const owner: ResourceContextInput['resource']['owner'] = isPathInside(
          getBundledPipelinesDir(),
          file.filePath,
        )
          ? { type: 'system' }
          : (await authorizeProjectPipelineRequest({ id: reference, ...file }))
              .owner;
        if (!parent)
          throw new Error('Pipeline unavailable (unknown-provenance)');
        if (target)
          await assertPipelineContext(
            { owner },
            target.projectId,
            executionContext,
          );
        await assertPipelineContext(parent, undefined, executionContext);
        const decision = validateDependencyGraph(
          effectivePipelineOwner(parent),
          [{ owner: effectivePipelineOwner({ owner }), available: true }],
        );
        if (!decision.allow)
          throw new Error(`Pipeline unavailable (${decision.reason})`);
        return undefined;
      }
      const shared = parseSharedPipelineLocalId(reference);
      if (!shared && !getStoredPipelinePathWithSource(reference).success)
        return undefined;
      const detail = shared
        ? await (executionContext !== undefined
            ? getSharedPipelineForExecutionContext(shared.remoteId)
            : getSharedPipeline(shared.remoteId))
        : undefined;
      let child: ResourceContextInput['resource'] = detail
        ? { owner: detail.owner }
        : await readStoredPipelineContext(reference, executionContext);
      if (!shared && !child.provenance) {
        const stored = getStoredPipelinePathWithSource(reference);
        if (stored.success && stored.data?.source === 'bundled')
          child = { owner: { type: 'system' } };
      }
      await assertPipelineContext(child, target?.projectId, executionContext);
      if (!parent) throw new Error('Pipeline unavailable (unknown-provenance)');
      await assertPipelineContext(parent, undefined, executionContext);
      const decision = validateDependencyGraph(effectivePipelineOwner(parent), [
        { owner: effectivePipelineOwner(child), available: true },
      ]);
      if (!decision.allow)
        throw new Error(`Pipeline unavailable (${decision.reason})`);
      if (detail) {
        return {
          pipeline: parsePipelineText(detail.rawPipeline),
          pipelineId: reference,
        };
      }
      return undefined;
    },
    executionsDir: path.join(getDataDir(), 'pipeline-executions'),
    tempRootDir: path.join(os.tmpdir(), 'canopy-exec'),
    bundledActionsDir: getBundledActionsDir(),
    getProjectActionsDir,
    getProjectActionsDirCandidates,
    getProjectPipelinesDir,
    getProjectPipelinesDirCandidates,
    lifecycle: createDesktopLifecycleHooks(),
    onStepPostProcess: createDesktopStepPostProcess(getWindow),
    planPersistence: {
      createTrackedPlan,
      updateTrackedPlan,
    },
    resolvePipelinePluginCollections,
    resolveClaudeCompatibleInvocation,
    releaseAiCreditsRouting: (routeSessionId) => {
      getCodexGatewayProxyService().unregisterRoutesForSession(routeSessionId);
    },
    resolveModelHarnessInvocation: async (model, options) => {
      const source = model ? getModelSource(model) : 'claude-managed';
      const harness =
        options?.harness ??
        (model ? getExecutionHarnessForModel(model) : 'claude');
      if (source === 'copilot-managed' || harness === 'copilot') {
        return {
          source: 'copilot-managed',
          harness: 'copilot',
          runtimeModel: model ?? '',
          aiCreditsRouted: false,
        };
      }
      if (source === 'opencode-managed' || harness === 'opencode') {
        return {
          source: 'opencode-managed',
          harness: 'opencode',
          runtimeModel: model ?? '',
          aiCreditsRouted: false,
        };
      }
      if (source === 'cursor-managed' || harness === 'cursor') {
        return {
          source: 'cursor-managed',
          harness: 'cursor',
          runtimeModel: model ?? '',
          aiCreditsRouted: false,
        };
      }
      if (!source || !harness) {
        throw new Error(`Unknown model "${model ?? ''}"`);
      }
      const mockEnv = resolveAnthropicMockEnvOverride();
      if (harness === 'claude' && mockEnv) {
        return {
          source,
          harness,
          runtimeModel: model ?? '',
          aiCreditsRouted: false,
          envOverride: mockEnv,
        };
      }
      if (model && source === 'ollama') {
        if (harness === 'codex') {
          return resolveCodexCompatibleOllamaInvocation(model, {
            ensureRunningReason: 'pipeline',
            assertInstalled: true,
          });
        }
        const invocation = await resolveClaudeCompatibleInvocation(model, {
          providerType: 'ollama',
          ensureRunningReason: 'pipeline',
          assertInstalled: true,
        });
        return {
          source: 'ollama',
          harness,
          runtimeModel: invocation.sdkModel ?? model,
          aiCreditsRouted: false,
          ...(invocation.envOverride
            ? { envOverride: invocation.envOverride }
            : {}),
        };
      }
      const routed =
        model && (harness === 'claude' || harness === 'codex')
          ? await resolveAiCreditsRoutingOverride(
              model,
              harness,
              undefined,
              options?.routeSessionId,
              {
                environmentRuntime: 'pipeline',
                signal: options?.signal,
                checkpointProxyQuota: options?.checkpointProxyQuota,
                requiredAccountProxyConnectionId:
                  options?.requiredAccountProxyConnectionId,
                ...(options?.workspaceId !== undefined
                  ? { workspaceId: options.workspaceId }
                  : {}),
                ...(options?.worktreeId !== undefined
                  ? { worktreeId: options.worktreeId }
                  : {}),
                ...(options?.allowNoNativeAuthFallback !== undefined
                  ? {
                      allowNoNativeAuthFallback:
                        options.allowNoNativeAuthFallback,
                    }
                  : {}),
                ...(options?.executionContext !== undefined
                  ? { executionContext: options.executionContext }
                  : {}),
              },
            )
          : null;
      return {
        source,
        harness,
        runtimeModel: routed?.model ?? model ?? '',
        aiCreditsRouted: routed !== null && !routed.accountProxyRouted,
        modelGatewayRouted: routed?.modelGatewayRouted === true,
        ...(routed?.accountProxyRouted
          ? {
              accountProxyRouted: true,
              accountProxyConnectionId: routed.accountProxyConnectionId,
            }
          : {}),
        ...(routed?.env ? { envOverride: routed.env } : {}),
        ...(routed?.codexConfig ? { codexConfig: routed.codexConfig } : {}),
      };
    },
    resolveAiCreditsRouting: async (
      model,
      provider,
      context,
    ): Promise<PipelineAiCreditsRoutingOverride | null> =>
      // The step supplies both halves of its own routing context (ECW-9091
      // review round 7):
      // - `workspaceId` + `environmentRuntime: 'pipeline'` so the
      //   user-supplied-credential guard resolves the SAME environment the step
      //   spawns with (`resolvePipelineRuntimeEnv(state.project_id)`). A
      //   workspace assignment replaces the global one, so the runtime slot
      //   alone is not enough.
      // - `allowNoNativeAuthFallback` false for automation/hook triggers, so a
      //   pipeline running with no user present cannot silently spend credits.
      resolveAiCreditsRoutingOverride(
        model,
        provider,
        undefined,
        context?.routeSessionId,
        {
          environmentRuntime: 'pipeline',
          signal: context?.signal,
          checkpointProxyQuota: context?.checkpointProxyQuota,
          requiredAccountProxyConnectionId:
            context?.requiredAccountProxyConnectionId,
          ...(context?.workspaceId !== undefined
            ? { workspaceId: context.workspaceId }
            : {}),
          ...(context?.worktreeId !== undefined
            ? { worktreeId: context.worktreeId }
            : {}),
          ...(context?.allowNoNativeAuthFallback !== undefined
            ? { allowNoNativeAuthFallback: context.allowNoNativeAuthFallback }
            : {}),
          ...(context?.executionContext !== undefined
            ? { executionContext: context.executionContext }
            : {}),
        },
      ),
    resolvePipelineAgentModelAlias: async (
      agentId,
      scope,
    ): Promise<PipelineAgentModelAliasResolution | null> => {
      const agent = await getAgentModel(agentId);
      if (!agent) return null;
      return {
        agentId: agent.id,
        name: agent.name,
        // An inheriting Agent takes the default of the step's workspace.
        base: isAgentDefaultBaseModel(agent.baseModel)
          ? await resolveAgentDestinationDefaultModel(scope?.projectId)
          : agent.baseModel,
        instructions: agent.instructions,
        pluginSelections: agent.pluginSelections,
      };
    },
    isModelBlockedByOrgPolicy: async (modelId, scope) => {
      const owner = await resolveBackgroundWorkOwner(
        {
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
        },
        scope.executionContext,
      );
      return isModelBlockedByStoredPolicy(modelId, owner);
    },
    isOrgModelPolicyActive: async (scope) => {
      const owner = await resolveBackgroundWorkOwner(
        {
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          ...(scope.worktreeId ? { worktreeId: scope.worktreeId } : {}),
        },
        scope.executionContext,
      );
      return isOrgModelPolicyActiveForStoredAccount(owner);
    },
    recordModelPolicyRefusal: (context): void => {
      const projectId = context.projectId ?? 'pipeline';
      const worktreeId = context.worktreeId ?? context.executionId;
      getObservabilityService().recordSessionDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'model_policy_refused',
        sessionKey: `pipeline:${context.executionId}:${context.jobId}:${context.stepId}`,
        projectId,
        worktreeId,
        chatId: `pipeline:${context.executionId}`,
        providerType: getProviderForModel(context.modelId) ?? 'unknown',
        model: context.modelId,
      });
    },
    resolvePipelineTarget: resolveDesktopPipelineTarget,
    pipelineLedger: createDesktopPipelineLedgerPort(),
    pipelineHostActions: createDesktopPipelineHostActions(),
    pipelineOwnership: createDesktopPipelineOwnershipPort(),
    codexPromptRunner: {
      runCodexPrompt: runCodexPipelinePrompt,
    },
    copilotPromptRunner: {
      async runCopilotPrompt(request) {
        return (
          await import('./copilot-prompt-runner')
        ).runDesktopCopilotPipelinePrompt(request);
      },
    },
    opencodePromptRunner: {
      async runOpenCodePrompt(request) {
        return (
          await import('./opencode-prompt-runner')
        ).runDesktopOpenCodePipelinePrompt(request);
      },
    },
    cursorPromptRunner: {
      async runCursorPrompt(
        request: CursorPromptRunnerRequest,
      ): Promise<CursorPromptRunnerResult> {
        // Dynamic import (local module): './cursor-prompt-runner'
        // transitively reaches the ESM-only '@agentclientprotocol/sdk' via
        // node/cursor/turn-driver -> node/acp/client. execution-runtime.ts
        // is statically imported by ipc/archived-containers.ts,
        // ipc/usage-limited-chats.ts, and pipelines/pipeline-handlers.ts, all
        // reachable at Electron main startup, so a static import here would
        // put that ESM chain on the static require graph the
        // bytecode-compiled main build resolves at load. The dynamic edge
        // keeps it off that graph and defers EVALUATION until a Cursor step
        // actually runs, mirroring agents/session-manager.ts's dynamic load
        // of the Cursor provider. It does not keep the bytes out of the
        // emitted chunk: the main build sets `inlineDynamicImports: true`
        // (electron.vite.config.ts) for the executor's circular import, so
        // Rollup inlines this module — deferred evaluation, not code
        // splitting, is the guarantee here.
        const { runCursorPipelinePrompt } =
          await import('./cursor-prompt-runner');
        return runCursorPipelinePrompt(request);
      },
    },
    agentPromptWorker: {
      async runAgentPrompt(request): Promise<AgentPromptWorkerResult> {
        const workerService = getClaudeWorkerSessionService();
        const abortSignal = request.signal;
        let workerId: string | undefined;
        const cancelWorker = (): void => {
          if (workerId) {
            void workerService.cancel(workerId);
          }
        };
        const captureWorkerId = (id: string): void => {
          workerId = id;
          if (abortSignal?.aborted) {
            queueMicrotask(cancelWorker);
          }
        };
        abortSignal?.addEventListener('abort', cancelWorker, { once: true });

        let result;
        try {
          result = await workerService.runWorker({
            kind: 'pipeline_agent_prompt',
            label: request.stepLabel,
            cwd: request.cwd,
            systemPrompt: request.systemPrompt ?? '',
            prompt: request.prompt,
            schema: request.schema,
            resumeSessionId: request.resumeSessionId,
            model: request.model,
            thinkingLevel: request.thinkingLevel,
            permission: request.permission,
            approvalMode: request.approvalMode,
            settingSources: request.settingSources,
            maxTurns: request.maxTurns,
            mcpServers: request.mcpServers,
            claudeEnvOverride: request.claudeEnvOverride,
            // A pipeline agent's Ledger tools; helper workers never get any.
            ledgerTools: getPipelineLedgerAttemptTools(
              request.ledgerAttemptKey,
            ),
            projectId: request.projectId,
            worktreeId: request.worktreeId,
            pipelineExecutionId: request.executionId,
            stepId: request.stepId,
            linkTarget: request.linkTarget,
            startupTimeoutMs: PIPELINE_AGENT_SESSION_START_TIMEOUT_MS,
            onCreated: captureWorkerId,
            onStarted: (id) => {
              captureWorkerId(id);
              void request.onWorkerStarted?.(id);
            },
            onQueued: (id) => {
              captureWorkerId(id);
              void request.onWorkerQueued?.(id);
            },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            status: 'failure',
            transcript: '',
            projectedMessages: [],
            failure: {
              version: 1,
              provider: 'claude',
              agent_harness: 'claude',
              had_agent_activity: false,
              classification:
                classifyAgentFailure({
                  provider: 'claude',
                  model: request.model,
                  accountScope: 'native',
                  error,
                }) ?? undefined,
              message,
            },
          };
        } finally {
          abortSignal?.removeEventListener('abort', cancelWorker);
          if (request.aiCreditsRouteSessionId) {
            getCodexGatewayProxyService().unregisterRoutesForSession(
              request.aiCreditsRouteSessionId,
            );
          }
        }
        if (result.status !== 'success') {
          const message =
            result.error ??
            `Claude worker failed with status: ${result.status}`;
          const hadAgentActivity = transcriptHasAgentActivity(
            result.transcript,
          );
          return {
            status: result.status === 'cancelled' ? 'cancelled' : 'failure',
            workerId: result.workerId,
            transcript: result.transcriptJsonl,
            projectedMessages: result.transcript,
            failure: {
              version: 1,
              provider: 'claude',
              agent_harness: 'claude',
              session_id: result.sessionId,
              had_agent_activity: hadAgentActivity,
              classification:
                classifyAgentFailure({
                  provider: 'claude',
                  model: request.model,
                  accountScope: 'native',
                  events: parseTranscriptEvents(result.transcriptJsonl),
                  error: new Error(message),
                }) ?? undefined,
              message,
            },
          };
        }
        return {
          status: 'success',
          workerId: result.workerId,
          sessionId: result.sessionId,
          rawText: result.finalText,
          structured:
            request.schema !== undefined
              ? (result.result ?? undefined)
              : undefined,
          transcript: result.transcriptJsonl,
          proposedPlan: result.proposedPlan,
          projectedMessages: result.transcript,
        };
      },
    },
  };
  runtime.spawnedProcessRunner = (
    processSpec,
    options,
  ): Promise<SpawnedProcessResult> =>
    runPipelineProcessInUtilityProcess(
      processSpec,
      options,
      runtime.resourceMonitor,
    );
  return runtime;
}

function effectivePipelineOwner(
  resource: ResourceContextInput['resource'],
): unknown {
  // Receipts preserve organization origin even if the current owner is portable.
  return resource.provenance?.ownerContext.kind === 'organization' &&
    typeof classifyResourceOwner(resource.owner, { strict: true }) !== 'object'
    ? {
        type: 'organization',
        id: resource.provenance.ownerContext.organizationId,
        name: null,
      }
    : resource.owner;
}

async function resolveDesktopPipelineTarget(
  request: ResolvePipelineTargetRequest,
): Promise<ResolvePipelineTargetResult> {
  if (request.requested.scope !== 'worktree') {
    throw new Error(
      `Desktop runtime can only resolve worktree targets, received "${request.requested.scope}"`,
    );
  }

  const target = request.requested;
  const workspaceId = target.workspace_id;
  const worktreeId = target.worktree.id;
  const record = await getWorktreeCliRecord(workspaceId, worktreeId);
  return {
    cwd: record.path,
    scope: 'worktree',
    target: {
      scope: 'worktree',
      workspace_id: workspaceId,
      worktree_id: record.id,
      path: record.path,
      created: false,
    },
    projectId: workspaceId,
    worktreeId: record.id,
    repoPath: record.path,
  };
}
