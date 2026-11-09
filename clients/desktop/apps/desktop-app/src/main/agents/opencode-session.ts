import { isWatchDelegatesCompatibilityName } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';
import { openOpenCodeExecutionForWorkerRun } from '../agent-runs/opencode-worker-runtime';
import { assertAgentWorkerContext } from '../agent-runs/agent-worker-context';
import { resolveSessionAiCreditsAttribution } from './ai-credits-routing';
import { resolveGatewayModelEntry } from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  buildCodexPlanModeDeveloperInstructions,
  DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  extractProposedPlan,
} from '@canopy/execution-engine/codex-plan-mode';
import { publishOpenCodePlanProposal } from '../services/chat-state-plan-exit';
import { deferredToolsReloadCoordinator } from '../deferred-tools/reload-coordinator';
import { openCodeDeferredResultReceipts } from '../opencode/deferred-result';
import {
  readOpenCodeAttachments,
  type OpenCodeAttachmentSelection,
} from '@canopy/desktop-shared/node/opencode/prompt-attachments';
import { getObservabilityService } from '../observability';
import { clampThinkingLevelToDeclared } from '@canopy/protocol/thinking';
import { snapshotOpenCodeMcpTools } from '../opencode/capability-snapshot';
import {
  openCodeCapabilityDigest,
  type OpenCodeCapabilitySnapshot,
} from '@canopy/desktop-shared/node/opencode/capability-snapshot';
import { openCodeMcpCallMatchesSnapshot } from '@canopy/desktop-shared/node/opencode/mcp-snapshot';
import { validateOpenCodeMcpSchema } from '../opencode/schema-validation';
import { managedDelegationEnabled } from './delegation/gate';
import type { ManagedDelegationSession } from './delegation/service';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { openCodeToolDisplay } from '@canopy/desktop-shared/node/opencode/tool-display';
import { copilotMcpCallIdentity } from '@canopy/copilot-recipient/tool-correlation';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { runRtkRewrite } from '@canopy/desktop-shared/node/rtk/rewrite';
import {
  getBundledRtkBinaryPath,
  getRtkManagedEnv,
} from '@canopy/desktop-shared/pipelines/config-paths';
import { getEnhancedEnv } from '../pipelines/config-paths';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  getRawOpenCodeModelId,
  isOpenCodeModel,
} from '@canopy/execution-engine/lib/opencode-models';
import {
  hasAnySelections,
  type ApprovalMode,
} from '@canopy/desktop-shared/types';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import {
  emptyCursorCapabilityProjection,
  expandLeadingCursorCommand,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import { runOpenCodeTurn } from '@canopy/desktop-shared/node/opencode/turn-driver';
import { resolveOpenCodeMcpCall } from '../opencode/mcp-servers';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import { assertOpenCodeConnectionGeneration } from '../opencode/connection';
import { authorizeOpenCodeNativeTool } from '../opencode/tool-approval';
import { buildOpenCodeMcpServers } from '../opencode/mcp-servers';
import { authorizeCursorMcpTool } from '../cursor/tool-approval';
import { readOpenCodeForkContext } from '../opencode/fork-context';
import { getOpenCodeSessionProfile } from '../opencode/session-profile';
import { readPreferencesFile } from '../lib/preferences-store';
import { buildLocalMemoryPromptNudge } from '../lib/cowork-chat-system-prompt';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import {
  buildCoworkInjectedToolPrompt,
  buildDeferredToolsGuidance,
  buildWorktreeInjectedToolPrompt,
} from '../canopy-tools/prompting';
import { CursorEventBuffer } from './cursor-event-buffer';
import {
  buildSessionKey,
  drainChatSessionEvents,
  registerSession,
} from './session-manager';
import { createOwnedTurnState } from './owned-turn-state';
import type { AgentProvider, AgentSession, AgentSessionOptions } from './types';
import type { TurnBinding } from '@canopy/protocol/canopy-core';
import {
  getTurnLifecycleProducer,
  releaseTurnLifecycleProducer,
} from './provider-turn-lifecycle';
import { observeRoutedTurnBinding } from './session-event-router';

function hasToolKey<T extends object>(
  registry: T,
  key: string,
): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(registry, key);
}

/** ACP-backed desktop provider; canonical transcript ownership remains in chat state. */
function openCodeFailureStatus(error: unknown): { api_error_status?: number } {
  if (
    error &&
    typeof error === 'object' &&
    'api_error_status' in error &&
    typeof error.api_error_status === 'number' &&
    Number.isInteger(error.api_error_status) &&
    error.api_error_status >= 400 &&
    error.api_error_status <= 599
  )
    return { api_error_status: error.api_error_status };
  return {};
}

export class OpenCodeProvider implements AgentProvider {
  createSession(
    opts: AgentSessionOptions,
    onEvent: (event: unknown) => void | Promise<void>,
    getWindow: () => BrowserWindow | null,
  ): AgentSession {
    assertAgentWorkerContext('OpenCodeProvider.createSession');
    const key = buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId);
    const lifecycleScope = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
    };
    // Canonical turn state starts and ends root turns only from lifecycle
    // receipts, so OpenCode publishes them as the other ACP harnesses do.
    const lifecycleProducer = getTurnLifecycleProducer(
      'opencode',
      lifecycleScope,
    );
    let lifecycleTurnId: string | undefined;
    let awaitingUser = false;
    const turnState = createOwnedTurnState(key, () => session);
    const codeGraphToolsAdvertised =
      !isCoworkWorkspace(opts.projectId) &&
      (!opts.assistantMode || opts.assistantMode === 'default') &&
      opts.codeGraphToolsAdvertised === true;
    const lifetime = new AbortController();
    let active: { abort: AbortController; done: Promise<void> } | undefined;
    let output: CursorEventBuffer | undefined;
    let sessionId = opts.sdkSessionId;
    let contextResetPending = false;
    let forkContext: string | undefined;
    let forkContextLoaded = false;
    let currentTurn: string | undefined;
    let managedDelegation: ManagedDelegationSession | undefined;
    let rtkEnabled = opts.rtkEnabled !== false;
    let model = opts.model;
    let thinking = opts.thinkingLevel;
    let planMode = opts.planMode === true;
    let approvalMode: ApprovalMode = opts.approvalMode ?? 'ask';
    let approval: ApprovalSessionHandle | undefined;
    const announcedNotices = new Set<string>();
    lifetime.signal.addEventListener('abort', () => active?.abort.abort(), {
      once: true,
    });
    const emit = (
      data: Record<string, unknown>,
      userMessageId?: string,
    ): void | Promise<void> => {
      if (
        awaitingUser &&
        data.type !== 'result' &&
        data.type !== 'error' &&
        lifecycleTurnId
      ) {
        awaitingUser = false;
        lifecycleProducer.sessionState({
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          state: 'running',
          source: 'provider',
          observedDuringTurnId: lifecycleTurnId,
        });
      }
      const event = {
        ...data,
        provider: 'opencode',
        ...(userMessageId
          ? { canopy_turn_user_message_id: userMessageId }
          : {}),
      };
      managedDelegation?.observe(event, userMessageId);
      turnState.recordSessionEvent(event);
      return output && data.type !== 'result' && data.type !== 'error'
        ? output.push(event)
        : onEvent(event);
    };

    const run = async (
      prompt: string,
      turnId: string,
      abort: AbortController,
      userMessageId?: string,
      attachments?: OpenCodeAttachmentSelection,
    ): Promise<Record<string, unknown>> => {
      // Clear before attachment reads or runtime setup, including failed starts.
      await emit({ type: 'canopy_opencode_usage', usage: null }, userMessageId);
      if (!forkContextLoaded) {
        forkContext = await readOpenCodeForkContext(opts);
        forkContextLoaded = true;
      }
      const initialContext = forkContext;
      const contextDigest = initialContext
        ? createHash('sha256').update(initialContext).digest('hex')
        : undefined;
      const promptContent = await readOpenCodeAttachments(
        attachments,
        abort.signal,
      );
      abort.signal.throwIfAborted();
      if (!managedDelegation && managedDelegationEnabled(opts)) {
        const created = await (
          await import('./delegation/service')
        ).createManagedDelegationSession({
          harness: 'opencode',
          sessionKey: key,
          getWindow,
          currentTurn: () => currentTurn,
          currentOptions: () => ({
            ...opts,
            model,
            selectedModel: model,
            thinkingLevel: thinking,
            approvalMode,
            planMode,
          }),
          onTranscript: (delegation, options) => {
            void Promise.resolve(
              emit(
                {
                  type: 'canopy_delegation',
                  delegation,
                  ...(options?.replay ? { canopy_replay: true } : {}),
                },
                delegation.parentTurnId,
              ),
            ).catch((error: unknown) =>
              logMainProcessWarn(
                '[opencode-session] Delegation transcript delivery failed',
                error,
              ),
            );
          },
        });
        if (lifetime.signal.aborted) created.detach();
        else managedDelegation = created;
      }
      const turnModel = model;
      if (
        !turnModel ||
        (getRawOpenCodeModelId(turnModel) && opts.aiCreditsRouting?.active)
      )
        throw new Error('Choose an OpenCode model to use this harness.');
      const serverMode =
        opts.assistantMode === 'app-advisor' && opts.appAdvisorRuntime
          ? ('app-advisor' as const)
          : ('default' as const);
      if (
        opts.assistantMode &&
        opts.assistantMode !== 'default' &&
        serverMode !== 'app-advisor'
      )
        throw new Error(
          'OpenCode is not available for this assistant surface.',
        );
      const proxy = getMcpHttpProxyService();
      const runtime = await openOpenCodeExecutionForWorkerRun(
        'opencodeSessionTurn',
        {
          model: turnModel,
          sessionId: key,
          cwd: opts.cwd,
          signal: abort.signal,
          workspaceId: opts.projectId,
          attribution: () => resolveSessionAiCreditsAttribution(opts),
        },
      );
      const turnEmit = (event: Record<string, unknown>): void | Promise<void> =>
        emit(event, userMessageId);
      const closeTurn = async (): Promise<void> => {
        let failure: Error | undefined;
        const recordFailure = (error: unknown): void => {
          failure ??=
            error instanceof Error
              ? error
              : new Error('OpenCode cleanup failed.');
        };
        for (const cleanup of [
          (): void => approval?.invalidatePending?.(),
          (): void => approval?.dispose(),
          (): void => {
            if (turnState.ownsKeyResources())
              proxy.unregisterRoutesForSession(key);
          },
          (): void => {
            if (turnState.ownsKeyResources())
              proxy.unregisterCanopyWorktreeSessionRoute(key);
          },
        ]) {
          try {
            cleanup();
          } catch (error) {
            recordFailure(error);
          }
        }
        approval = undefined;
        try {
          await runtime.close();
        } catch (error) {
          recordFailure(error);
        }
        if (failure)
          throw runtime.failureError ? runtime.failureError(failure) : failure;
      };
      try {
        assertOpenCodeConnectionGeneration(runtime.generation);
        const profile = getOpenCodeSessionProfile(opts);
        await mkdir(profile, { recursive: true, mode: 0o700 });
        const turnThinking =
          thinking !== undefined && runtime.supportedThinkingLevels?.length
            ? clampThinkingLevelToDeclared(
                thinking,
                runtime.supportedThinkingLevels,
              )
            : undefined;
        let contextReset = contextResetPending;
        const bindingFile = join(profile, 'host-session.json');
        let contextAppliedSessionId: string | undefined;
        let activeBinding:
          | {
              version: 1;
              sessionId: string;
              cwd: string;
              capabilityDigest: string;
              resourceGeneration: number;
              forkContextDigest?: string;
            }
          | undefined;
        const saveBinding = async (
          binding: NonNullable<typeof activeBinding>,
        ): Promise<void> => {
          const temporary = `${bindingFile}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify(binding), {
              mode: 0o600,
              flag: 'wx',
            });
            runtime.signal.throwIfAborted();
            assertOpenCodeConnectionGeneration(runtime.generation);
            await rename(temporary, bindingFile);
          } finally {
            await rm(temporary, { force: true });
          }
        };
        if (sessionId) {
          let binding: unknown;
          try {
            binding = JSON.parse(await readFile(bindingFile, 'utf8'));
          } catch (error) {
            if (
              !(
                error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === 'ENOENT'
              )
            )
              throw error;
          }
          if (
            binding &&
            typeof binding === 'object' &&
            'version' in binding &&
            binding.version !== 1
          )
            throw new Error(
              'This OpenCode session was saved by a different app version. Start a new chat.',
            );
          if (
            !binding ||
            typeof binding !== 'object' ||
            !('version' in binding) ||
            binding.version !== 1 ||
            !('sessionId' in binding) ||
            binding.sessionId !== sessionId ||
            !('cwd' in binding) ||
            binding.cwd !== opts.cwd
          ) {
            sessionId = undefined;
            contextReset = true;
            contextResetPending = true;
          } else if (
            contextDigest &&
            'forkContextDigest' in binding &&
            binding.forkContextDigest === contextDigest
          ) {
            contextAppliedSessionId = sessionId;
          }
        }
        const currentApproval = createApprovalSession({
          sessionKey: key,
          getTurnUserMessageId: () => userMessageId,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          provider: 'opencode',
          workspaceRoot: opts.cwd,
          mode: approvalMode,
          sessionRules: opts.sessionApprovalRules ?? [],
          getWindow,
          promptTimeoutMs: 60_000,
        });
        approval = currentApproval;
        const context = await resolveEffectiveChatPluginContext(
          opts.pluginSelections,
          opts,
          opts.applyGlobalPluginDefaults,
        );
        const preferences =
          context.preferences ?? (await readPreferencesFile());
        const resolved =
          hasAnySelections(context.selections) || opts.packageOverlay
            ? await resolvePlugins(
                context.selections,
                opts.projectId,
                opts.worktreeId,
                opts.chatId,
                {
                  purpose: 'opencode-session',
                  installExternalPlugins: true,
                  enableHttpMcpProxy: true,
                  mcpHttpProxyService: proxy,
                  sessionId: key,
                  packageOverlay: opts.packageOverlay,
                  preferences: context.preferences,
                },
              )
            : undefined;
        const capabilities =
          resolved?.cursorCapabilities ?? emptyCursorCapabilityProjection();
        const capabilityRoot = join(profile, 'selected-capabilities');
        const prepared = await materializeSelectedCapabilityRoot(
          capabilityRoot,
          capabilities,
        );
        for (const warning of resolved?.warnings ?? [])
          logMainProcessWarn(
            '[opencode-session] Capability resolution',
            warning,
          );
        const notices = Array.from(
          new Set(
            [...(resolved?.cursorNotices ?? []), ...prepared.warnings].map(
              (warning) => warning.split('Cursor').join('OpenCode'),
            ),
          ),
        );
        const unannounced = notices.filter(
          (notice) => !announcedNotices.has(notice),
        );
        if (unannounced.length) {
          await turnEmit({
            type: 'canopy_assistant_patch',
            messageId: `${turnId}:capabilities`,
            timestamp: Date.now(),
            revision: 1,
            role: 'system',
            patches: [
              {
                index: 0,
                block: {
                  type: 'text',
                  text: `Some selections are not available in OpenCode chats:\n- ${unannounced.join('\n- ')}`,
                },
              },
            ],
          });
          for (const notice of unannounced) announcedNotices.add(notice);
        }
        const names = cursorCanopyMcpServerNames(serverMode);
        const cowork = isCoworkWorkspace(opts.projectId);
        // Reuse the existing full interactive MCP tool allowlist and policy.
        const toolSurface = cowork
          ? ('opencode-acp-standalone' as const)
          : ('opencode-acp' as const);
        let mcpSnapshot: OpenCodeCapabilitySnapshot['mcp'] = [];
        const approved = new Map<string, number>();
        const checkMcp = async (
          server: string,
          tool: string,
          args: unknown,
          callId: string,
        ): Promise<boolean> => {
          assertOpenCodeConnectionGeneration(runtime.generation);
          if (
            !(await openCodeMcpCallMatchesSnapshot(
              mcpSnapshot,
              server,
              tool,
              args,
              {
                validate: validateOpenCodeMcpSchema,
                signal: runtime.signal,
              },
            ))
          )
            return false;
          runtime.signal.throwIfAborted();
          assertOpenCodeConnectionGeneration(runtime.generation);
          const outcome = await authorizeCursorMcpTool(
            { server, tool, args },
            {
              approval: currentApproval,
              cwd: opts.cwd,
              toolCallId: `${turnId}:${callId}`,
              planMode,
              mode: serverMode,
              toolSurface,
              signal: runtime.signal,
              providerLabel: 'OpenCode',
              managedToolNames: managedDelegation?.tools.map(
                (tool) => tool.name,
              ),
            },
          );
          if (outcome.stopTurn) abort.abort();
          return !runtime.signal.aborted && outcome.decision === 'allow';
        };
        const gate = async (
          server: string,
          tool: string,
          args: unknown,
          callId: string,
        ): Promise<boolean> => {
          assertOpenCodeConnectionGeneration(runtime.generation);
          if (runtime.signal.aborted) return false;
          if (
            server === names.main &&
            isWatchDelegatesCompatibilityName(tool, 'opencode')
          )
            return true;
          const identity = copilotMcpCallIdentity(server, tool, args);
          const count = approved.get(identity) ?? 0;
          if (count) {
            if (count === 1) approved.delete(identity);
            else approved.set(identity, count - 1);
            return true;
          }
          return checkMcp(server, tool, args, callId);
        };
        const token = randomBytes(32).toString('base64url');
        await proxy.registerCanopyWorktreeSessionRoute({
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          interfaceTools: opts.interfaceTools ?? [],
          assistantMode: opts.assistantMode,
          ...(serverMode === 'app-advisor'
            ? { appAdvisorRuntime: opts.appAdvisorRuntime }
            : {}),
          cwd: opts.cwd,
          repoId: opts.selectedRepoId,
          sdkSessionId: sessionId ?? key,
          providerType: 'opencode',
          model: turnModel,
          authToken: token,
          createdAt: Date.now(),
          hookHandler: () => undefined,
          toolSurface,
          pluginSelections: context.selections,
          deferredToolsAllowed: opts.deferredToolsAllowed !== false,
          ...(managedDelegation
            ? {
                managedDelegation: {
                  tools: managedDelegation.mcpTools,
                  invoke: async (
                    name,
                    input,
                    transport,
                  ): Promise<{ text: string; isError: boolean }> => {
                    if (
                      !transport?.requestId ||
                      currentTurn !== turnId ||
                      runtime.signal.aborted ||
                      !managedDelegation ||
                      !(await gate(
                        names.main,
                        name,
                        input,
                        transport.requestId,
                      ))
                    )
                      return {
                        text: 'The owning OpenCode turn is unavailable or the call was denied.',
                        isError: true,
                      };
                    const result = await managedDelegation.parent.invokeCursor(
                      name,
                      input,
                      { callId: transport.requestId, turnId },
                    );
                    return {
                      text: JSON.stringify(result),
                      isError: !result.ok,
                    };
                  },
                },
              }
            : {}),
          codeGraphToolsAdvertised,
          onAwaitingUser: () => {
            turnState.markTurnAwaitingUser();
            awaitingUser = true;
            if (lifecycleTurnId)
              lifecycleProducer.sessionState({
                ...(sessionId ? { providerSessionId: sessionId } : {}),
                state: 'requires_action',
                source: 'provider',
                observedDuringTurnId: lifecycleTurnId,
              });
          },
          autoArchiveAvailable: true,
          authorizeToolCall: (toolKey, args, call) => {
            const tool =
              serverMode === 'app-advisor'
                ? hasToolKey(APP_ADVISOR_TOOL_REGISTRY, toolKey)
                  ? APP_ADVISOR_TOOL_REGISTRY[toolKey].displayName
                  : undefined
                : hasToolKey(CANOPY_INJECTED_TOOL_REGISTRY, toolKey)
                  ? CANOPY_INJECTED_TOOL_REGISTRY[toolKey].displayName
                  : undefined;
            return tool
              ? gate(
                  toolKey === 'ask_user_question' ? names.ui : names.main,
                  tool,
                  args,
                  call?.requestId ?? randomUUID(),
                )
              : Promise.resolve(false);
          },
        });
        const servers = buildOpenCodeMcpServers({
          mode: serverMode,
          mainUrl: proxy.getCanopyWorktreeMcpUrl(key),
          uiUrl: proxy.getCanopyWorktreeUiMcpUrl(key),
          authToken: token,
          definitions: resolved?.mcpServers ?? {},
          cwd: opts.cwd,
        });
        mcpSnapshot = await snapshotOpenCodeMcpTools(
          servers,
          Object.fromEntries(
            servers.map((server) => [
              server.name,
              server.name === names.main || server.name === names.ui
                ? { app: server.name, surface: toolSurface }
                : {
                    binding: resolved?.mcpServerBindings[server.name],
                    definition: resolved?.mcpServerBindings[server.name]
                      ? undefined
                      : openCodeCapabilityDigest(
                          resolved?.mcpServers[server.name],
                        ),
                  },
            ]),
          ),
          opts.cwd,
          runtime.signal,
        );
        const serverByUrl = new Map(
          servers.flatMap((server) =>
            'url' in server ? [[server.url, server.name] as const] : [],
          ),
        );
        proxy.setSessionToolCallGate(key, (call) => {
          const server = serverByUrl.get(call.proxyUrl);
          return server
            ? gate(server, call.tool, call.args, call.requestId ?? randomUUID())
            : Promise.resolve(false);
        });
        const expanded = expandLeadingCursorCommand(
          prompt,
          capabilities.commands.filter((command) =>
            prepared.commandIds.includes(command.id),
          ),
        );
        const memoryPolicy = await resolveLocalMemoryPolicy(opts);
        const result = await runOpenCodeTurn(
          {
            ...runtime,
            cwd: opts.cwd,
            profileDir: profile,
            rawModelId: runtime.rawModelId,
            model: turnModel,
            sessionId,
            thinkingLevel: turnThinking,
            resumePolicy: 'recover',
            contextReset,
            capabilityChanges: 'announce',
            capabilityRoots: [capabilityRoot],
            capabilityContext: {
              selections: context.selections,
              commands: prepared.commandIds,
              skills: prepared.skillIds,
              globalInstructions:
                opts.globalInstructionsSnapshot ?? opts.globalInstructionsBlock,
              systemPrompt: opts.systemPromptAppend,
              planMode,
              approvalMode,
              providerSettingsSources: runtime.inferenceRoute
                ? ['host-inference']
                : ['managed-provider-config', 'native-opencode-auth'],
            },
            mcpSnapshot,
            signal: runtime.signal,
            promptContent,
            ...(initialContext
              ? {
                  initialContext: {
                    text: initialContext,
                    appliedSessionId: contextAppliedSessionId,
                  },
                }
              : {}),
            prompt:
              managedDelegation?.applyPolicyGuidance(expanded) ?? expanded,
            instructions: [
              managedDelegation?.systemPromptGuidance,
              serverMode === 'app-advisor' &&
              opts.deferredToolsAllowed !== false
                ? buildDeferredToolsGuidance('opencode')
                : undefined,
              opts.globalInstructionsSnapshot ?? opts.globalInstructionsBlock,
              opts.systemPromptAppend,
              ...capabilities.skills
                .filter((skill) => prepared.skillIds.includes(skill.id))
                .map(
                  (skill) =>
                    `Selected skill ${skill.label}: ${skill.description}\nRead ${JSON.stringify(join(capabilityRoot, 'skills', skill.id, 'SKILL.md'))} for its instructions.`,
                ),
              serverMode === 'app-advisor'
                ? 'Use the supplied Orchestrator tools to help with the app.'
                : cowork
                  ? buildCoworkInjectedToolPrompt(
                      'opencode',
                      false,
                      opts.deferredToolsAllowed !== false,
                    )
                  : buildWorktreeInjectedToolPrompt(
                      'opencode',
                      codeGraphToolsAdvertised,
                      true,
                      false,
                      opts.deferredToolsAllowed !== false,
                    ),
              serverMode === 'default'
                ? buildLocalMemoryPromptNudge(
                    preferences.localMemoryEnabled === true,
                    memoryPolicy.kind === 'scoped' &&
                      memoryPolicy.privateMemory,
                  )
                : undefined,
              planMode
                ? [
                    'Plan mode is read-only. Do not change files or run shell commands.',
                    buildCodexPlanModeDeveloperInstructions('optional').replace(
                      'use request_user_input',
                      'use the supplied Ask User Question tool',
                    ),
                    'To revise a plan in this mode, return the complete updated <proposed_plan> block. Do not edit the saved plan file.',
                  ].join('\n')
                : DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
              'Use the supplied app tools directly. Native subagents, background scheduling, remote sessions, and plugin installation are unavailable. Do not work around denied operations.',
            ]
              .filter(Boolean)
              .join('\n\n'),
            mcpServers: servers,
          },
          {
            displayTool: (tool) => {
              const identity = resolveOpenCodeMcpCall(
                tool.name,
                servers,
                serverMode,
                managedDelegation?.tools.map((tool) => tool.name),
                mcpSnapshot,
              );
              return identity
                ? {
                    name: `mcp__${identity.server}__${identity.tool}`,
                    input: tool.input,
                  }
                : openCodeToolDisplay(tool, opts.cwd);
            },
            emit: turnEmit,
            onSessionCleared: () => {
              sessionId = undefined;
              contextResetPending = true;
            },
            onSession: async (id, snapshot) => {
              activeBinding = {
                version: 1,
                sessionId: id,
                cwd: opts.cwd,
                capabilityDigest: snapshot.digest,
                resourceGeneration: snapshot.generation,
                ...(contextAppliedSessionId === id && contextDigest
                  ? { forkContextDigest: contextDigest }
                  : {}),
              };
              await saveBinding(activeBinding);
              sessionId = id;
              contextResetPending = false;
            },
            authorize: async (input) => {
              assertOpenCodeConnectionGeneration(runtime.generation);
              const identity = resolveOpenCodeMcpCall(
                input.toolName,
                servers,
                serverMode,
                managedDelegation?.tools.map((tool) => tool.name),
                mcpSnapshot,
              );
              if (identity) {
                const allowed = await checkMcp(
                  identity.server,
                  identity.tool,
                  input.toolArgs,
                  input.toolCallId,
                );
                if (allowed && identity.http) {
                  if (approved.size >= 1024) return { decision: 'deny' };
                  const key = copilotMcpCallIdentity(
                    identity.server,
                    identity.tool,
                    input.toolArgs,
                  );
                  approved.set(key, (approved.get(key) ?? 0) + 1);
                }
                return { decision: allowed ? 'allow' : 'deny' };
              }
              const outcome = await authorizeOpenCodeNativeTool(input, {
                cwd: opts.cwd,
                approval: currentApproval,
                planMode,
                signal: runtime.signal,
                toolUseId: `${turnId}:${input.toolCallId}`,
              });
              if (outcome.stopTurn) abort.abort();
              if (
                outcome.decision === 'allow' &&
                !outcome.stopTurn &&
                rtkEnabled &&
                (input.toolName === 'shell' || input.toolName === 'bash') &&
                input.toolArgs &&
                typeof input.toolArgs === 'object' &&
                'command' in input.toolArgs &&
                typeof input.toolArgs.command === 'string'
              ) {
                const command = await runRtkRewrite(
                  input.toolArgs.command,
                  {
                    rtkBinaryPath: getBundledRtkBinaryPath(),
                    env: {
                      ...getEnhancedEnv({
                        includeCanopySecrets: false,
                        environment: false,
                      }),
                      ...getRtkManagedEnv(),
                    },
                  },
                  runtime.signal,
                );
                if (command)
                  return {
                    ...outcome,
                    updatedInput: { ...input.toolArgs, command },
                  };
              }
              return outcome;
            },
          },
        );
        if (
          contextDigest &&
          !result.isError &&
          !result.cancelled &&
          result.sessionId &&
          activeBinding?.sessionId === result.sessionId
        ) {
          // Persist before the outer terminal event. Failed/cancelled turns retry the seed.
          await saveBinding({
            ...activeBinding,
            forkContextDigest: contextDigest,
          });
        }
        if (result.diagnostics)
          getObservabilityService().recordSessionDiagnostic({
            version: 1,
            timestamp: new Date().toISOString(),
            kind: 'opencode_ignored_updates',
            sessionKey: key,
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            providerType: 'opencode',
            turnUserMessageId: userMessageId,
            opencodeRuntimeVersion: runtime.runtimeIdentity?.version,
            opencodeUpdates: result.diagnostics,
          });
        const failure =
          result.isError || (result.cancelled && !abort.signal.aborted)
            ? runtime.failureError?.(result.message, result.requestRejected)
            : undefined;
        return {
          type: 'result',
          is_error: result.isError || Boolean(failure),
          result: failure?.message || result.message || result.responseText,
          ...openCodeFailureStatus(failure),
          ...(result.cancelled && !failure ? { subtype: 'cancelled' } : {}),
          usage: result.usage,
        };
      } catch (error) {
        throw !abort.signal.aborted && runtime.failureError
          ? runtime.failureError(error)
          : error;
      } finally {
        await closeTurn();
      }
    };

    const session: AgentSession = {
      sendMessage(text, sendOptions): void {
        if (lifetime.signal.aborted)
          throw new Error('OpenCode session has ended.');
        if (active)
          throw new Error('Wait for the current OpenCode turn to finish.');
        const planningTurn = planMode;
        const planningModel = model;
        const abort = new AbortController();
        const turnId = sendOptions?.userMessageId ?? randomUUID();
        currentTurn = turnId;
        const lifecycleTurn = sendOptions?.lifecycleExecutionId ?? turnId;
        lifecycleTurnId = lifecycleTurn;
        const lifecycleBinding: TurnBinding = {
          turnId: lifecycleTurn,
          origin: 'user',
          binding: sendOptions?.userMessageId ? 'bound' : 'unbound',
          submissionIds: [],
          userMessageIds: sendOptions?.userMessageId
            ? [sendOptions.userMessageId]
            : [],
          providerUserMessageUuids: [],
        };
        awaitingUser = false;
        lifecycleProducer.turnStarted({
          ...lifecycleBinding,
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          phase: 'start',
          startedAtMs: Date.now(),
        });
        if (sendOptions?.userMessageId !== undefined)
          observeRoutedTurnBinding(
            lifecycleScope,
            session,
            [sendOptions.userMessageId],
            undefined,
            lifecycleTurn,
          );
        lifecycleProducer.sessionState({
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          state: 'running',
          source: 'provider',
          observedDuringTurnId: lifecycleTurn,
        });
        const deferredLoadIds = new Set<string>();
        const buffer = new CursorEventBuffer(async (event) => {
          await onEvent(event);
          await drainChatSessionEvents(
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
          );
          if (
            !abort.signal.aborted &&
            currentTurn === turnId &&
            opts.deferredToolsAllowed !== false
          ) {
            const serverMode =
              opts.assistantMode === 'app-advisor' && opts.appAdvisorRuntime
                ? 'app-advisor'
                : 'default';
            for (const receipt of openCodeDeferredResultReceipts(
              event,
              cursorCanopyMcpServerNames(serverMode).main,
              deferredLoadIds,
            )) {
              // Do not await continuation here: it must retire this turn first.
              deferredToolsReloadCoordinator.markOpenCodeResultDelivered(
                opts,
                receipt,
              );
            }
          }
        });
        output = buffer;
        turnState.markTurnActive(sendOptions?.userMessageId);
        const attachments = sendOptions?.attachments
          ? {
              ...sendOptions.attachments,
              paths: [...sendOptions.attachments.paths],
            }
          : undefined;
        const done = run(
          text,
          turnId,
          abort,
          sendOptions?.userMessageId,
          attachments,
        )
          .catch((error: unknown) => ({
            type: 'result',
            ...openCodeFailureStatus(error),
            is_error: !abort.signal.aborted,
            result: abort.signal.aborted
              ? 'Turn cancelled'
              : error instanceof Error
                ? error.message
                : 'OpenCode chat failed.',
            ...(abort.signal.aborted ? { subtype: 'cancelled' } : {}),
          }))
          .then(async (result) => {
            await buffer.flush();
            await drainChatSessionEvents(
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
            );
            const isCurrent = (): boolean =>
              !abort.signal.aborted &&
              !lifetime.signal.aborted &&
              currentTurn === turnId &&
              planMode &&
              model === planningModel;
            const proposedPlan =
              planningTurn &&
              !result.is_error &&
              result.subtype !== 'cancelled' &&
              typeof result.result === 'string'
                ? extractProposedPlan(result.result)
                : undefined;
            if (proposedPlan && isCurrent()) {
              await publishOpenCodePlanProposal({
                projectId: opts.projectId,
                worktreeId: opts.worktreeId,
                chatId: opts.chatId,
                plan: proposedPlan,
                userMessageId: sendOptions?.userMessageId,
                isCurrent,
                getWindow,
              });
            }
            return result;
          })
          .catch((error: unknown) => ({
            type: 'result',
            ...openCodeFailureStatus(error),
            is_error: true,
            result:
              error instanceof Error
                ? error.message
                : 'OpenCode output could not be saved.',
          }))
          .then(async (result: Record<string, unknown>) => {
            active = undefined;
            output = undefined;
            turnState.markTurnIdle();
            awaitingUser = false;
            const outcome =
              abort.signal.aborted || result.subtype === 'cancelled'
                ? 'cancelled'
                : result.is_error === true
                  ? 'failed'
                  : 'completed';
            lifecycleProducer.turnEnded({
              ...lifecycleBinding,
              ...(sessionId ? { providerSessionId: sessionId } : {}),
              endedAtMs: Date.now(),
              outcome,
              // A completed turn's result is its reply, not a reason.
              ...(outcome !== 'completed' && typeof result.result === 'string'
                ? { terminalReason: result.result }
                : {}),
              source: 'result',
            });
            lifecycleProducer.sessionState({
              ...(sessionId ? { providerSessionId: sessionId } : {}),
              state: 'idle',
              source: 'result-fallback',
              observedDuringTurnId: lifecycleTurn,
            });
            await emit(
              result.is_error
                ? {
                    type: 'error',
                    error: result.result,
                    ...openCodeFailureStatus(result),
                  }
                : result,
              sendOptions?.userMessageId,
            );
          });
        active = { abort, done };
      },
      isDisposed: () => lifetime.signal.aborted,
      getProviderSessionId: () => sessionId,
      cancel: async () => {
        const turn = active;
        turn?.abort.abort();
        approval?.invalidatePending?.();
        managedDelegation?.retireTurn();
        await turn?.done;
      },
      destroy: async () => {
        lifetime.abort();
        try {
          await session.cancel();
          managedDelegation?.detach();
        } finally {
          releaseTurnLifecycleProducer('opencode', lifecycleScope);
        }
      },
      setManagedDelegationMode: (mode): Promise<void> => {
        opts.managedDelegationMode = mode;
        if (mode !== undefined) managedDelegation?.updatePolicy(mode);
        return Promise.resolve();
      },
      setRtkEnabled: (enabled): Promise<void> => {
        rtkEnabled = enabled;
        return Promise.resolve();
      },
      setPlanMode: (enabled): Promise<void> => {
        if (active)
          return Promise.reject(
            new Error('Stop OpenCode before changing plan mode.'),
          );
        planMode = enabled;
        return Promise.resolve();
      },
      setApprovalMode: (mode): Promise<void> => {
        approvalMode = mode;
        approval?.setMode(mode);
        return Promise.resolve();
      },
      setThinkingLevel: (level): Promise<void> => {
        thinking = level;
        return Promise.resolve();
      },
      setModel: (next): Promise<void> => {
        if (!isOpenCodeModel(next) && !resolveGatewayModelEntry(next))
          return Promise.reject(new Error('Choose an OpenCode model.'));
        model = next;
        return Promise.resolve();
      },
    };
    registerSession(
      key,
      session,
      lifetime,
      'opencode',
      opts.model,
      opts.assistantMode,
      opts.toolProfileHash,
      codeGraphToolsAdvertised,
      'opencode',
    );
    return session;
  }
}
