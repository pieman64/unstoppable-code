import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useCanopyClient } from '@canopy/app-state';
import {
  CURATED_MCP_TRY_IT_SOURCE_ID,
  ACCOUNT_MCP_TRY_IT_SOURCE_ID,
  type TryItCapability,
} from '@canopy/protocol/try-it';
import type { AccountMcpConnectionSummary } from '@canopy/desktop-shared/types/mcp-servers';
import type { TryItSetupAction } from '@canopy/ui-shared/components';
import {
  useAccountMcpSignIn,
  type AccountMcpSignInTarget,
} from '@/components/mcp/useAccountMcpSignIn';
import type { DesktopTryItTarget } from '@/hooks/useTryItSignInContinuation';
import { isInAppBrowserAvailable } from '@/lib/remote-control/in-app-browser-availability';
import { useTryItSetupPaneStore } from '@/stores/tryItSetupPaneStore';

/** Transient setup progress; never persisted (CAN-4451). */
export type TryItSetupPhase = 'idle' | 'active' | 'cancelled' | 'failed';

export interface UseTryItSetupInput {
  target: DesktopTryItTarget;
  capability: TryItCapability | null;
  /** The signed-in `setup-required` record this chat may set up, or null. */
  requestId: string | null;
  accountKey: string | null;
  phase: TryItSetupPhase;
  setPhase: (phase: TryItSetupPhase) => void;
  /** Requeues the current record once; the runner re-resolves before sending. */
  resume: (requestId: string) => boolean;
}

export interface TryItSetup {
  /** Absent while nothing can be set up; disabled while the target loads. */
  setup?: TryItSetupAction;
  loading: boolean;
  errorMessage?: string;
  dialogs: JSX.Element;
}

type ResolvedTarget =
  | {
      kind: 'ready';
      target: AccountMcpSignInTarget;
      requiresSignIn: boolean;
      connected: boolean;
    }
  | { kind: 'unavailable'; message: string };

type Connections =
  | { status: 'loading'; key: string }
  | {
      status: 'ready';
      key: string;
      list: readonly AccountMcpConnectionSummary[];
    }
  | { status: 'error'; key: string };

/**
 * Correlates the launched MCP identity with the account's connections by
 * source kind and server key, never by position: a custom server key is not
 * interchangeable with a curated one.
 */
export function resolveTryItSetupTarget(
  capability: TryItCapability,
  connections: readonly AccountMcpConnectionSummary[],
): ResolvedTarget {
  if (
    capability.kind !== 'mcp' ||
    (capability.sourceId !== CURATED_MCP_TRY_IT_SOURCE_ID &&
      capability.sourceId !== ACCOUNT_MCP_TRY_IT_SOURCE_ID)
  )
    return {
      kind: 'unavailable',
      message: `${capability.name} needs setup from its details page.`,
    };
  const curated = capability.sourceId === CURATED_MCP_TRY_IT_SOURCE_ID;
  const matching = connections.filter(
    (connection) =>
      connection.kind === (curated ? 'CURATED' : 'CUSTOM') &&
      connection.serverKey === capability.catalogId,
  );
  if (matching.length > 1)
    return {
      kind: 'unavailable',
      message: `${capability.name} has more than one connection. Remove the extra one in Settings, then retry.`,
    };
  const connection = matching[0];
  if (connection) {
    if (connection.status === 'CONNECTED' && connection.enabled === false)
      return {
        kind: 'unavailable',
        message: `${capability.name} is turned off. Turn it on in Settings, then retry.`,
      };
    return {
      kind: 'ready',
      target: { connection, configId: connection.configId },
      requiresSignIn: connection.authMode !== 'NONE',
      connected: connection.status === 'CONNECTED',
    };
  }
  if (!curated)
    return {
      kind: 'unavailable',
      message: `${capability.name} isn't connected to your account. Add it in Settings, then retry.`,
    };
  return {
    kind: 'ready',
    target: { curatedKey: capability.catalogId },
    requiresSignIn: true,
    connected: false,
  };
}

/**
 * The signed-in setup step of a Try it chat on desktop (CAN-4451): resolves
 * the account MCP target, starts its sign-in in the in-app pane or the default
 * browser, and requeues the saved prompt once the connection is verified.
 *
 * Each attempt has its own identity. Cancel, unmount, and a changed chat,
 * record or account invalidate it before any cleanup, so a stale callback can
 * never resume, fail, or close a newer attempt's pane.
 */
export function useTryItSetup(input: UseTryItSetupInput): TryItSetup {
  const { target, capability, requestId, accountKey, phase, setPhase, resume } =
    input;
  const { projectId, worktreeId, chatId } = target;
  const client = useCanopyClient();
  const identity =
    requestId !== null && accountKey !== null && capability
      ? `${accountKey}\u0000${projectId}\u0000${worktreeId}\u0000${chatId}\u0000${requestId}\u0000${capability.sourceId}\u0000${capability.catalogId}`
      : null;

  const [connections, setConnections] = useState<Connections | null>(null);
  const connectionsRead = useRef(0);
  const loadConnections = useCallback(async (): Promise<void> => {
    if (identity === null) return;
    const read = ++connectionsRead.current;
    try {
      const list = await window.mcpServers.listAccountConnections();
      if (read === connectionsRead.current)
        setConnections({ status: 'ready', key: identity, list });
    } catch {
      if (read === connectionsRead.current)
        setConnections({ status: 'error', key: identity });
    }
  }, [identity]);
  useEffect(() => {
    if (identity === null) return;
    setConnections({ status: 'loading', key: identity });
    void loadConnections();
    return (): void => {
      connectionsRead.current += 1;
    };
  }, [identity, loadConnections]);

  const signIn = useAccountMcpSignIn(loadConnections, {
    enabled: identity !== null,
  });
  const current = connections?.key === identity ? connections : null;
  const resolved = useMemo((): ResolvedTarget | null => {
    if (!capability || current?.status !== 'ready') return null;
    return resolveTryItSetupTarget(capability, current.list);
  }, [capability, current]);
  const loading =
    identity !== null &&
    (current === null ||
      current.status === 'loading' ||
      (resolved?.kind === 'ready' &&
        !signIn.catalogFailed &&
        signIn.waitsForCatalog(resolved.target)));
  const resolutionError =
    identity === null || !capability
      ? undefined
      : current?.status === 'error' ||
          (resolved?.kind === 'ready' &&
            signIn.catalogFailed &&
            signIn.waitsForCatalog(resolved.target))
        ? `Couldn't load ${capability.name} setup. Retry to try again.`
        : resolved?.kind === 'unavailable'
          ? resolved.message
          : undefined;

  const [failure, setFailure] = useState<string | undefined>(undefined);
  const attemptRef = useRef<{ cancel: () => void } | null>(null);
  const latest = useRef({ signIn, setPhase, capability });
  latest.current = { signIn, setPhase, capability };

  // A changed chat, record or account (and unmount) ends this attempt: its
  // callbacks go stale first, then only its own pane and flow are released.
  useLayoutEffect(
    () => (): void => {
      const attempt = attemptRef.current;
      attemptRef.current = null;
      setFailure(undefined);
      latest.current.setPhase('idle');
      if (!attempt) return;
      useTryItSetupPaneStore.getState().close(attempt);
      attempt.cancel();
    },
    [identity],
  );

  const cancel = useCallback((): void => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    attemptRef.current = null;
    setPhase('cancelled');
    setFailure(undefined);
    useTryItSetupPaneStore.getState().close(attempt);
    attempt.cancel();
  }, [setPhase]);

  const fail = useCallback(
    (
      attempt: { cancel: () => void },
      message: string | undefined,
      cancelConnection = true,
    ): void => {
      if (attemptRef.current !== attempt) return;
      attemptRef.current = null;
      setPhase('failed');
      setFailure(message);
      useTryItSetupPaneStore.getState().close(attempt);
      if (cancelConnection) attempt.cancel();
    },
    [setPhase],
  );

  const embeddedAllowed =
    client.capabilities.embeddedOAuthBrowser === true &&
    isInAppBrowserAvailable();

  const start = useCallback(
    (route: 'embedded' | 'external'): void => {
      if (
        attemptRef.current ||
        !requestId ||
        !capability ||
        resolved?.kind !== 'ready' ||
        loading
      )
        return;
      // Enforced here as well as in presentation: no pane without both.
      const embedded = route === 'embedded' && embeddedAllowed;
      const cancellationKey =
        resolved.target.connection?.serverKey ?? resolved.target.curatedKey;
      const attempt = {
        cancel: (): void => {
          if (cancellationKey) signIn.cancel(cancellationKey);
        },
      };
      if (embedded && !useTryItSetupPaneStore.getState().reserve(attempt)) {
        setPhase('failed');
        setFailure(
          'Another connection is using the sign-in panel. Finish or close it, then retry.',
        );
        return;
      }
      attemptRef.current = attempt;
      setFailure(undefined);
      setPhase('active');
      const owned = (): boolean => attemptRef.current === attempt;
      signIn.connect(resolved.target, {
        ...(embedded ? { browser: 'embedded' as const } : {}),
        onAuthorizing: (embeddedUrl): void => {
          if (!owned() || !embedded) return;
          if (!embeddedUrl) {
            fail(
              attempt,
              "Couldn't open the sign-in panel. Open in default browser to continue.",
            );
            return;
          }
          const opened = useTryItSetupPaneStore.getState().open({
            projectId,
            worktreeId,
            chatId,
            attempt,
            url: embeddedUrl,
            capabilityName: capability.name,
            onClose: cancel,
            onError: (): void =>
              fail(
                attempt,
                "Couldn't open the sign-in panel. Open in default browser to continue.",
              ),
          });
          if (!opened)
            fail(
              attempt,
              'Another chat is authorizing a connection. Finish or cancel it, then retry.',
            );
        },
        onSettled: (outcome): void => {
          if (!owned()) return;
          if (outcome.kind === 'connected') {
            attemptRef.current = null;
            useTryItSetupPaneStore.getState().close(attempt);
            setPhase('idle');
            // A verified connection is a notification, not readiness: the
            // runner re-reads connections and re-resolves before sending.
            if (!resume(requestId)) void loadConnections();
            return;
          }
          if (outcome.kind === 'cancelled') {
            attemptRef.current = null;
            useTryItSetupPaneStore.getState().close(attempt);
            setPhase('cancelled');
            return;
          }
          // This flow has settled. Cancelling it can delete saved setup or
          // disconnect a Retry that starts before the old cleanup finishes.
          fail(attempt, outcome.message ?? undefined, false);
        },
      });
    },
    [
      requestId,
      capability,
      resolved,
      loading,
      embeddedAllowed,
      setPhase,
      signIn,
      fail,
      cancel,
      resume,
      loadConnections,
      projectId,
      worktreeId,
      chatId,
    ],
  );

  // An already usable connection (after a reload, or authorized elsewhere)
  // resumes once, unless the user cancelled during this session.
  const autoResumed = useRef<string | null>(null);
  const connectedTarget = resolved?.kind === 'ready' && resolved.connected;
  useEffect(() => {
    if (
      !connectedTarget ||
      identity === null ||
      !requestId ||
      phase !== 'idle' ||
      attemptRef.current ||
      autoResumed.current === identity
    )
      return;
    autoResumed.current = identity;
    resume(requestId);
  }, [connectedTarget, identity, requestId, phase, resume]);

  // A target that can't be resolved is a recoverable setup failure, never a
  // silently disabled action.
  useEffect(() => {
    if (resolutionError !== undefined && phase === 'idle') setPhase('failed');
  }, [resolutionError, phase, setPhase]);

  const retryResolution = useCallback((): void => {
    if (identity === null) return;
    setFailure(undefined);
    setConnections({ status: 'loading', key: identity });
    setPhase('idle');
    if (signIn.catalogFailed) signIn.retryCatalog();
    void loadConnections();
  }, [identity, setPhase, signIn, loadConnections]);

  if (identity === null) return { loading: false, dialogs: signIn.dialogs };
  if (resolutionError !== undefined && phase !== 'active')
    return {
      setup: {
        requiresSignIn: true,
        route: 'external',
        onActivate: retryResolution,
      },
      loading: false,
      errorMessage: resolutionError,
      dialogs: signIn.dialogs,
    };
  const requiresSignIn =
    resolved?.kind === 'ready' ? resolved.requiresSignIn : true;
  return {
    setup: {
      requiresSignIn,
      route: embeddedAllowed ? 'embedded' : 'external',
      onActivate: (): void => start('embedded'),
      ...(embeddedAllowed
        ? { onActivateExternal: (): void => start('external') }
        : {}),
      onCancel: cancel,
    },
    loading,
    ...(failure !== undefined ? { errorMessage: failure } : {}),
    dialogs: signIn.dialogs,
  };
}
