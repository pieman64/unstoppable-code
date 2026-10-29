'use client';

import { useState, type JSX, type ReactNode } from 'react';
import { displayAvatarColor, displayInitials } from '../lib/display-avatar';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

export interface DisplayAvatarProps {
  readonly name: string;
  readonly image?: string | null;
  readonly size?: 'xs' | 'sm' | 'md';
  readonly alt?: string;
  readonly className?: string;
  readonly testId?: string;
  /**
   * Who the avatar depicts. A person's photo or initials are personal
   * identity, so session replay records a same-size box; a team's or
   * organization's (`group`) are recorded.
   */
  readonly subject?: 'person' | 'group';
  /**
   * Drawn in the avatar's box instead of the initials when there is no
   * picture or it fails to load, such as a generic person glyph.
   */
  readonly fallback?: ReactNode;
}

const SIZE_CLASS_NAMES = {
  xs: 'h-4 w-4',
  sm: 'h-5 w-5',
  md: 'h-6 w-6',
} as const;

/** Shared person avatar with a deterministic two-initial fallback. */
export function DisplayAvatar({
  name,
  image,
  size = 'md',
  alt = '',
  className = '',
  testId,
  subject = 'person',
  fallback,
}: DisplayAvatarProps): JSX.Element {
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const sizeClassName = SIZE_CLASS_NAMES[size];
  const replayClassName = subject === 'person' ? `${REPLAY_BLOCK_CLASS} ` : '';

  if (image && failedImage !== image) {
    return (
      <img
        src={image}
        alt={alt}
        data-testid={testId}
        referrerPolicy="no-referrer"
        className={`${replayClassName}${sizeClassName} shrink-0 rounded-full object-cover ${className}`}
        onError={(): void => setFailedImage(image)}
      />
    );
  }

  if (fallback !== undefined) {
    return (
      <span
        aria-hidden="true"
        data-testid={testId}
        className={`${sizeClassName} flex shrink-0 items-center justify-center ${className}`}
      >
        {fallback}
      </span>
    );
  }

  const color = displayAvatarColor(name);
  return (
    <span
      aria-hidden="true"
      data-testid={testId}
      style={color}
      className={`${replayClassName}${sizeClassName} flex shrink-0 items-center justify-center rounded-full text-3xs font-semibold uppercase ${className}`}
    >
      {displayInitials(name)}
    </span>
  );
}
