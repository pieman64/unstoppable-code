import { useEffect, useState } from 'react';
import type { ForeignActivityProjection } from '@canopy/protocol/foreign-activity';
const EMPTY: ForeignActivityProjection = {
  epoch: '',
  sequence: -1,
  groups: [],
};

export function useForeignActivityProjection(
  enabled: boolean,
): ForeignActivityProjection {
  const [projection, setProjection] = useState(EMPTY);
  useEffect((): (() => void) | undefined => {
    if (!enabled) return;
    let active = true;
    const accept = (next: ForeignActivityProjection): void => {
      if (active)
        setProjection(
          (previous): ForeignActivityProjection =>
            next.sequence > previous.sequence ? next : previous,
        );
    };
    const unsubscribe = window.api.foreignActivity.onChanged(accept);
    void window.api.foreignActivity
      .get()
      .then(accept)
      .catch((): void => {});
    return (): void => {
      active = false;
      unsubscribe();
    };
  }, [enabled]);
  return enabled ? projection : EMPTY;
}
