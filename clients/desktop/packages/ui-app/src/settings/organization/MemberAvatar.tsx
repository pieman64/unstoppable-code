'use client';

import { useState, type JSX } from 'react';
import {
  useOptionalSettingsHost,
  type SettingsImageComponent,
  type SettingsImageProps,
} from '../host';
import { joinClassNames } from './join-class-names';

/**
 * Derive up-to-2-letter uppercase initials from a name, falling back to `'?'`
 * when no usable characters are present (e.g. a removed/unknown actor). Shared
 * by every avatar placeholder so the team Members list and the activity feed
 * render identical initials. `max` is 1 where two letters do not fit.
 */
export function initialsOf(name: string, max: 1 | 2 = 2): string {
  return (
    name
      .split(' ')
      .map((part) => part[0] ?? '')
      .join('')
      .toUpperCase()
      .slice(0, max) || '?'
  );
}

/**
 * A plain `<img>` for avatars rendered outside a settings host (public run
 * and plan views reuse this treatment). Inside a host the host's image
 * component renders instead.
 */
function PlainImage({
  src,
  alt,
  width,
  height,
  className,
  onError,
  'data-testid': testId,
}: SettingsImageProps): JSX.Element {
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      onError={onError}
      data-testid={testId}
    />
  );
}

/**
 * The host's image component and replay-privacy block class, or a plain
 * image and no class outside a settings host.
 */
export function useAvatarImage(): {
  readonly Image: SettingsImageComponent;
  readonly blockClassName: string;
} {
  const host = useOptionalSettingsHost();
  return {
    Image: host?.Image ?? PlainImage,
    blockClassName: host?.privacy.blockClassName ?? '',
  };
}

interface MemberAvatarProps {
  /** Display name; drives the initials placeholder and image alt text. */
  name: string;
  /** Avatar image URL when available, otherwise the initials placeholder. */
  image: string | null;
  /** Square pixel size; defaults to 32 (the 8×8 members-row size). */
  size?: number;
  /** Extra classes for the rendered element. */
  className?: string;
  /** Letters in the initials placeholder; 1 for avatars too small for two. */
  maxInitials?: 1 | 2;
}

/**
 * The canonical member avatar treatment: the member's image rendered as a
 * round host image (`next/image` on web), or a colored initials placeholder
 * (`bg-accent fg-emphasis`) when no image exists. Reused by the
 * team Members list and the activity feed so both surfaces match exactly.
 */
export function MemberAvatar({
  name,
  image,
  size = 32,
  className = '',
  maxInitials = 2,
}: MemberAvatarProps): JSX.Element {
  // Track which URL failed so the initials fallback engages on a load error but
  // auto-clears if the caller later passes a different image (React does not
  // reset component state on a prop change on its own).
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  // Avatars and the initials derived from a name identify a person, so both
  // are blocked from session replay.
  const { Image, blockClassName } = useAvatarImage();

  if (image && brokenSrc !== image) {
    return (
      <Image
        src={image}
        alt={name}
        width={size}
        height={size}
        // Avatar URLs come from arbitrary provider hosts (Google, GCS buckets,
        // gravatar, ...). Running them through the Next image optimizer would
        // require allow-listing every host in next.config and throws at render
        // on any unlisted one — taking down the whole page. Render them
        // unoptimized and fall back to initials if the URL fails to load.
        unoptimized
        onError={() => setBrokenSrc(image)}
        className={joinClassNames('rounded-full', className, blockClassName)}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={name || 'Unknown member'}
      style={{ width: size, height: size }}
      className={joinClassNames(
        'flex items-center justify-center rounded-full bg-accent text-xs font-medium fg-emphasis',
        className,
        blockClassName,
      )}
    >
      {initialsOf(name, maxInitials)}
    </span>
  );
}
