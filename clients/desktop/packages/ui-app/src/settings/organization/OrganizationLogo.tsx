'use client';

import { useState, type JSX } from 'react';
import { joinClassNames } from './join-class-names';
import { initialsOf, useAvatarImage } from './MemberAvatar';

interface OrganizationLogoProps {
  /** Organization name; drives the initials fallback and image alt text. */
  name: string;
  /** Public logo URL when set, otherwise the initials placeholder. */
  logoUrl: string | null;
  /** Square pixel size; defaults to 40. */
  size?: number;
  /** Extra classes for the rendered element. */
  className?: string;
}

/**
 * The canonical organization logo treatment: a rounded **square** rendered as a
 * center-cropped host image (`next/image` on web, `object-cover`, so wide wordmarks fill the box),
 * or a colored initials placeholder when no logo is set. The square analog of
 * {@link MemberAvatar}; reused by the org-page header, the branding settings
 * card, and the dashboard org tiles so every surface matches.
 */
export function OrganizationLogo({
  name,
  logoUrl,
  size = 40,
  className = '',
}: OrganizationLogoProps): JSX.Element {
  // Track which URL failed so the initials fallback engages on a load error but
  // auto-clears if the caller later passes a different logo (React does not
  // reset component state on a prop change on its own).
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  // Logos and initials identify the organization, so replay blocks them.
  const { Image, blockClassName } = useAvatarImage();

  if (logoUrl && brokenSrc !== logoUrl) {
    return (
      <span
        data-testid="org-logo"
        style={{ width: size, height: size }}
        className={joinClassNames(
          'inline-flex shrink-0 overflow-hidden rounded-lg',
          className,
          blockClassName,
        )}
      >
        <Image
          src={logoUrl}
          alt={`${name} logo`}
          width={size}
          height={size}
          // Logo URLs come from arbitrary GCS buckets. Running them through the
          // Next image optimizer would require allow-listing every host in
          // next.config and throws at render on any unlisted one. Render them
          // unoptimized and fall back to initials if the URL fails to load.
          unoptimized
          onError={() => setBrokenSrc(logoUrl)}
          className="h-full w-full object-cover"
        />
      </span>
    );
  }
  return (
    <span
      role="img"
      data-testid="org-logo"
      aria-label={name ? `${name} logo` : 'Organization logo'}
      style={{ width: size, height: size }}
      className={joinClassNames(
        'flex shrink-0 items-center justify-center rounded-lg bg-accent text-xs font-medium fg-emphasis',
        className,
        blockClassName,
      )}
    >
      {initialsOf(name)}
    </span>
  );
}
