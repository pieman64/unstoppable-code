import { useEffect, useRef } from 'react';
import type { CodexSpeed } from '@canopy/execution-engine/lib/codex-speed';
import type { CodexSpeedControl } from './useCodexSpeedControl';

/**
 * Steps a composer's requested speed down once its route definitely cannot
 * run it: a chat moved to a model without Ultra fast continues at Fast (or
 * Regular) instead of holding a choice the next turn would be refused. See
 * `codexSpeedDowngrade` for which answers count.
 *
 * Returns the speed to show: the step-down target as soon as it is known, so
 * the control never flashes the old speed while `apply` lands.
 */
export function useCodexSpeedDowngrade({
  enabled,
  speed,
  control,
  apply,
}: {
  /** False for surfaces that show no Codex speed. */
  enabled: boolean;
  speed: CodexSpeed;
  control: Pick<CodexSpeedControl, 'downgrade'>;
  apply: (next: CodexSpeed) => void;
}): CodexSpeed {
  const target = enabled ? control.downgrade(speed) : null;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (target !== null) applyRef.current(target);
  }, [target]);
  return target ?? speed;
}
