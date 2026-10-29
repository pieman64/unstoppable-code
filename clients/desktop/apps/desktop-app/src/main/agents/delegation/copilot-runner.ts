import {
  capabilityFiles,
  capabilityInstructionIdentity,
} from '@canopy/desktop-shared/node/capabilities/file-snapshot';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
} from 'node:fs/promises';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { Tool, ToolResultObject } from '@github/copilot-sdk';
import { expandLeadingCursorCommand } from '@canopy/desktop-shared/lib/cursor-capabilities';
import { BRAND } from '@canopy/brand/current';
import {
  LocalDelegationRunner,
  type LocalDelegationContext,
} from '@canopy/desktop-shared/node/delegation/local-runner';
import type { DelegationParent } from '@canopy/desktop-shared/node/delegation/parent';
import type {
  ResolvedAgentRouteSnapshot,
  RunnerAvailability,
} from '@canopy/desktop-shared/node/delegation';
import {
  copilotNativeOperations,
  isCopilotShellControl,
} from '@canopy/desktop-shared/node/copilot/tool-input';
import { CopilotToolCorrelation } from '@canopy/desktop-shared/node/copilot/tool-correlation';
import {
  createCopilotCapabilitySnapshot,
  isCopilotCapabilitySnapshot,
  type CopilotCapabilitySnapshot,
} from '@canopy/desktop-shared/node/copilot/capability-snapshot';
import { COPILOT_RUNTIME_VERSION } from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import { COPILOT_NATIVE_TOOLS } from '@canopy/desktop-shared/node/copilot/session-policy';
import { getMcpHttpProxyService } from '../../mcp/http-proxy-service';
import { runCopilotTurn } from '@canopy/desktop-shared/node/copilot/turn-driver';
import {
  assertCopilotMcpServersConnected,
  collectCopilotMcpSecretValues,
} from '@canopy/desktop-shared/node/copilot/tool-snapshot';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import type {
  CopilotPreToolInput,
  CopilotToolDecision,
} from '@canopy/desktop-shared/node/copilot/session-policy';
import {
  openManagedCopilotRuntime,
  assertCopilotConnectionGeneration,
} from '../../copilot/connection';
import { buildCopilotMcpServers } from '../../copilot/mcp-servers';
import { buildCursorCapabilityProjection } from '../../plugins/plugin-resolver';
import type { DelegationNativePolicy } from './native-policy';
import type { DelegateCanopyTools } from './canopy-tools';
import { delegateAppToolGuidance } from './canopy-tools';
import { childDelegationGuidance } from './child-tools';
import { DelegationTranscriptRecorder } from './transcript-recorder';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toolParameters(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) throw new Error('Invalid Copilot tool parameters.');
  return schema;
}

export interface CopilotDelegationPreparation {
  readonly model: string;
  readonly profileDir: string;
  readonly tools: DelegationNativePolicy;
  readonly appTools?: DelegateCanopyTools;
  readonly retainedReadRoots: readonly string[];
  readonly plugins: readonly { path: string }[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
}

export async function authorizeDelegatedCopilotTool(
  input: CopilotPreToolInput,
  tools: DelegationNativePolicy,
  signal: AbortSignal,
  callId: string,
): Promise<CopilotToolDecision> {
  // Root authorization cannot filter private descendants returned by native searches.
  if (signal.aborted || input.toolName === 'grep' || input.toolName === 'glob')
    return { decision: 'deny' };
  if (isCopilotShellControl(input.toolName, input.toolArgs)) {
    const allowed = await tools.hasLiveAuthority();
    return { decision: allowed && !signal.aborted ? 'allow' : 'deny' };
  }
  const operations = copilotNativeOperations(
    input.toolName,
    input.toolArgs,
    tools.cwd,
  );
  if (!operations?.length) return { decision: 'deny' };
  for (const operation of operations) {
    if (
      signal.aborted ||
      !(await tools.authorize(operation.tool, operation.input, callId))
    )
      return { decision: 'deny' };
    // Native view also accepts directories, whose listings bypass per-file grants.
    if (operation.tool === 'Read') {
      const file = operation.input.file_path;
      if (
        typeof file !== 'string' ||
        !(await lstat(file).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        return { decision: 'deny' };
    }
  }
  return { decision: signal.aborted ? 'deny' : 'allow' };
}

export function createCopilotDelegationRunner(options: {
  available(route: ResolvedAgentRouteSnapshot): Promise<RunnerAvailability>;
  prepare(
    context: LocalDelegationContext,
  ): Promise<CopilotDelegationPreparation>;
  delegation?(context: LocalDelegationContext): DelegationParent | undefined;
  reportError(error: unknown): void;
}): LocalDelegationRunner {
  return new LocalDelegationRunner(
    'copilot',
    'copilot-sdk',
    (route) => options.available(route),
    async (context) => {
      const prepared = await options.prepare(context);
      const { request, signal } = context;
      const delegation = options.delegation?.(context);
      if (delegation)
        context.retain(() => {
          delegation.detach();
          return Promise.resolve();
        });
      const runtime = await openManagedCopilotRuntime({
        signal,
        cwd: prepared.tools.cwd,
        workspaceId: request.parent.projectId,
        restrictedEnvironment: true,
      });
      context.retain(() => runtime.close());
      context.setInterrupt(() => runtime.close());
      const account = runtime.account;
      if (
        !account ||
        createHash('sha256').update(JSON.stringify(account)).digest('hex') !==
          request.route.authAccountKey
      )
        throw new Error(
          'The selected Copilot account changed before the task started.',
        );
      await mkdir(prepared.profileDir, { recursive: true, mode: 0o700 });
      const bindingFile = path.join(prepared.profileDir, 'host-session.json');
      let savedSnapshot: CopilotCapabilitySnapshot | undefined;
      let savedNativeSnapshot: CopilotCapabilitySnapshot | undefined;
      if (request.resumeSessionId) {
        const saved: unknown = JSON.parse(await readFile(bindingFile, 'utf8'));
        if (
          !isRecord(saved) ||
          saved.sessionId !== request.resumeSessionId ||
          saved.cwd !== prepared.tools.cwd ||
          !isRecord(saved.account) ||
          saved.account.host !== account.host ||
          saved.account.login !== account.login
        )
          throw new Error(
            'This Copilot task belongs to another account or workspace.',
          );
        if (
          saved.version !== 3 ||
          saved.runtimeVersion !== COPILOT_RUNTIME_VERSION ||
          !isCopilotCapabilitySnapshot(saved.capabilitySnapshot) ||
          !isCopilotCapabilitySnapshot(saved.nativeToolSnapshot)
        )
          throw new Error(
            'This Copilot task has incompatible saved configuration. Start a new task.',
          );
        savedSnapshot = saved.capabilitySnapshot;
        savedNativeSnapshot = saved.nativeToolSnapshot;
      }
      const notices: string[] = [],
        warnings: string[] = [];
      const projection = buildCursorCapabilityProjection(
        [],
        prepared.plugins.map((plugin, index) => ({
          pluginPath: plugin.path,
          pluginName: `selection-${index + 1}`,
          marketplaceId: 'retained',
          category: 'local',
          provider: 'claude',
          mode: 'native',
        })),
        new Set(prepared.plugins.map((plugin) => plugin.path)),
        notices,
        warnings,
      );
      const capabilityRoot = path.join(
        prepared.profileDir,
        'selected-capabilities',
      );
      const selected = await materializeSelectedCapabilityRoot(
        capabilityRoot,
        projection,
        { verifyContent: true, signal },
      );
      if (notices.length || warnings.length || selected.warnings.length)
        throw new Error(
          'Retained Copilot capabilities could not be loaded completely.',
        );
      const commands = projection.commands.filter((command) =>
        selected.commandIds.includes(command.id),
      );
      const commandGuidance = commands
        .map(
          (command) =>
            `Selected command /${command.id}: ${command.description}\nRead ${JSON.stringify(path.join(capabilityRoot, 'commands', `${command.id}.md`))} for its instructions.`,
        )
        .join('\n');
      const check = (): void => {
        signal.throwIfAborted();
        assertCopilotConnectionGeneration(runtime.generation);
      };
      const tools: Tool[] = [
        ...(delegation?.projection.tools ?? []),
        ...(prepared.appTools?.tools ?? []),
      ].map((definition) => ({
        name: definition.name,
        description: definition.description,
        parameters: toolParameters(definition.inputSchema),
        handler: async (args, invocation): Promise<ToolResultObject> => {
          check();
          const appTool = prepared.appTools?.tools.find(
            (tool) => tool.name === definition.name,
          );
          const callSignal = invocation.signal
            ? AbortSignal.any([signal, invocation.signal])
            : signal;
          const denied = {
            textResultForLlm: 'Tool call was denied.',
            resultType: 'denied' as const,
          };
          if (callSignal.aborted) return denied;
          if (appTool && prepared.appTools) {
            const result = await prepared.appTools.execute(appTool, args, {
              callId: invocation.toolCallId,
              signal: callSignal,
            });
            return {
              textResultForLlm: result.text,
              resultType: result.isError ? 'failure' : 'success',
            };
          }
          if (
            !delegation?.ownsTool(definition.name) ||
            !(await prepared.tools.authorizeAppTool(
              BRAND.tools.namespace,
              definition.name,
              [
                'WatchDelegates',
                'GetDelegateOutput',
                'InspectDelegate',
                'ListDelegates',
              ].includes(definition.name),
              invocation.toolCallId,
              callSignal,
            ))
          )
            return denied;
          const turnId = delegation.options.currentTurn();
          if (!turnId || callSignal.aborted) return denied;
          const result = await delegation.invokeCursor(definition.name, args, {
            callId: invocation.toolCallId,
            turnId,
          });
          return {
            textResultForLlm: JSON.stringify(result),
            resultType: result.ok ? 'success' : 'failure',
          };
        },
      }));
      const mcpServers = buildCopilotMcpServers({
        definitions: { ...prepared.mcpServers },
        cwd: prepared.tools.cwd,
      });
      if (
        prepared.retainedReadRoots.some(
          (root) => !root || !prepared.tools.readRoots.includes(root),
        )
      )
        throw new Error('Retained capability files require a read grant.');
      const capabilitySnapshot = createCopilotCapabilitySnapshot({
        surface: 'delegate',
        policyVersion: 1,
        model: prepared.model,
        reasoningEffort: request.route.effectiveThinkingLevel,
        files: await capabilityFiles(
          [capabilityRoot, ...prepared.retainedReadRoots],
          signal,
          'Copilot',
        ),
        skills: selected.skillIds,
        commands: commands.map(({ id, description, markdown }) => ({
          id,
          description,
          markdown,
        })),
        instructions: capabilityInstructionIdentity(
          prepared.tools.capabilityInstructions(),
          prepared.retainedReadRoots,
        ),
        appGuidance: delegateAppToolGuidance(prepared.appTools, 'copilot'),
        childGuidance: childDelegationGuidance(delegation),
        tools: tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })),
        mcp: getMcpHttpProxyService().getMcpCapabilityDigests({
          ...prepared.mcpServers,
        }),
        nativeTools: COPILOT_NATIVE_TOOLS,
        discovery: 'explicit-only',
        mcpTable: 'complete-replacement-per-turn',
      });
      if (savedSnapshot && savedSnapshot.digest !== capabilitySnapshot.digest)
        throw new Error(
          "This Copilot task's configuration changed. Start a new task.",
        );
      let nativeToolSnapshot: CopilotCapabilitySnapshot | undefined;
      const correlation = new CopilotToolCorrelation();
      const transcript = new DelegationTranscriptRecorder();
      let lastFlush = 0;
      const flush = async (): Promise<void> => {
        const items = transcript.take();
        if (items) await context.emit({ type: 'transcript', items });
      };
      const result = await runCopilotTurn({
        runtime,
        gitHubTokenProvider: runtime.auth.tokenProvider,
        workingDirectory: prepared.tools.cwd,
        configDirectory: prepared.profileDir,
        model: prepared.model,
        sessionId: request.resumeSessionId,
        turnId: `${request.delegationId}:${request.runGeneration}`,
        prompt: `Managed delegated task:\n${expandLeadingCursorCommand(request.task.prompt, commands)}`,
        signal,
        reasoningEffort:
          request.route.effectiveThinkingLevel === 'off' ||
          request.route.effectiveThinkingLevel === 'ultra'
            ? undefined
            : request.route.effectiveThinkingLevel,
        systemPrompt: `${prepared.tools.instructions()}${childDelegationGuidance(delegation)}${delegateAppToolGuidance(prepared.appTools, 'copilot')}\n${commandGuidance}\nUse native file tools under the supplied grants. Native grep, glob, and directory views are unavailable because their results could expose private files. Read specific files directly. Shell follows the parent's command approval policy; file grants do not sandbox shell commands. Native subagents, detached commands, user questions and schedulers are unavailable.`,
        skillDirectories: selected.skillIds.length
          ? [path.join(capabilityRoot, 'skills')]
          : [],
        tools,
        mcpServers,
        onEvent: (event) => correlation.observe(event),
        authorize: async (input) => {
          check();
          const identity = correlation.take(input.toolName, input.toolArgs);
          if (tools.some((tool) => tool.name === input.toolName))
            return { decision: 'allow' }; // Execution handler enforces the grant.
          if (identity?.server && identity.tool)
            return {
              decision:
                mcpServers[identity.server] &&
                (await prepared.tools.canUseMcp(
                  identity.server,
                  identity.tool,
                  signal,
                ))
                  ? 'allow'
                  : 'deny',
            }; // Every retained transport has its own execution gate.
          return authorizeDelegatedCopilotTool(
            input,
            prepared.tools,
            signal,
            identity?.id ?? randomUUID(),
          );
        },
        onToolsReady: (snapshot, mcpReadiness) => {
          check();
          assertCopilotMcpServersConnected(
            mcpReadiness,
            collectCopilotMcpSecretValues(mcpServers),
          );
          if (
            savedNativeSnapshot &&
            savedNativeSnapshot.digest !== snapshot.digest
          )
            throw new Error(
              "This Copilot task's tools changed. Start a new task.",
            );
          nativeToolSnapshot = snapshot;
        },
        onSession: async (sessionId) => {
          if (!nativeToolSnapshot)
            throw new Error(
              'Copilot could not verify the initialized tool list.',
            );
          const temporary = `${bindingFile}.${randomUUID()}.tmp`;
          try {
            await writeFile(
              temporary,
              JSON.stringify({
                version: 3,
                sessionId,
                cwd: prepared.tools.cwd,
                account,
                runtimeVersion: COPILOT_RUNTIME_VERSION,
                capabilitySnapshot,
                nativeToolSnapshot,
              }),
              { mode: 0o600, flag: 'wx' },
            );
            check();
            await rename(temporary, bindingFile);
          } finally {
            await rm(temporary, { force: true });
          }
          await context.emit({ type: 'started', nativeSessionId: sessionId });
        },
        emit: async (event) => {
          transcript.cursor(event);
          if (transcript.limitExceeded)
            throw new Error(
              'Copilot task transcript exceeded retention limits.',
            );
          if (Date.now() - lastFlush >= 100) {
            lastFlush = Date.now();
            await flush();
          }
        },
      });
      await flush();
      const usage = {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        cachedInputTokens: result.usage.cache_read_input_tokens,
        cacheCreationInputTokens: result.usage.cache_creation_input_tokens,
      };
      await context.emit({ type: 'usage', usage });
      return { status: 'completed', finalText: result.text, usage };
    },
    (error) => options.reportError(error),
  );
}
