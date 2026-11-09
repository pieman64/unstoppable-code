import { openCodeCapabilityDigest } from './capability-snapshot';
import {
  resolveOpenCodeProviderConfig,
  serializeOpenCodeRuntimeConfig,
} from './provider-settings';
import { readOpenCodeRuntimeJson } from './runtime-api';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { connectAcp, type AcpClient } from '../acp';
import {
  createCursorHookTransport,
  type CursorHookOutcome,
} from '../cursor/hook-transport';
import type {
  ProviderProcess,
  ProviderProcessRequest,
  ProviderProcessSpawner,
} from '../provider-process/spawn';
import {
  openCodeApprovalPlugin,
  type OpenCodeForkScope,
} from './approval-plugin';
import {
  assertOpenCodeAuthConfigSafe,
  assertOpenCodeSystemConfigSafe,
  openCodeNativeDatabase,
} from './auth-config';
import {
  prepareOpenCodeInferenceRoute,
  type OpenCodeInferenceRoute,
} from './inference-route';

export interface OpenCodeToolInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

export interface OpenCodeRuntimeOptions {
  executable: string;
  /** Starts the ACP process. Desktop passes the provider process host (CAN-4118); nothing here spawns directly (CAN-4120). */
  spawnProcess: ProviderProcessSpawner;
  /** Attribution recorded by the provider process host. */
  processOwner: ProviderProcessRequest['owner'];
  runtimeIdentity?: {
    version: string;
    executableSha256?: string;
    platform?: string;
  };
  /** Host-selected launcher prefix, used by deterministic subprocess fixtures. */
  prefix?: readonly string[];
  cwd: string;
  profileDir: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  providerConfig?: Record<string, unknown>;
  inferenceRoute?: OpenCodeInferenceRoute;
  promptTimeoutMs?: number | null;
  forkScope?: OpenCodeForkScope;
  skillDirectories?: readonly string[];
  authorize(input: OpenCodeToolInput): Promise<CursorHookOutcome>;
  onUpdate(update: SessionNotification): void | Promise<void>;
}

export interface OwnedOpenCodeRuntime {
  providerSettingsDigest: string;
  client: AcpClient;
  assertApprovalReady(): void;
  activateSession(sessionId: string): void;
  readMetadata(pathname: string): Promise<unknown>;
  manageFork(sessionId: string, operation: 'move' | 'remove'): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolInput(value: unknown): value is OpenCodeToolInput {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    !!value.sessionId &&
    typeof value.toolCallId === 'string' &&
    !!value.toolCallId &&
    typeof value.toolName === 'string' &&
    !!value.toolName &&
    isRecord(value.toolArgs)
  );
}

/** One owned ACP process; native tools must pass the authenticated pre-tool hook. */
export async function startOpenCodeRuntime(
  options: OpenCodeRuntimeOptions,
): Promise<OwnedOpenCodeRuntime> {
  options.signal.throwIfAborted();
  const inference = options.inferenceRoute
    ? prepareOpenCodeInferenceRoute(options.inferenceRoute)
    : undefined;
  const runtimeEnv = inference
    ? { ...options.env, OPENCODE_AUTH_CONTENT: '{}' }
    : options.env;
  await assertOpenCodeAuthConfigSafe(runtimeEnv, options.cwd);
  await assertOpenCodeSystemConfigSafe(runtimeEnv);
  options.signal.throwIfAborted();
  const providerConfig = inference
    ? inference.config
    : await resolveOpenCodeProviderConfig(
        options.providerConfig,
        runtimeEnv,
        options.cwd,
        options.signal,
      );
  const providerSettingsDigest =
    inference?.settingsDigest ?? openCodeCapabilityDigest(providerConfig);
  options.signal.throwIfAborted();
  await mkdir(options.profileDir, { recursive: true, mode: 0o700 });
  const privateDir = await mkdtemp(join(options.profileDir, 'turn-'));
  const decisions = new Map<string, 'allow' | 'deny'>();
  let ready = false;
  let activeSession: string | undefined;
  let serverUrl: string | undefined;
  let client: AcpClient | undefined;
  let closing: Promise<void> | undefined;
  let stopProcess: () => Promise<void> = () => Promise.resolve();
  const hook = await createCursorHookTransport(
    async (payload) => {
      if (options.signal.aborted) return { decision: 'deny' };
      if (isRecord(payload) && payload.kind === 'ready') {
        if (typeof payload.serverUrl === 'string')
          serverUrl = payload.serverUrl;
        ready = true;
        return { decision: 'allow' };
      }
      if (
        !ready ||
        !isToolInput(payload) ||
        payload.sessionId !== activeSession
      )
        return { decision: 'deny' };
      if (
        decisions.size >= 4096 ||
        decisions.has(JSON.stringify([payload.sessionId, payload.toolCallId]))
      )
        return { decision: 'deny' };
      // Reserve before yielding: duplicate deliveries may arrive while approval is pending.
      const identity = JSON.stringify([payload.sessionId, payload.toolCallId]);
      decisions.set(identity, 'deny');
      const outcome = await options.authorize(payload);
      const decision =
        options.signal.aborted || outcome.stopTurn ? 'deny' : outcome.decision;
      decisions.set(identity, decision);
      return { ...outcome, decision };
    },
    () => {
      client?.close();
    },
    { rejectOversizedRewrites: true },
  ).catch(async (error: unknown) => {
    await rm(privateDir, { recursive: true, force: true });
    throw error;
  });
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      options.signal.removeEventListener('abort', abort);
      hook.revoke();
      client?.close();
      try {
        await stopProcess();
      } finally {
        await hook.close();
        await rm(privateDir, { recursive: true, force: true });
      }
    })();
    return closing;
  };
  const abort = (): void => {
    void close().catch(() => undefined);
  };
  try {
    const plugin = join(privateDir, 'host-approval');
    await mkdir(plugin, { mode: 0o700 });
    await writeFile(join(plugin, 'package.json'), '{"type":"module"}', {
      mode: 0o600,
    });
    await writeFile(
      join(plugin, 'index.js'),
      openCodeApprovalPlugin(
        hook.url,
        hook.token,
        options.env,
        options.forkScope,
      ),
      { mode: 0o600 },
    );
    options.signal.throwIfAborted();
    // Keep v2 provider credentials and sessions in the canonical native database.
    // A per-turn database would lose credentials saved by native auth login.
    const env: NodeJS.ProcessEnv = {
      ...runtimeEnv,
      OPENCODE_CONFIG: '',
      OPENCODE_CONFIG_DIR: privateDir,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: privateDir,
      OPENCODE_DB: openCodeNativeDatabase(options.env, options.cwd),
      OPENCODE_TEST_HOME: privateDir,
      // The approval plugin restores the caller's roots only for shell tools;
      // provider configuration and plugins remain isolated for the whole turn.
      XDG_CONFIG_HOME: privateDir,
      XDG_STATE_HOME: join(options.profileDir, 'state'),
      XDG_CACHE_HOME: join(options.profileDir, 'cache'),
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
      OPENCODE_FILEWATCHER_DISABLE: 'true',
      OPENCODE_CONFIG_CONTENT: serializeOpenCodeRuntimeConfig({
        ...providerConfig,
        $schema: 'https://opencode.ai/config.json',
        update: 'disable',
        share: 'disabled',
        lsp: false,
        formatter: false,
        skills: { paths: [...(options.skillDirectories ?? [])] },
        plugins: [pathToFileURL(plugin).href],
        permissions: [
          { action: '*', resource: '*', effect: 'ask' },
          ...['execute', 'subagent', 'question', 'plan_enter', 'plan_exit'].map(
            (action) => ({
              action,
              resource: '*',
              effect: 'deny',
            }),
          ),
        ],
      }),
    };
    const child: ProviderProcess = options.spawnProcess({
      command: options.executable,
      args: [...(options.prefix ?? []), 'acp'],
      cwd: options.cwd,
      env,
      owner: options.processOwner,
    });
    child.stderr.resume();
    let stopping: Promise<void> | undefined;
    // The seam's stop is today's group drain: SIGTERM, close or 1.5 s, SIGKILL, close.
    stopProcess = (): Promise<void> => (stopping ??= child.stop());
    child.once('error', () => {
      client?.close();
    });
    options.signal.addEventListener('abort', abort, { once: true });
    options.signal.throwIfAborted();
    const { stdin } = child;
    if (!stdin) throw new Error('The OpenCode ACP child has no stdin.');
    client = await connectAcp({
      transport: {
        input: Readable.toWeb(child.stdout),
        output: Writable.toWeb(stdin),
        close: () => {
          void stopProcess().catch(() => undefined);
        },
      },
      clientInfo: { name: 'canopy', version: '1' },
      resourceGeneration: 1,
      onUpdate: async (notification) => {
        const update = notification.update;
        if (
          activeSession === notification.sessionId &&
          (update.sessionUpdate === 'tool_call' ||
            update.sessionUpdate === 'tool_call_update') &&
          update.status === 'completed' &&
          decisions.get(
            JSON.stringify([notification.sessionId, update.toolCallId]),
          ) !== 'allow'
        ) {
          client?.close();
          throw new Error('OpenCode completed a tool without host approval.');
        }
        await options.onUpdate(notification);
      },
      onPermission: ({ request, signal }) =>
        Promise.resolve(
          !signal.aborted &&
            decisions.get(
              JSON.stringify([request.sessionId, request.toolCall.toolCallId]),
            ) === 'allow'
            ? 'allow'
            : 'deny',
        ),
      timeouts: {
        initializeMs: 30_000,
        requestMs: 60_000,
        promptMs: options.promptTimeoutMs ?? null,
        permissionMs: 65_000,
      },
    });
    // V2 initializes location plugins lazily on session/new or session/load.
    // Forks must read the source's grants BEFORE attaching it. Initialize the
    // location using an empty owned session, then delete exactly that session.
    if (options.forkScope && !ready) {
      const bootstrap = await client.newSession({
        cwd: options.cwd,
        mcpServers: [],
      });
      if (
        bootstrap.sessionId === options.forkScope.sourceSessionId ||
        bootstrap.sessionId === options.forkScope.forkSessionId
      )
        throw new Error(
          'OpenCode reused an existing session during fork initialization.',
        );
      try {
        if (!ready || !serverUrl)
          throw new Error('OpenCode did not initialize fork metadata.');
      } finally {
        await client.deleteSession(bootstrap.sessionId);
      }
    }
    options.signal.throwIfAborted();
    return {
      providerSettingsDigest,
      client,
      activateSession: (sessionId): void => {
        activeSession = sessionId;
        decisions.clear();
      },
      readMetadata: (pathname) =>
        serverUrl
          ? readOpenCodeRuntimeJson(
              serverUrl,
              pathname,
              hook.token,
              options.signal,
            )
          : Promise.resolve(undefined),
      manageFork: async (sessionId, operation): Promise<void> => {
        if (!options.forkScope || !serverUrl)
          throw new Error('OpenCode fork scope is unavailable.');
        await readOpenCodeRuntimeJson(
          serverUrl,
          '/fork',
          hook.token,
          options.signal,
          { sessionId, operation },
        );
      },
      assertApprovalReady: (): void => {
        if (!ready)
          throw new Error(
            'OpenCode did not load the host approval policy. Reconnect in Settings.',
          );
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
