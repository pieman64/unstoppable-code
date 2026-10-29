import { useState, type JSX } from 'react';
import type { TryItCapability } from '@canopy/protocol/try-it';
import { TryItSignInNotice } from '@canopy/ui-shared/components';
import {
  useTryItSignInContinuation,
  type DesktopTryItTarget,
} from '@/hooks/useTryItSignInContinuation';
import { useChatStore } from '@/stores/chatStore';
import { useTryItSetup, type TryItSetupPhase } from './useTryItSetup';

/**
 * The guest Try it sign-in notice in the composer's notice stack (CAN-4396).
 * The shared connect gate offers both sign-in and account creation, so the
 * notice carries one sign-in action. Once signed in, a missing account MCP
 * connection offers Authorize (CAN-4451); see `useTryItSetup`.
 */
export function TryItSignInBanner({
  target,
  unresolvedCapabilities,
}: {
  target: DesktopTryItTarget;
  unresolvedCapabilities: readonly TryItCapability[];
}): JSX.Element | null {
  const scopeKey = `${target.projectId}/${target.worktreeId}`;
  const hasUserTurn = useChatStore(
    (state) =>
      state.worktreeChats[scopeKey]?.tabs
        .find((tab) => tab.id === target.chatId)
        ?.messages.some((message) => message.role === 'user') ?? false,
  );
  // The initial Try it send is still unacknowledged: no flash before it lands.
  const initialSendPending = useChatStore((state) => {
    const tab = state.worktreeChats[scopeKey]?.tabs.find(
      (candidate) => candidate.id === target.chatId,
    );
    return (
      tab === undefined ||
      tab.pendingInitialCreation === true ||
      tab.pendingTurn !== undefined
    );
  });
  const [setupPhase, setSetupPhase] = useState<TryItSetupPhase>('idle');
  const gate = useTryItSignInContinuation({
    target,
    unresolvedCapabilities,
    hasUserTurn,
    initialSendPending,
    setup: setupPhase,
  });
  const setup = useTryItSetup({
    target,
    capability: gate.capability,
    requestId: gate.setupRequestId,
    accountKey: gate.accountKey,
    phase: setupPhase,
    setPhase: setSetupPhase,
    resume: gate.resumeAfterSetup,
  });
  if (!gate.capability) return null;
  return (
    <>
      <TryItSignInNotice
        state={gate.state}
        capabilityName={gate.capability.name}
        promptSaved={gate.promptSaved}
        retry={gate.retry}
        signIn={{ onActivate: gate.signIn }}
        onRetryContinuation={gate.retryContinuation}
        {...(gate.retry === 'setup' && setup.errorMessage !== undefined
          ? { errorMessage: setup.errorMessage }
          : {})}
        {...(setup.setup ? { setup: setup.setup } : {})}
        disabled={setup.loading}
      />
      {setup.dialogs}
    </>
  );
}
