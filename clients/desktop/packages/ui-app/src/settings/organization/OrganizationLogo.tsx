'use client';

import type { JSX } from 'react';
import {
  DisplayAvatar,
  type DisplayAvatarSize,
} from '@canopy/ui-shared/components';
import { useAvatarImage } from './MemberAvatar';

interface OrganizationLogoProps {
  /** Organization name; drives the initials and the logo's accessible name. */
  name: string;
  /** Public logo URL when set, otherwise the initials. */
  logoUrl: string | null;
  /** A shared avatar step; defaults to `xl` (40px). */
  size?: DisplayAvatarSize;
}

/**
 * An organization's `DisplayAvatar` (a group's rounded square) through the
 * settings host: the host's image component (`next/image` on web), with the
 * logo center-cropped so wide wordmarks fill the box. Reused by the
 * org-page header, the branding settings card, the scope picker and the
 * dashboard org tiles.
 */
export function OrganizationLogo({
  name,
  logoUrl,
  size = 'xl',
}: OrganizationLogoProps): JSX.Element {
  const { Image } = useAvatarImage();
  return (
    <DisplayAvatar
      name={name}
      image={logoUrl}
      size={size}
      subject="group"
      alt={name ? `${name} logo` : 'Organization logo'}
      testId="org-logo"
      // A logo identifies the organization, so replay blocks it.
      replayBlocked
      imageComponent={Image}
    />
  );
}
