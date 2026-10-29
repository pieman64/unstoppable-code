import type { JSX } from 'react';
import { SettingsLink } from '../host';
import {
  DigestShareControls,
  type DigestShareControlsProps,
} from './digest-share-controls';

export interface DigestDetailHeaderProps {
  backHref: string;
  /**
   * Null when the viewer cannot manage sharing. Referencing the control's own
   * props rather than restating its three fields keeps the two from drifting.
   */
  share: DigestShareControlsProps | null;
}

/**
 * The header row shared by both digest detail routes: the back link on the
 * left, the share trigger centered against it on the right.
 *
 * Single component on purpose. The personal and org pages render the same
 * report and the same share controls, and the only thing that legitimately
 * differs between them is WHETHER the trigger renders (the org route's extra
 * `canEditOrg` guard), which the caller expresses by passing `share: null`.
 * Duplicating the row in each page is how the two surfaces would drift.
 */
export function DigestDetailHeader({
  backHref,
  share,
}: DigestDetailHeaderProps): JSX.Element {
  return (
    <div
      className="flex items-center justify-between gap-4"
      data-testid="digest-detail-header"
    >
      <SettingsLink
        href={backHref}
        className="text-s font-medium fg-accent hover:underline"
      >
        ← All digests
      </SettingsLink>
      {share !== null && <DigestShareControls {...share} />}
    </div>
  );
}
