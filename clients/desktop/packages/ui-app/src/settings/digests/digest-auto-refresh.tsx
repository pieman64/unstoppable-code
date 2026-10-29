'use client';

import { useEffect, type JSX } from 'react';
import { useSettingsRouter } from '../host';

interface DigestAutoRefreshProps {
  active: boolean;
}

const REFRESH_MS = 10_000;

/**
 * Refresh the archive's page data while digest work is in flight. Web
 * re-renders the server tree; desktop refetches the route's page data.
 */
export function DigestAutoRefresh({
  active,
}: DigestAutoRefreshProps): JSX.Element | null {
  const router = useSettingsRouter();

  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const schedule = (): void => {
      if (disposed || document.hidden) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed || document.hidden) return;
        router.refresh();
        schedule();
      }, REFRESH_MS);
    };
    const visibilityChanged = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!document.hidden && !disposed) {
        router.refresh();
        schedule();
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    schedule();
    return (): void => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [active, router]);

  if (!active) return null;
  return (
    <button
      type="button"
      className="self-start text-s font-medium fg-accent hover:underline"
      onClick={() => router.refresh()}
      data-testid="digest-refresh-now"
    >
      Refresh now
    </button>
  );
}
