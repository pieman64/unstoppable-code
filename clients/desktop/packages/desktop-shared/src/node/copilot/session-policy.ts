import type {
  GitHubTokenProvider,
  PermissionHandler,
  SessionConfig,
} from '@github/copilot-sdk';

export type CopilotPreToolInput = Parameters<
  NonNullable<NonNullable<SessionConfig['hooks']>['onPreToolUse']>
>[0];

/** Native subagents, schedulers, remote control and installers are host-owned. */
export const COPILOT_NATIVE_TOOLS = [
  'view',
  'create',
  'edit',
  'glob',
  'grep',
  'bash',
  'read_bash',
  'stop_bash',
  'list_bash',
  'powershell',
  'read_powershell',
  'stop_powershell',
  'list_powershell',
  'web_fetch',
  'web_search',
  'ask_user',
] as const;

/**
 * Built-in servers the runtime configures from the session's GitHub identity
 * even when started with `--disable-builtin-mcps`, so each session disables
 * them by name. `github-mcp-server` is the name the runtime and its bundled
 * agent definitions use (`github-mcp-server/<tool>`). Hosts leave out any
 * selected server that shares one of these names.
 */
export const COPILOT_BUILTIN_MCP_SERVERS = ['github-mcp-server'] as const;

export interface CopilotToolDecision {
  decision: 'allow' | 'deny';
  message?: string;
  /** Host-authorized command rewriting, e.g. the shared RTK wrapper. */
  modifiedArgs?: unknown;
}

export interface CopilotSessionPolicy {
  workingDirectory: string;
  configDirectory: string;
  model: string;
  reasoningEffort?: SessionConfig['reasoningEffort'];
  signal: AbortSignal;
  authorize(input: CopilotPreToolInput): Promise<CopilotToolDecision>;
  /** Enterprise asks must use an explicit approval; absent means deny. */
  requestManagedPermission?: PermissionHandler;
  systemPrompt?: string;
  tools?: SessionConfig['tools'];
  mcpServers?: SessionConfig['mcpServers'];
  skillDirectories?: string[];
  onUserInputRequest?: SessionConfig['onUserInputRequest'];
  onEvent?: SessionConfig['onEvent'];
  /** Host-held GitHub identity for this session; never an ambient login. */
  gitHubTokenProvider?: GitHubTokenProvider;
}

async function untilCancelled<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  let cancel!: () => void;
  const cancelled = new Promise<undefined>((resolve) => {
    cancel = (): void => resolve(undefined);
  });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** The same complete authority selection must be supplied on create and resume. */
export function createCopilotSessionConfig(
  policy: CopilotSessionPolicy,
): SessionConfig {
  const skills = [...(policy.skillDirectories ?? [])];
  const mcpServers = policy.mcpServers ?? {};
  return {
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    workingDirectory: policy.workingDirectory,
    configDirectory: policy.configDirectory,
    streaming: true,
    enableConfigDiscovery: false,
    skipCustomInstructions: true,
    enableOnDemandInstructionDiscovery: false,
    enableFileHooks: false,
    enableHostGitOperations: false,
    enableSessionStore: false,
    enableSessionTelemetry: false,
    enableExperimentalMode: false,
    askUserVariant: 'legacy',
    enableSkills: skills.length > 0,
    includedBuiltinSkills: [],
    skillDirectories: skills,
    pluginDirectories: [],
    customAgents: [],
    customAgentsLocalOnly: true,
    requestExtensions: false,
    requestCanvasRenderer: false,
    coauthorEnabled: false,
    remoteSession: 'off',
    memory: { enabled: false },
    gitHubTokenProvider: policy.gitHubTokenProvider,
    skipEmbeddingRetrieval: true,
    embeddingCacheStorage: 'in-memory',
    mcpOAuthTokenStorage: 'in-memory',
    availableTools: [
      ...COPILOT_NATIVE_TOOLS.map((name) => `builtin:${name}`),
      ...(policy.tools ?? []).map((tool) => `custom:${tool.name}`),
      // Only the complete host-supplied server set can contribute MCP tools.
      ...(Object.keys(mcpServers).length > 0 ? ['mcp:*'] : []),
    ],
    tools: policy.tools ?? [],
    mcpServers,
    disabledMcpServers: [...COPILOT_BUILTIN_MCP_SERVERS],
    systemMessage: policy.systemPrompt
      ? { mode: 'append', content: policy.systemPrompt }
      : undefined,
    onEvent: policy.onEvent,
    onUserInputRequest: policy.onUserInputRequest,
    onAutoModeSwitchRequest: (): Promise<'no'> => Promise.resolve('no'),
    onPermissionRequest: async (
      request,
      invocation,
    ): Promise<Awaited<ReturnType<PermissionHandler>>> => {
      if (
        policy.signal.aborted ||
        !request.managedApprovalRequired ||
        !policy.requestManagedPermission
      )
        return { kind: 'reject' };
      try {
        const handler = policy.requestManagedPermission;
        const result = await untilCancelled(policy.signal, async () =>
          handler(request, invocation),
        );
        return policy.signal.aborted || !result ? { kind: 'reject' } : result;
      } catch {
        return { kind: 'reject' };
      }
    },
    hooks: {
      onPreToolUse: async (
        input,
      ): Promise<
        Awaited<
          ReturnType<
            NonNullable<NonNullable<SessionConfig['hooks']>['onPreToolUse']>
          >
        >
      > => {
        const denied = {
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            'Tool approval is unavailable or was cancelled.',
        };
        if (policy.signal.aborted) return denied;
        try {
          const decision = await untilCancelled(policy.signal, () =>
            policy.authorize(input),
          );
          if (policy.signal.aborted || !decision) return denied;
          return {
            permissionDecision: decision.decision,
            permissionDecisionReason: decision.message,
            ...(decision.decision === 'allow' &&
            decision.modifiedArgs !== undefined
              ? { modifiedArgs: decision.modifiedArgs }
              : {}),
          };
        } catch {
          // The SDK catches thrown hooks and treats them as no decision.
          return denied;
        }
      },
    },
  };
}
