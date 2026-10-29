import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  ACCOUNT_MCP_TRY_IT_SOURCE_ID,
  CURATED_MCP_TRY_IT_SOURCE_ID,
  type TryItCapability,
} from '@canopy/protocol/try-it';
import {
  resolveTryItSignInGate,
  resumeTryItContinuationAfterSetup,
  sameTryItCapability,
  tryItCapabilityReadiness,
  type TryItSignInGateState,
} from '@canopy/protocol/try-it/continuation';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { isConclusiveAccountRead } from '@canopy/desktop-shared/lib/canopy-cloud-account-read';
import {
  tryItAccountKey,
  useTryItAccount,
} from '@/hooks/useCanopyCloudConnected';
import {
  readTryItChatLaunch,
  rebindTryItChatLaunch,
  type DesktopTryItLaunch,
  continueTryItChat,
} from '@/lib/tryItChat';
import {
  parseTryItContinuation,
  readTryItContinuation,
  readTryItContinuationRaw,
  subscribeTryItContinuation,
  updateTryItContinuation,
  withoutTryItFailure,
  writeTryItContinuation,
  type DesktopTryItContinuation,
} from '@/lib/tryItContinuation';
import {
  isConnectedNonGuest,
  useCloudConnectGateStore,
  type CloudConnectGateContext,
} from '@/stores/cloudConnectGateStore';
import { useChatStore } from '@/stores/chatStore';
import { runDesktopTryItContinuation } from '@/lib/tryItContinuationRunner';
import { readTryItSendReceipt } from '@/lib/tryItSendReceipt';

/**
 * Guest Try it sign-in continuation on desktop (CAN-4396). One owner per
 * composer: the banner's actions, the connect gate's close or proceed, and an
 * explicit retry all enter the same guarded routine.
 *
 * Fresh account connections resolve only the launched MCP identity. Usable
 * selections continue through the canonical durable command seam; missing
 * connections stay setup-required until the setup step (CAN-4451) verifies
 * one and requeues the same record through {@link DesktopTryItSignIn.resumeAfterSetup}.
 * Recovery first reads main's durable command receipt (CAN-4404), so an
 * accepted turn completes without being sent again.
 */

export interface DesktopTryItTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export interface UseTryItSignInContinuationInput {
  target: DesktopTryItTarget;
  unresolvedCapabilities: readonly TryItCapability[];
  hasUserTurn: boolean;
  /** The initial Try it send has not been acknowledged yet. */
  initialSendPending: boolean;
  /** Transient setup progress for a signed-in setup-required record. */
  setup?: 'idle' | 'active' | 'cancelled' | 'failed';
}

export interface DesktopTryItSignIn {
  state: TryItSignInGateState;
  capability: TryItCapability | null;
  promptSaved: boolean;
  retry: 'authentication' | 'continuation' | 'setup';
  signIn: () => void;
  retryContinuation: () => void;
  /** The signed-in record waiting on setup, or null. */
  setupRequestId: string | null;
  /** The signed-in account key, or null. */
  accountKey: string | null;
  /**
   * Requeues the current `setup-required` record carrying `requestId` and
   * binds it through the existing runner. False when it was replaced, is no
   * longer setup-required, or the account changed.
   */
  resumeAfterSetup: (requestId: string) => boolean;
}

/** Only account MCP connections can be satisfied by signing in. */
export function isAccountGatedCapability(capability: TryItCapability): boolean {
  return (
    capability.kind === 'mcp' &&
    (capability.sourceId === CURATED_MCP_TRY_IT_SOURCE_ID ||
      capability.sourceId === ACCOUNT_MCP_TRY_IT_SOURCE_ID)
  );
}

/** The guest launch that opened this exact chat, never inferred from a message. */
export function findGuestTryItLaunch(
  target: DesktopTryItTarget,
  capabilities: readonly TryItCapability[],
  read: (
    accountId: string,
    capability: TryItCapability,
  ) => DesktopTryItLaunch | null = readTryItChatLaunch,
): DesktopTryItLaunch | null {
  return findAccountTryItLaunch(target, capabilities, 'guest', read);
}

function findAccountTryItLaunch(
  target: DesktopTryItTarget,
  capabilities: readonly TryItCapability[],
  accountKey: string,
  read: typeof readTryItChatLaunch = readTryItChatLaunch,
): DesktopTryItLaunch | null {
  for (const capability of capabilities) {
    if (!isAccountGatedCapability(capability)) continue;
    const launch = read(accountKey, capability);
    if (
      launch?.chatId === target.chatId &&
      launch.location?.projectId === target.projectId &&
      launch.location.worktreeId === target.worktreeId
    )
      return launch;
  }
  return null;
}

/** Recheck the real account, never infer authentication from a changed ID. */
async function authenticatedAccountKey(): Promise<string | null> {
  try {
    const account = await window.api.loadCanopyCloudAccount();
    if (!isConclusiveAccountRead(account) || !isConnectedNonGuest(account))
      return null;
    const key = tryItAccountKey(account);
    return key === 'guest' ? null : key;
  } catch {
    return null;
  }
}

export async function bindTryItContinuation(
  target: DesktopTryItTarget,
  requestId: string,
  destinationAccountKey: string,
): Promise<void> {
  const record = readTryItContinuation(target.chatId);
  if (
    record?.requestId !== requestId ||
    record.host?.projectId !== target.projectId ||
    record.host.worktreeId !== target.worktreeId
  )
    return;
  await runDesktopTryItContinuation(target.chatId, destinationAccountKey, {
    accountKey: authenticatedAccountKey,
    selections: () => {
      const tab = useChatStore
        .getState()
        .worktreeChats[
          `${target.projectId}/${target.worktreeId}`
        ]?.tabs.find((candidate) => candidate.id === target.chatId);
      return tab && !tab.readOnly && !tab.pendingInitialCreation
        ? (tab.pluginSelections ?? {
            collectionIds: [],
            skillRefs: [],
            pluginRefs: [],
          })
        : null;
    },
    connections: () => window.mcpServers.listAccountConnections(),
    updateSelections: async (pluginSelections, canContinue) => {
      await window.api.chat.updatePlugins({ ...target, pluginSelections });
      if (!(await canContinue())) return;
      useChatStore
        .getState()
        .setPluginSelections(pluginSelections, target, undefined, {
          runtimeAlreadyUpdated: true,
        });
    },
    continueChat: continueTryItChat,
    rebind: (record, accountKey) => {
      rebindTryItChatLaunch({
        fromAccountId: record.sourceAccountKey,
        toAccountId: accountKey,
        capability: record.capability,
        chatId: target.chatId,
      });
    },
    receipt: (request) => readTryItSendReceipt(request),
  });
}

function freshContinuation(
  launch: DesktopTryItLaunch,
  target: DesktopTryItTarget,
): DesktopTryItContinuation {
  const tab = useChatStore
    .getState()
    .worktreeChats[
      `${target.projectId}/${target.worktreeId}`
    ]?.tabs.find((candidate) => candidate.id === target.chatId);
  return {
    version: 1,
    sourceChatId: target.chatId,
    sourceSessionId: target.chatId,
    sourceAccountKey: launch.accountId,
    capability: launch.capability,
    sourceRequestId: launch.requestId,
    requestId: crypto.randomUUID(),
    prompt: launch.prompt,
    createdAtMs: Date.now(),
    status: 'pending',
    host: {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      ...(tab?.model
        ? { model: { model: tab.model, thinkingLevel: tab.thinkingLevel } }
        : {}),
    },
  };
}

const SIGN_IN_CONTEXT: CloudConnectGateContext = { subtitle: null };

export function useTryItSignInContinuation(
  input: UseTryItSignInContinuationInput,
): DesktopTryItSignIn {
  const {
    target,
    unresolvedCapabilities,
    hasUserTurn,
    initialSendPending,
    setup = 'idle',
  } = input;
  const { projectId, worktreeId, chatId } = target;
  const account = useTryItAccount();
  const subscribe = useCallback(
    (listener: () => void) => subscribeTryItContinuation(chatId, listener),
    [chatId],
  );
  const raw = useSyncExternalStore(subscribe, () =>
    readTryItContinuationRaw(chatId),
  );
  const record = useMemo(
    () => parseTryItContinuation(raw, chatId),
    [raw, chatId],
  );
  const launch = useMemo(
    () =>
      account.status !== 'loading' && account.accountId
        ? findAccountTryItLaunch(
            { projectId, worktreeId, chatId },
            unresolvedCapabilities,
            account.accountId,
          )
        : null,
    [
      account.status,
      account.accountId,
      projectId,
      worktreeId,
      chatId,
      unresolvedCapabilities,
    ],
  );
  const [authentication, setAuthentication] = useState<'idle' | 'active'>(
    'idle',
  );
  const attemptRef = useRef<object | null>(null);
  const finishReadRef = useRef(0);
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => (): void => {
      attemptRef.current = null;
      cleanupRef.current?.();
    },
    [chatId],
  );

  const capability = record?.capability ?? launch?.capability ?? null;
  const readiness = capability
    ? tryItCapabilityReadiness(capability, {
        authoritative: true,
        unresolved: unresolvedCapabilities,
      })
    : 'unknown';
  const state = resolveTryItSignInGate({
    account: account.status,
    ...(account.accountId === null ? {} : { accountKey: account.accountId }),
    chatId,
    capability:
      capability && isAccountGatedCapability(capability) ? capability : null,
    transcriptLoading: false,
    initialAttemptSettled:
      !initialSendPending &&
      (record !== null || launch?.status === 'completed'),
    hasUserTurn,
    readiness,
    authentication:
      authentication === 'active'
        ? 'active'
        : record?.failure === 'authentication-cancelled'
          ? 'cancelled'
          : record?.failure === 'authentication-failed'
            ? 'failed'
            : 'idle',
    setup,
    continuation: record,
  });

  // Save the continuation once the guest sees the notice, so its copy can
  // honestly say the prompt is saved. Activation reuses this record.
  const unsaved = state === 'sign-in' && record === null ? launch : null;
  useEffect(() => {
    if (unsaved)
      writeTryItContinuation(
        freshContinuation(unsaved, { projectId, worktreeId, chatId }),
      );
  }, [unsaved, projectId, worktreeId, chatId]);

  useEffect(() => {
    if (
      record !== null ||
      account.status !== 'signed-in' ||
      !account.accountId ||
      launch?.status !== 'completed' ||
      initialSendPending ||
      !hasUserTurn ||
      (readiness !== 'unresolved' && readiness !== 'needs-account') ||
      readTryItContinuation(chatId) !== null
    )
      return;
    writeTryItContinuation({
      ...freshContinuation(launch, { projectId, worktreeId, chatId }),
      destinationAccountKey: account.accountId,
      status: 'setup-required',
    });
  }, [
    record,
    account.status,
    account.accountId,
    launch,
    initialSendPending,
    hasUserTurn,
    readiness,
    projectId,
    worktreeId,
    chatId,
  ]);

  const finish = useCallback(
    async (attempt: object, requestId: string | null): Promise<void> => {
      const read = ++finishReadRef.current;
      let next: CanopyCloudAccountPublicState | null = null;
      try {
        next = await window.api.loadCanopyCloudAccount();
      } catch {
        next = null;
      }
      if (attemptRef.current !== attempt || finishReadRef.current !== read)
        return;
      attemptRef.current = null;
      setAuthentication('idle');
      if (requestId === null) return;
      const where = { projectId, worktreeId, chatId };
      // The same key `useTryItAccount` scopes launches by: an account it
      // still reads as `guest` never becomes a destination.
      const destination =
        next && isConclusiveAccountRead(next) && isConnectedNonGuest(next)
          ? tryItAccountKey(next)
          : 'guest';
      if (destination !== 'guest') {
        await bindTryItContinuation(where, requestId, destination);
        return;
      }
      updateTryItContinuation(chatId, requestId, (current) =>
        current.status === 'pending'
          ? {
              ...current,
              status: 'failed',
              failure:
                next && isConclusiveAccountRead(next)
                  ? 'authentication-cancelled'
                  : 'authentication-failed',
            }
          : current,
      );
    },
    [projectId, worktreeId, chatId],
  );

  const signIn = useCallback((): void => {
    if (account.status !== 'guest' || !capability || attemptRef.current) return;
    const existing = readTryItContinuation(chatId);
    const base: DesktopTryItContinuation | null =
      existing &&
      existing.status !== 'completed' &&
      sameTryItCapability(existing.capability, capability)
        ? existing
        : launch
          ? freshContinuation(launch, { projectId, worktreeId, chatId })
          : null;
    // A bound attempt may already have dispatched. Signing in again must not
    // turn its uncertainty into a fresh pending attempt or change its scope.
    const pending: DesktopTryItContinuation | null = base
      ? base.destinationAccountKey !== undefined
        ? base
        : {
            ...withoutTryItFailure(base),
            status: 'pending',
            host: {
              ...base.host,
              projectId,
              worktreeId,
              authIntentAtMs: Date.now(),
            },
          }
      : null;
    // A refused write still opens sign-in; it just never continues.
    const requestId =
      pending && writeTryItContinuation(pending) ? pending.requestId : null;
    const attempt = {};
    attemptRef.current = attempt;
    cleanupRef.current?.();
    setAuthentication('active');
    let opened = false;
    let disposed = false;
    const settle = (): void => {
      if (disposed) return;
      unsubscribe();
      void finish(attempt, requestId);
    };
    const proceed = (): void => {
      if (disposed) return;
      attemptRef.current = attempt;
      settle();
    };
    // A successful proceed supersedes a guest read begun by close. A replaced
    // request or an unmounted owner can never revive its old callback.
    const unsubscribe = useCloudConnectGateStore.subscribe((gate) => {
      if (gate.pending?.proceed === proceed) opened = true;
      else if (opened) settle();
    });
    cleanupRef.current = (): void => {
      disposed = true;
      unsubscribe();
    };
    useCloudConnectGateStore
      .getState()
      .requestConnect(SIGN_IN_CONTEXT, proceed);
  }, [
    account.status,
    capability,
    chatId,
    finish,
    launch,
    projectId,
    worktreeId,
  ]);

  const retryContinuation = useCallback((): void => {
    if (account.status === 'guest') {
      signIn();
      return;
    }
    if (account.status !== 'signed-in' || !account.accountId || !record) return;
    // An explicit retry after a sign-in elsewhere (the sidebar, another
    // window) binds this chat to the account now signed in.
    void bindTryItContinuation(
      { projectId, worktreeId, chatId },
      record.requestId,
      account.accountId,
    );
  }, [
    account.status,
    account.accountId,
    record,
    signIn,
    projectId,
    worktreeId,
    chatId,
  ]);

  const signedInKey =
    account.status === 'signed-in' && account.accountId
      ? account.accountId
      : null;
  const resumeAfterSetup = useCallback(
    (requestId: string): boolean => {
      if (signedInKey === null) return false;
      // Re-read the stored record rather than trusting a callback's copy.
      const before = readTryItContinuation(chatId);
      if (
        before?.requestId !== requestId ||
        before.status !== 'setup-required' ||
        !capability ||
        !isAccountGatedCapability(capability) ||
        !sameTryItCapability(before.capability, capability) ||
        (before.destinationAccountKey !== undefined &&
          before.destinationAccountKey !== signedInKey)
      )
        return false;
      const resumed = updateTryItContinuation(
        chatId,
        requestId,
        resumeTryItContinuationAfterSetup,
      );
      if (resumed?.status !== 'pending') return false;
      // The recovery effect may bind too; the runner's fencing sends once.
      void bindTryItContinuation(
        { projectId, worktreeId, chatId },
        requestId,
        signedInKey,
      );
      return true;
    },
    [signedInKey, projectId, worktreeId, chatId, capability],
  );

  // Do not rerun an automatic attempt on its own status writes. Account changes,
  // remount recovery and explicit retry enter the same guarded routine.
  const recoverRequestId =
    record &&
    record.status !== 'completed' &&
    record.status !== 'setup-required'
      ? record.requestId
      : null;
  useEffect(() => {
    if (
      account.status !== 'signed-in' ||
      !account.accountId ||
      !recoverRequestId
    )
      return;
    void bindTryItContinuation(
      { projectId, worktreeId, chatId },
      recoverRequestId,
      account.accountId,
    );
  }, [
    account.status,
    account.accountId,
    projectId,
    worktreeId,
    chatId,
    recoverRequestId,
  ]);

  return {
    state,
    capability,
    promptSaved: record !== null,
    retry:
      record?.status === 'setup-required' && signedInKey !== null
        ? 'setup'
        : account.status === 'signed-in' ||
            (record?.failure !== undefined &&
              record.failure !== 'authentication-cancelled' &&
              record.failure !== 'authentication-failed')
          ? 'continuation'
          : 'authentication',
    signIn,
    retryContinuation,
    setupRequestId:
      signedInKey !== null &&
      record?.status === 'setup-required' &&
      capability !== null &&
      isAccountGatedCapability(capability) &&
      (state === 'setup-required' ||
        state === 'authorizing' ||
        state === 'retry')
        ? record.requestId
        : null,
    accountKey: signedInKey,
    resumeAfterSetup,
  };
}
