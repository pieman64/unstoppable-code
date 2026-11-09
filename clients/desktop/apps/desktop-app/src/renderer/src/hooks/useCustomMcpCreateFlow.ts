import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  McpServerFileView,
  McpServerStatusEntry,
  SaveMcpServerRequest,
} from '@canopy/execution-engine/types/mcp-servers';
import { extractIpcErrorMessage } from '@/lib/errors';

const SIGN_IN_POLL_INTERVAL_MS = 1_500;
const SIGN_IN_POLL_TIMEOUT_MS = 120_000;
const SAVE_FAILED = "Couldn't save the server.";
const CONNECT_FAILED = "Couldn't connect to the server.";
const SIGN_IN_FAILED = "Couldn't finish signing in.";
const SIGN_IN_TIMED_OUT = 'Sign-in timed out before it finished.';
const SIGN_IN_CANCELLED = 'Sign-in cancelled.';

/** `idle → saving → testing → (signing-in → testing) → verified | failed`. */
export type CustomMcpCreatePhase =
  | 'idle'
  | 'saving'
  | 'testing'
  | 'signing-in'
  | 'failed'
  | 'verified';

/** The saved server this flow verifies, kept across retries. */
export interface CustomMcpCreateTarget {
  readonly serverId: string;
  readonly configId: string | undefined;
  readonly saved: McpServerFileView;
}

export interface CustomMcpCreateFlow {
  readonly phase: CustomMcpCreatePhase;
  readonly busy: boolean;
  readonly savedServerId: string | null;
  /** Reads the saved id without waiting for a render. */
  readonly savedServerIdRef: { readonly current: string | null };
  readonly error: string;
  readonly authorizationUrl: string | null;
  /** Saves once, or updates the saved server when its fields changed, then verifies. */
  readonly run: (
    build: (savedServerId: string | undefined) => SaveMcpServerRequest,
  ) => Promise<void>;
  /** Stops a sign-in or check in progress; the saved server stays. */
  readonly cancel: () => void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== ''
    ? extractIpcErrorMessage(error)
    : fallback;
}

/** What a request asks for, without the id and timestamps a retry changes. */
function requestSnapshot(request: SaveMcpServerRequest): string {
  return JSON.stringify(
    { ...request, definition: { ...request.definition, id: '' } },
    (key: string, value: unknown) =>
      key === 'updatedAt' || key === 'createdAt' ? undefined : value,
  );
}

function statusOf(
  entries: readonly McpServerStatusEntry[],
  target: CustomMcpCreateTarget,
): {
  entry: McpServerStatusEntry | undefined;
  config: McpServerStatusEntry['configs'][number] | undefined;
} {
  const entry = entries.find((item) => item.serverId === target.serverId);
  const config = target.configId
    ? entry?.configs.find((item) => item.configId === target.configId)
    : entry?.configs[0];
  return { entry, config };
}

/**
 * Adding a custom HTTP server on this device: save once, test that saved
 * target, sign in when the server asks, and test again before reporting
 * success. A failure after the save keeps the server, so a retry updates it
 * rather than creating another.
 *
 * Tests cannot be aborted, so stopping invalidates the attempt and its late
 * result is ignored. `onVerified` fires at most once per mounted flow.
 */
export function useCustomMcpCreateFlow(
  onVerified: (target: CustomMcpCreateTarget) => void | Promise<void>,
  onRetained?: () => void | Promise<void>,
): CustomMcpCreateFlow {
  const [phase, setPhase] = useState<CustomMcpCreatePhase>('idle');
  const [error, setError] = useState('');
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [savedServerId, setSavedServerId] = useState<string | null>(null);
  const savedServerIdRef = useRef<string | null>(null);
  const target = useRef<CustomMcpCreateTarget | null>(null);
  const savedSnapshot = useRef<string | null>(null);
  const attempt = useRef(0);
  const running = useRef(false);
  const flowId = useRef<string | undefined>(undefined);
  const wake = useRef<(() => void) | null>(null);
  const verified = useRef(false);
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;
  const onRetainedRef = useRef(onRetained);
  onRetainedRef.current = onRetained;

  const stop = useCallback((): void => {
    attempt.current += 1;
    running.current = false;
    wake.current?.();
    wake.current = null;
    const flow = flowId.current;
    flowId.current = undefined;
    if (flow)
      void window.mcpServers.cancelOAuthLogin(flow).catch(() => undefined);
  }, []);

  useEffect(() => stop, [stop]);

  const cancel = useCallback((): void => {
    const signingIn = flowId.current !== undefined;
    if (!running.current) return;
    stop();
    setAuthorizationUrl(null);
    setPhase(target.current ? 'failed' : 'idle');
    setError(signingIn ? SIGN_IN_CANCELLED : '');
  }, [stop]);

  const run = useCallback<CustomMcpCreateFlow['run']>(async (build) => {
    if (running.current || verified.current) return;
    running.current = true;
    const current = ++attempt.current;
    const live = (): boolean => attempt.current === current;
    const fail = (message: string): void => {
      if (!live()) return;
      running.current = false;
      const flow = flowId.current;
      flowId.current = undefined;
      if (flow)
        void window.mcpServers.cancelOAuthLogin(flow).catch(() => undefined);
      setAuthorizationUrl(null);
      setError(message);
      setPhase(target.current ? 'failed' : 'idle');
    };
    setError('');
    setAuthorizationUrl(null);

    let request: SaveMcpServerRequest;
    try {
      request = build(target.current?.serverId);
    } catch (cause) {
      fail(errorMessage(cause, SAVE_FAILED));
      return;
    }
    const snapshot = requestSnapshot(request);
    if (target.current === null || snapshot !== savedSnapshot.current) {
      setPhase('saving');
      try {
        const saved = await window.mcpServers.saveServer(request);
        // A close during the save still leaves this server behind.
        target.current = {
          serverId: saved.server.definition.id,
          configId:
            saved.server.configs.find((config) => config.enabled)?.id ??
            saved.server.configs[0]?.id,
          saved,
        };
        savedSnapshot.current = snapshot;
        savedServerIdRef.current = saved.server.definition.id;
        if (live()) setSavedServerId(saved.server.definition.id);
        else await onRetainedRef.current?.();
      } catch (cause) {
        fail(errorMessage(cause, SAVE_FAILED));
        return;
      }
    }
    if (!live()) return;
    const saved = target.current;
    let needsSignIn = false;
    let forceSignIn = false;
    let lastFailure = CONNECT_FAILED;

    const test = async (): Promise<boolean> => {
      setPhase('testing');
      const result = await window.mcpServers.testConnection(
        saved.serverId,
        saved.configId,
      );
      if (result.success) return true;
      if (!live()) return false;
      const { entry, config } = statusOf(
        await window.mcpServers.listStatus(),
        saved,
      );
      needsSignIn =
        entry?.connectionStatus === 'auth_required' ||
        config?.authStatus === 'not_connected' ||
        config?.authStatus === 'expired' ||
        config?.authStatus === 'error';
      // Discard a rejected credential or an earlier callback error before
      // polling this attempt, rather than reusing either as its outcome.
      forceSignIn =
        entry?.connectionStatus === 'auth_required' ||
        config?.authStatus === 'expired' ||
        config?.authStatus === 'error';
      lastFailure = result.error ?? result.message ?? CONNECT_FAILED;
      return false;
    };

    const waitForSignIn = async (): Promise<string | null> => {
      const startedAt = Date.now();
      while (live() && Date.now() - startedAt < SIGN_IN_POLL_TIMEOUT_MS) {
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(resolve, SIGN_IN_POLL_INTERVAL_MS);
          wake.current = (): void => {
            window.clearTimeout(timer);
            resolve();
          };
        });
        if (!live()) return null;
        const { config } = statusOf(
          await window.mcpServers.listStatus(),
          saved,
        );
        if (config?.authStatus === 'connected') return null;
        if (config?.authStatus === 'error')
          return config.lastError ?? SIGN_IN_FAILED;
      }
      return SIGN_IN_TIMED_OUT;
    };

    try {
      let connected = await test();
      if (!live()) return;
      if (!connected && needsSignIn) {
        setPhase('signing-in');
        const response = await window.mcpServers.startOAuthLogin({
          serverId: saved.serverId,
          ...(saved.configId ? { configId: saved.configId } : {}),
          force: forceSignIn,
        });
        if (!live()) {
          if (response.flowId)
            await window.mcpServers.cancelOAuthLogin(response.flowId);
          return;
        }
        flowId.current = response.flowId;
        if (response.status === 'started') {
          setAuthorizationUrl(response.authorizationUrl ?? null);
          const signInFailure = await waitForSignIn();
          if (!live()) return;
          if (signInFailure !== null) {
            fail(signInFailure);
            return;
          }
        }
        flowId.current = undefined;
        setAuthorizationUrl(null);
        // Neither a sign-in nor a no-auth answer proves the server works.
        connected = await test();
        if (!live()) return;
      }
      if (!connected) {
        fail(lastFailure);
        return;
      }
    } catch (cause) {
      fail(errorMessage(cause, CONNECT_FAILED));
      return;
    }
    verified.current = true;
    running.current = false;
    setPhase('verified');
    await onVerifiedRef.current(saved);
  }, []);

  return {
    phase,
    busy: phase === 'saving' || phase === 'testing' || phase === 'signing-in',
    savedServerId,
    savedServerIdRef,
    error,
    authorizationUrl,
    run,
    cancel,
  };
}
