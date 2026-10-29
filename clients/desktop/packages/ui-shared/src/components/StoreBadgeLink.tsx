import type { JSX } from 'react';

/** The two mobile app stores Canopy brands can publish a listing to. */
export type MobileAppStore = 'apple-app-store' | 'google-play';

/**
 * How a badge activates.
 *
 * The two hosts differ irreconcilably here: the web app wants a real anchor so
 * the badge is middle-clickable and copyable, while the desktop renderer must
 * route every outbound URL through `window.api.browser.openExternal` and never
 * renders `<a target="_blank">`.
 */
export type StoreBadgeActivation =
  | { kind: 'anchor' }
  | {
      kind: 'callback';
      onActivate: (store: MobileAppStore, url: string) => void;
    };

/** A single store listing plus the badge artwork to render for it. */
export interface MobileAppStoreLink {
  store: MobileAppStore;
  url: string;
  /** Public URL on web, `data:` URI on desktop. */
  badgeSrc: string;
}

/**
 * Vendor-prescribed alt text. Frozen deliberately: each store's brand
 * guidelines specify this exact wording for the badge artwork.
 */
const BADGE_ALT_TEXT: Record<MobileAppStore, string> = {
  'apple-app-store': 'Download on the App Store',
  'google-play': 'Get it on Google Play',
};

export interface StoreBadgeLinkProps {
  link: MobileAppStoreLink;
  activation: StoreBadgeActivation;
}

/**
 * One official store badge. Never recolor, resize below the vendor minimum, or
 * redraw the artwork — the image is rendered as-is at the single vendor-safe
 * height.
 */
export function StoreBadgeLink({
  link,
  activation,
}: StoreBadgeLinkProps): JSX.Element {
  const alt = BADGE_ALT_TEXT[link.store];
  const image = (
    <img
      src={link.badgeSrc}
      alt={alt}
      className="h-12 w-auto"
      draggable={false}
    />
  );
  const sharedClassName =
    'inline-flex shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-accent';

  if (activation.kind === 'anchor') {
    return (
      <a
        data-testid={`store-badge-${link.store}`}
        data-dd-action-name={alt}
        href={link.url}
        target="_blank"
        rel="noreferrer noopener"
        className={sharedClassName}
      >
        {image}
      </a>
    );
  }

  const { onActivate } = activation;
  return (
    <button
      data-testid={`store-badge-${link.store}`}
      data-dd-action-name={alt}
      type="button"
      aria-label={alt}
      onClick={() => onActivate(link.store, link.url)}
      className={sharedClassName}
    >
      {image}
    </button>
  );
}
