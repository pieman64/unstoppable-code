import type { JSX } from 'react';
import { Button } from './Button';
import {
  StoreBadgeLink,
  type MobileAppStoreLink,
  type StoreBadgeActivation,
} from './StoreBadgeLink';
import { Heading } from './Heading';

/**
 * Presentation of a mobile-app promotion.
 *
 * - `section` — bordered card with a heading, used on `/download` and the
 *   home/overview cards.
 * - `inline` — unbordered block, used inside an existing card or modal body.
 */
export type MobileAppPromoVariant = 'section' | 'inline';

export interface MobileAppPromoProps {
  brandDisplayName: string;
  links: readonly MobileAppStoreLink[];
  activation: StoreBadgeActivation;
  variant?: MobileAppPromoVariant;
  heading?: string;
  description?: string;
  /** When provided, renders a "Not now" dismiss control. */
  onDismiss?: () => void;
  'data-testid'?: string;
}

/** Default heading when the caller does not override it. */
export function defaultMobileAppPromoHeading(brandDisplayName: string): string {
  return `Take ${brandDisplayName} with you`;
}

/** Default supporting copy when the caller does not override it. */
export const DEFAULT_MOBILE_APP_PROMO_DESCRIPTION =
  'Monitor your agents, review activity, and manage your projects from your phone.';

/**
 * Shared mobile-app promotion used by both the web app and the desktop
 * renderer. Deliberately has no `'use client'` directive so a Next server
 * component can render it, and uses a plain `<img>` rather than `next/image`
 * so it works unchanged in the Electron renderer.
 */
export function MobileAppPromo({
  brandDisplayName,
  links,
  activation,
  variant = 'section',
  heading,
  description,
  onDismiss,
  'data-testid': dataTestId,
}: MobileAppPromoProps): JSX.Element | null {
  if (links.length === 0) {
    return null;
  }

  const resolvedHeading =
    heading ?? defaultMobileAppPromoHeading(brandDisplayName);

  const isSection = variant === 'section';

  return (
    <section
      data-testid={dataTestId ?? 'mobile-app-promo'}
      className={
        isSection
          ? 'relative w-full rounded-xl border border-line-accent/40 bg-card p-8'
          : 'relative w-full'
      }
    >
      {/* The wrapper owns the corner: Button's own `relative` wins over a
          caller's `absolute` in the built CSS. */}
      {onDismiss && (
        <span className="absolute right-3 top-3">
          <Button
            variant="ghost"
            size="compact"
            data-testid="mobile-app-promo-dismiss"
            onClick={onDismiss}
          >
            Not now
          </Button>
        </span>
      )}
      <Heading level={2} variant={isSection ? 'page' : 'title'}>
        {resolvedHeading}
      </Heading>
      <p
        className={
          isSection
            ? 'mx-auto mt-2 max-w-xl text-s fg-secondary'
            : 'mt-1 text-xs fg-secondary'
        }
      >
        {description ?? DEFAULT_MOBILE_APP_PROMO_DESCRIPTION}
      </p>
      <div
        className={`flex flex-wrap items-center gap-3 ${
          isSection ? 'mt-5 justify-center' : 'mt-3'
        }`}
      >
        {links.map((link) => (
          <StoreBadgeLink
            key={link.store}
            link={link}
            activation={activation}
          />
        ))}
      </div>
      <p className="sr-only">{`${brandDisplayName} mobile apps`}</p>
    </section>
  );
}
