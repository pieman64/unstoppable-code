import { useEffect } from 'react';
import type { AiCreditsScopeRequest } from '@canopy/desktop-shared/types';
import type { ModelLibraryAccess } from '@canopy/protocol/models';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  APP_ADVISOR_AI_CREDITS_SCOPE,
  useStableAiCreditsScope,
} from '@/lib/aiCreditsScope';
import {
  ensureModelLibraryAccessSubscribed,
  refreshWorkModelLibraryAccess,
  useModelLibraryAccessStore,
} from '@/lib/modelLibraryAccess';

/** Access for this work owner; a personal purchase never unlocks organization work. */
export function useWorkModelLibraryAccess(
  scope?: AiCreditsScopeRequest,
  enabled = true,
): ModelLibraryAccess | undefined {
  const { scope: stableScope, key } = useStableAiCreditsScope(scope);
  const accountKey = useModelLibraryAccessStore((state) => state.accountKey);
  const read = useModelLibraryAccessStore((state) => state.workAccess?.[key]);
  useEffect(() => {
    if (!enabled) return undefined;
    ensureModelLibraryAccessSubscribed();
    const refresh = (): void => {
      void refreshWorkModelLibraryAccess(stableScope);
    };
    let active = true;
    let stopWatch: (() => void) | undefined;
    const changed = (credentialsChanged = false): void => {
      if (!active) return;
      if (credentialsChanged) {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        return;
      }
      // A read admitted before the signal may still carry the previous answer.
      // Wait for it before requesting the authoritative post-signal result.
      void refreshWorkModelLibraryAccess(stableScope).then((): void => {
        if (active) refresh();
      });
    };
    const restart = (): void => {
      stopWatch?.();
      stopWatch = window.api?.watchCanopyCloudModelLibrary?.(
        stableScope,
        changed,
      );
      refresh();
    };
    restart();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, restart);
    return (): void => {
      active = false;
      stopWatch?.();
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, restart);
    };
  }, [accountKey, enabled, key, stableScope]);
  return enabled && read?.accountKey === accountKey ? read?.access : undefined;
}

/**
 * The signed-in person's own access, whatever context is selected (CAN-5028).
 * App Advisor work is always Personal, so its scoped read names the person's
 * wallet and shares the work store, account reset, and purchase watch above.
 */
export function usePersonalModelLibraryAccess(
  enabled = true,
): ModelLibraryAccess | undefined {
  return useWorkModelLibraryAccess(APP_ADVISOR_AI_CREDITS_SCOPE, enabled);
}
