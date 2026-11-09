import {
  query as claudeQuery,
  type SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SlashCommandData,
  McpServerStatusData,
  WorktreeDiscovery,
} from '@canopy/desktop-shared/types';
import { claudeNativeMemoryOptions } from '@canopy/execution-engine/node/lib/native-memory';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import type { ClaudeCompatibleInvocation } from './claude-session';
import { spawnClaudeCodeProcessOffMain } from './claude-process-host-runner';
import {
  getBundledClaudeBinaryPath,
  getBundledRgBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';
import { discoverProjectSlashCommands } from './project-slash-command-discovery';
import {
  resolveClaudeModAdmissionLaunch,
  type ClaudeModLaunchPluginRequest,
} from './claude-mod-admission-launch';
import { mergeClaudeModAdmissionSettings } from '@canopy/desktop-shared/node/plugins/claude-mod-admission';

export interface DiscoveryResult {
  slashCommands: SlashCommandData[];
  mcpServers: McpServerStatusData[];
  skippedMods?: WorktreeDiscovery['skippedMods'];
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
const DISCOVERY_STDERR_TAIL_LINES = 20;

export async function discoverWorktreeEnvironment(
  cwd: string,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  plugins?: ClaudeModLaunchPluginRequest[],
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
  const settingSources: SettingSource[] = safeProjectDiscovery
    ? ['user']
    : ['user', 'project', 'local'];
  // Local memory is opt-in; only an enabled preference suppresses
  // harness-native auto-memory on discovery sessions (CAN-1969).
  const localMemoryEnabled = await readLocalMemoryEnabledPreference();
  // Inspect the config dir the child gets: the same environment request as
  // its env below (no user variables in safe mode), then its override.
  const childConfigDir = invocation?.envOverride?.CLAUDE_CONFIG_DIR;
  const claudeModAdmission = await resolveClaudeModAdmissionLaunch({
    cwd,
    settingSources,
    plugins,
    environment: safeProjectDiscovery
      ? false
      : workspaceId
        ? { runtime: 'agent', workspaceId }
        : { runtime: 'agent' },
    ...(childConfigDir !== undefined
      ? { claudeConfigDir: childConfigDir }
      : {}),
  });
  // The SDK takes plain entries; a plugin id is only for admission.
  const queryPlugins = claudeModAdmission
    ? [...claudeModAdmission.plugins]
    : plugins?.map((plugin) => ({ type: plugin.type, path: plugin.path }));
  const nativeMemoryOptions = claudeNativeMemoryOptions(localMemoryEnabled);
  const admissionSettings = claudeModAdmission?.settings
    ? mergeClaudeModAdmissionSettings(
        nativeMemoryOptions.settings ?? {},
        claudeModAdmission.settings,
      )
    : undefined;

  // The CLI's last stderr lines, kept only to explain a timeout.
  const stderrTail: string[] = [];

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
      settingSources,
      ...(discoveryOptions?.strictEmptyMcpConfig
        ? { strictMcpConfig: true, mcpServers: {} }
        : {}),
      ...(invocation?.sdkModel ? { model: invocation.sdkModel } : {}),
      sandbox: {
        ripgrep: {
          command: getBundledRgBinaryPath(),
        },
      },
      ...(queryPlugins && queryPlugins.length > 0
        ? { plugins: queryPlugins }
        : {}),
      // Native-memory suppression while local memory is enabled (CAN-1969) —
      // discovery sessions must not read or write harness auto-memory either.
      ...nativeMemoryOptions,
      ...(admissionSettings ? { settings: admissionSettings } : {}),
      stderr: (data: string): void => {
        stderrTail.push(data);
        if (stderrTail.length > DISCOVERY_STDERR_TAIL_LINES) stderrTail.shift();
      },
    },
  });

  let timerId: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set(['commands', 'MCP servers']);
  const settle = <T>(label: string, promise: Promise<T>): Promise<T> =>
    promise.finally(() => pending.delete(label));
  try {
    const timeout = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => {
        // Say what was still pending and what the CLI last printed, so a
        // timeout in a running app can be explained from its log.
        const output = stderrTail.join('').trim().slice(-1000);
        const error = new Error(
          `Discovery timed out after ${timeoutMs} ms waiting for ${
            Array.from(pending).join(' and ') || 'project commands'
          } (${queryPlugins?.length ?? 0} plugins)${
            output ? `. Last CLI output: ${output}` : ''
          }`,
        );
        abortController.abort(error);
        reject(error);
      }, timeoutMs);
    });

    const [slashCommands, mcpServers, projectSlashCommands] =
      await Promise.race([
        Promise.all([
          settle('commands', queryResult.supportedCommands()),
          settle('MCP servers', queryResult.mcpServerStatus()),
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

    // Only plugins this chat turned on: ambient ones are the person's own
    // Claude settings, which the launch notice covers.
    const skippedMods = (claudeModAdmission?.skippedMods ?? []).flatMap(
      (mod) =>
        mod.source === 'selected'
          ? [{ pluginId: mod.pluginId, reason: mod.reason }]
          : [],
    );
    return {
      ...(skippedMods.length > 0 ? { skippedMods } : {}),
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
