import { useEffect, type MutableRefObject } from 'react';
import {
  trackCreditsRecoveryView,
  type CreditsRecoverySurface,
  type CreditsRecoveryTrigger,
} from '@/lib/creditsRecoveryTelemetry';

export interface CreditsRecoveryViewProps {
  surface: CreditsRecoverySurface;
  trigger: CreditsRecoveryTrigger;
  /** What the view is about (a chat, a failure). Never leaves the renderer. */
  dedupeKey: string;
  /** Set while mounted, so a host records clicks only from a credits state. */
  shownRef?: MutableRefObject<boolean>;
}

/**
 * Records `billing:credits_recovery_view` when mounted (CAN-4633). Hosts
 * render it inside the branch that shows the no-credits state, so the view
 * is recorded from an effect, never from render.
 */
export function CreditsRecoveryView({
  surface,
  trigger,
  dedupeKey,
  shownRef,
}: CreditsRecoveryViewProps): null {
  useEffect(() => {
    trackCreditsRecoveryView({ surface, trigger, dedupeKey });
    if (!shownRef) return undefined;
    shownRef.current = true;
    return (): void => {
      shownRef.current = false;
    };
  }, [surface, trigger, dedupeKey, shownRef]);
  return null;
}
