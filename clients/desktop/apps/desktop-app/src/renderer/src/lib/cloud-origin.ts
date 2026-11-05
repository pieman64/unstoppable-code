import { useEffect, useState } from 'react';
import { marketplaceShareOrigin } from '@canopy/protocol/marketplace';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';

/** One in-flight configuration read shared by every row in this renderer. */
let pending: Promise<string | null> | null = null;
let listening = false;
export function resolveCloudOrigin(): Promise<string | null> {
  if (!listening) {
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, () => {
      pending = null;
    });
    listening = true;
  }
  if (!pending)
    pending = (async (): Promise<string | null> => {
      try {
        const value = await window.api?.getCanopyCloudBaseUrl?.();
        return value ? marketplaceShareOrigin(value) : null;
      } catch {
        return null;
      }
    })();
  return pending;
}

export function useCloudOrigin(): string | null {
  const [origin, setOrigin] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let generation = 0;
    const read = (): void => {
      const current = ++generation;
      setOrigin(null);
      void resolveCloudOrigin().then((value) => {
        if (active && current === generation) setOrigin(value);
      });
    };
    const changed = (): void => {
      read();
    };
    read();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    return (): void => {
      active = false;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, changed);
    };
  }, []);
  return origin;
}
