import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type {
  MobileAppStore,
  MobileAppStoreLink,
} from '@canopy/ui-shared/components/StoreBadgeLink';

/** Data URIs keyed by store. A store is absent when its encode failed. */
export type StoreQrCodes = Partial<Record<MobileAppStore, string>>;

/**
 * Rendered QR edge in device pixels. Generated at 2x the ~144px display box so
 * the code stays crisp on a HiDPI display without a second encode pass.
 */
const QR_WIDTH_PX = 288;

/**
 * Encode each store URL as a QR data URI.
 *
 * Deliberately lives in the desktop renderer rather than `@canopy/ui-shared`:
 * the shared package is display-only, and pulling an encoder into it would
 * push a dependency onto every consumer (including Next server components)
 * for a desktop-only affordance.
 *
 * `enabled` is expected to be latched true on the first popover open, so the
 * always-mounted shell never pays for encoding a promo the user may never
 * expand. Once latched it stays true, so re-opening the popover reuses the
 * already-generated codes instead of flashing an empty tile.
 *
 * **All** stores are encoded on that first open even though only one QR is
 * ever displayed: encoding a short URL is a cheap local call, and having both
 * ready makes the store toggle switch instantly.
 *
 * Failures are per-link and silent — the store is simply omitted, its tile is
 * skipped, and the official badges still work. A missing QR must never block
 * the popover.
 */
export function useStoreQrCodes(
  links: readonly MobileAppStoreLink[],
  enabled: boolean,
): StoreQrCodes {
  const [codes, setCodes] = useState<StoreQrCodes>({});
  // Serialized so a caller re-deriving `links` each render does not restart
  // generation on every pass.
  const linkKey = links.map((link) => `${link.store}:${link.url}`).join('|');

  useEffect(() => {
    if (!enabled || links.length === 0) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      const entries = await Promise.all(
        links.map(async (link): Promise<[MobileAppStore, string] | null> => {
          try {
            const dataUrl = await QRCode.toDataURL(link.url, {
              // Four modules is the quiet zone the QR spec requires for
              // reliable acquisition. The tile's CSS padding is not a
              // substitute: it is ~8 physical px regardless of how many
              // modules the encoded URL needs, so a longer store URL (a
              // denser symbol) shrinks it below one module.
              margin: 4,
              width: QR_WIDTH_PX,
            });
            return [link.store, dataUrl];
          } catch {
            // Omitted from the result; the badge for this store still renders.
            return null;
          }
        }),
      );
      if (cancelled) {
        return;
      }
      const next: StoreQrCodes = {};
      for (const entry of entries) {
        if (entry !== null) {
          next[entry[0]] = entry[1];
        }
      }
      setCodes(next);
    })();
    return (): void => {
      cancelled = true;
    };
    // `linkKey` stands in for `links` identity; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, linkKey]);

  return codes;
}
