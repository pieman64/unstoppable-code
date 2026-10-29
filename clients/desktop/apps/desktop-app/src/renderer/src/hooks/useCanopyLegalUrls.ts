import { useEffect, useState } from 'react';

export interface CanopyLegalUrls {
  termsUrl: string | null;
  privacyUrl: string | null;
}

/**
 * Resolve the Terms of Service / Privacy Policy URLs from the Canopy Cloud web
 * base URL this build talks to (a localhost origin in dev, the staging origin
 * for internal builds, the production web origin for releases), so first-run
 * legal links point at the same environment data syncs to rather than the
 * static brand marketing host. Returns nulls until resolved, and stays null
 * when the base URL is not configured so callers fall back to plain text.
 */
export function useCanopyLegalUrls(): CanopyLegalUrls {
  const [urls, setUrls] = useState<CanopyLegalUrls>({
    termsUrl: null,
    privacyUrl: null,
  });

  useEffect(() => {
    let cancelled = false;
    void window.api
      .getCanopyCloudBaseUrl()
      .then((base) => {
        if (cancelled || !base) {
          return;
        }
        const trimmed = base.replace(/\/+$/, '');
        setUrls({
          termsUrl: `${trimmed}/terms`,
          privacyUrl: `${trimmed}/privacy`,
        });
      })
      .catch(() => {
        // Leave URLs null; callers render plain text instead of a broken link.
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  return urls;
}
