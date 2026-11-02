import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { ModelUnlockPendingNotice } from '@canopy/ui-shared';
import {
  checkModelUnlockNow,
  clearModelUnlockIntent,
  useModelUnlockIntentStore,
} from '@/lib/modelUnlockIntent';
import { modelUnlockIntentLabel } from '@/lib/modelUnlockLabel';

export interface ModelUnlockPendingBannerProps {
  /**
   * The composer's chat. Only the chat where the purchase started shows the
   * notice, because that is where its model will be applied.
   */
  readonly chatId: string | null | undefined;
}

/**
 * The composer's cue for an advanced-model purchase still finishing in the
 * browser (CAN-5030), so closing the recovery dialog never hides it.
 *
 * Only reads and checks: polling stays with the app root, and **Check now**
 * joins its single-flight check. Dismiss, offered once automatic checks have
 * stopped, forgets only this purchase.
 */
export function ModelUnlockPendingBanner({
  chatId,
}: ModelUnlockPendingBannerProps): JSX.Element | null {
  const requestId = useModelUnlockIntentStore((state) =>
    chatId !== null &&
    chatId !== undefined &&
    state.intent !== null &&
    state.intent.chatId === chatId &&
    (state.phase === 'waiting' || state.phase === 'timed-out')
      ? state.intent.requestId
      : null,
  );
  const phase = useModelUnlockIntentStore((state) =>
    state.intent !== null && state.intent.requestId === requestId
      ? state.phase
      : null,
  );
  const modelId = useModelUnlockIntentStore((state) =>
    state.intent !== null && state.intent.requestId === requestId
      ? state.intent.modelId
      : null,
  );
  /**
   * The request whose check this banner started, so a check that settles
   * after its purchase was replaced cannot clear the replacement's busy state.
   */
  const [checkingRequestId, setCheckingRequestId] = useState<string | null>(
    null,
  );
  const checkingRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const handleCheckNow = useCallback((): void => {
    if (requestId === null || checkingRef.current === requestId) return;
    // Re-read: the rendered notice may describe a purchase already replaced.
    if (useModelUnlockIntentStore.getState().intent?.requestId !== requestId) {
      return;
    }
    checkingRef.current = requestId;
    setCheckingRequestId(requestId);
    void checkModelUnlockNow()
      .catch((): void => {
        // A failed read is not a failed payment: the notice stays as it is.
      })
      .finally((): void => {
        if (checkingRef.current === requestId) checkingRef.current = null;
        if (!mountedRef.current) return;
        setCheckingRequestId((current) =>
          current === requestId ? null : current,
        );
      });
  }, [requestId]);

  const handleDismiss = useCallback((): void => {
    if (requestId !== null) clearModelUnlockIntent(requestId);
  }, [requestId]);

  if (requestId === null || (phase !== 'waiting' && phase !== 'timed-out')) {
    return null;
  }
  const modelLabel = modelUnlockIntentLabel(modelId);
  return (
    <ModelUnlockPendingNotice
      phase={phase}
      {...(modelLabel === undefined ? {} : { modelLabel })}
      checking={checkingRequestId === requestId}
      onCheckNow={handleCheckNow}
      onDismiss={handleDismiss}
    />
  );
}
