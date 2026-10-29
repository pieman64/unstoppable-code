import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  SlashCommandData,
  McpServerStatusData,
} from '@canopy/desktop-shared/types';
import { claudeNativeMemoryOptions } from '@canopy/desktop-shared/node/lib/native-memory';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import type { ClaudeCompatibleInvocation } from './claude-session';
import { spawnClaudeCodeProcessOffMain } from './claude-process-host-runner';
import {
  getBundledClaudeBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';
import { discoverProjectSlashCommands } from './project-slash-command-discovery';

export interface DiscoveryResult {
  slashCommands: SlashCommandData[];
  mcpServers: McpServerStatusData[];
}

export interface DiscoveryOptions {
  strictEmptyMcpConfig?: boolean;
  /**
   * Restrict automatic metadata discovery to user settings and a
   * Canopy-managed, secret-free environment. Repository skill and command
   * metadata is parsed directly, without loading repository settings.
   */
  safeProjectDiscovery?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;
export async function discoverWorktreeEnvironment(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  plugins?: { type: 'local'; path: string }[],
  invocation?: ClaudeCompatibleInvocation,
  workspaceId?: string,
  discoveryOptions?: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const abortController = new AbortController();
  if (signal?.aborted) {
    abortController.abort(signal.reason);
  } else {
    signal?.addEventListener(
      'abort',
      () => abortController.abort(signal.reason),
      { once: true },
    );
  }

  const emptyPromptInput = (async function* (): AsyncGenerator<never> {})();
  const safeProjectDiscovery = discoveryOptions?.safeProjectDiscovery === true;
  // Local memory is opt-in; only an enabled preference suppresses
  // harness-native auto-memory on discovery sessions (CAN-1969).
  const localMemoryEnabled = await readLocalMemoryEnabledPreference();

  // SAFETY: This is a read-only metadata query — no prompt is sent.
  // The session is immediately interrupted after retrieving commands/servers.
  // Do NOT add a prompt or user-facing actions without removing bypassPermissions.
  const queryResult = claudeQuery({
    prompt: emptyPromptInput,
    options: {
      cwd,
      abortController,
      pathToClaudeCodeExecutable: getBundledClaudeBinaryPath(),
      spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      env: {
        ...getEnhancedEnv(
          safeProjectDiscovery
            ? { includeCanopySecrets: false, environment: false }
            : {
                environment: workspaceId
                  ? { runtime: 'agent', workspaceId }
                  : { runtime: 'agent' },
              },
        ),
        ...(invocation?.envOverride ?? {}),
      },
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      settingSources: safeProjectDiscovery
        ? ['user']
        : ['user', 'project', 'local'],
      ...(discoveryOptions?.strictEmptyMcpConfig
        ? { strictMcpConfig: true, mcpServers: {} }
        : {}),
      ...(invocation?.sdkModel ? { model: invocation.sdkModel } : {}),
      sandbox: {
        ripgrep: {
          command: getBundledRgBinaryPath(),
        },
      },
      ...(plugins && plugins.length > 0 ? { plugins } : {}),
      // Native-memory suppression while local memory is enabled (CAN-1969) —
      // discovery sessions must not read or write harness auto-memory either.
      ...claudeNativeMemoryOptions(localMemoryEnabled),
    },
  });

  let timerId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        const error = new Error('Discovery timed out');
        abortController.abort(error);
        reject(error);
      }, timeoutMs);
    });

    const [slashCommands, mcpServers, projectSlashCommands] =
      await Promise.race([
        Promise.all([
          queryResult.supportedCommands(),
          queryResult.mcpServerStatus(),
          safeProjectDiscovery
            ? discoverProjectSlashCommands(cwd, abortController.signal)
            : Promise.resolve([]),
        ]),
        timeout,
      ]);

    const mergedSlashCommands = new Map<string, SlashCommandData>();
    for (const command of slashCommands) {
      mergedSlashCommands.set(command.name, {
        name: command.name,
        description: command.description,
        argumentHint: command.argumentHint ?? '',
      });
    }
    for (const command of projectSlashCommands) {
      if (!mergedSlashCommands.has(command.name)) {
        mergedSlashCommands.set(command.name, command);
      }
    }

    return {
      slashCommands: Array.from(mergedSlashCommands.values()),
      mcpServers: mcpServers.map((srv) => ({
        name: srv.name,
        status: srv.status,
        ...(srv.serverInfo && { serverInfo: srv.serverInfo }),
        ...(srv.error && { error: srv.error }),
        ...(srv.scope && { scope: srv.scope }),
        ...(srv.tools && {
          tools: srv.tools.map((t) => ({
            name: t.name,
            ...(t.description && { description: t.description }),
          })),
        }),
      })),
    };
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
    void queryResult.interrupt().catch(() => {});
    abortController.abort();
  }
}
