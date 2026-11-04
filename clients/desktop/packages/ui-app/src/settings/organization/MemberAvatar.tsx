'use client';

import type { JSX } from 'react';
import {
  DisplayAvatar,
  type DisplayAvatarSize,
} from '@canopy/ui-shared/components';
import { useOptionalSettingsHost, type SettingsImageComponent } from '../host';

/**
 * The settings host's image component (`next/image` on web), or none outside
 * a host, where the avatar renders a plain image.
 */
export function useAvatarImage(): {
  readonly Image: SettingsImageComponent | undefined;
} {
  return { Image: useOptionalSettingsHost()?.Image };
}

interface MemberAvatarProps {
  /** Display name; drives the initials and the avatar's accessible name. */
  name: string;
  /** Avatar image URL when available, otherwise the initials. */
  image: string | null;
  /** A shared avatar step; defaults to `lg` (32px, the members-row size). */
  size?: DisplayAvatarSize;
}

/**
 * A member's `DisplayAvatar` through the settings host: the host's image
 * component (`next/image` on web), and the member's name as the avatar's
 * accessible name. Reused by the team Members list, the activity feed and
 * the profile pages.
 */
export function MemberAvatar({
  name,
  image,
  size = 'lg',
}: MemberAvatarProps): JSX.Element {
  const { Image } = useAvatarImage();
  return (
    <DisplayAvatar
      name={name}
      image={image}
      size={size}
      alt={name || 'Unknown member'}
      imageComponent={Image}
    />
  );
}
