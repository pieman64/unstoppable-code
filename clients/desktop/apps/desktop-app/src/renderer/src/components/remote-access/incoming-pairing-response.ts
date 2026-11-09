import { useState } from 'react';
import { toAppError } from '@canopy/protocol/app-errors';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import type { RemoteIncomingPairing } from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

const ANSWER_FAILED = "Couldn't send your answer. Try again.";

/**
 * A code request's title (CAN-5985 A3 and A6). A hosted agents request is
 * named by the product, never by the name the request carries: the relay
 * authenticated its kind, not its display name.
 */
export function incomingPairingTitle(request: RemoteIncomingPairing): string {
  const who =
    request.kind === 'hosted' ? `${brandText.appName} agents` : request.name;
  return `${who} wants to control this computer`;
}

export type IncomingPairingAnswer = 'allow' | 'deny';

interface PairingAnswerState {
  readonly pairingId: string;
  readonly busy: IncomingPairingAnswer | null;
  readonly error: InlineFailure | null;
}

/**
 * Answers the request in front of the person; dismissing a prompt denies.
 * The busy and error state belong to one request and reset for the next.
 */
export function useIncomingPairingResponse(pairingId: string | null): {
  readonly busy: IncomingPairingAnswer | null;
  readonly error: InlineFailure | null;
  readonly respond: (approve: boolean) => void;
} {
  const respondToPairing = useRemoteControlStore((s) => s.respondToPairing);
  const [answer, setAnswer] = useState<PairingAnswerState | null>(null);
  const current =
    answer !== null && answer.pairingId === pairingId ? answer : null;
  const busy = current?.busy ?? null;
  const respond = (approve: boolean): void => {
    if (pairingId === null || busy) return;
    setAnswer({ pairingId, busy: approve ? 'allow' : 'deny', error: null });
    void respondToPairing({ pairingId, approve })
      .then(() => setAnswer({ pairingId, busy: null, error: null }))
      .catch((cause: unknown) => {
        const appError = toAppError(resolveClientAppError(cause));
        setAnswer({
          pairingId,
          busy: null,
          error: appError ? inlineFailure(appError, ANSWER_FAILED) : null,
        });
      });
  };
  return { busy, error: current?.error ?? null, respond };
}
