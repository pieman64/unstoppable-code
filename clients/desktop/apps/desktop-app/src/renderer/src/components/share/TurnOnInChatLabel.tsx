import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { shareInstallTurnOnInChatLabelParts } from '@canopy/ui-app/sharing/share-install-copy';
import type { ReactNode } from 'react';

/**
 * **Turn on in “<chat>”** (CAN-5219). The chat title is user-authored, so only
 * its span is masked in replay, and it carries the untruncated title on hover.
 * One wrapping span keeps the parts a single item in a button's flex gap.
 */
export function renderTurnOnInChatLabel(title: string): ReactNode {
  return (
    <span>
      {shareInstallTurnOnInChatLabelParts(title).map((part, index) =>
        part.kind === 'name' ? (
          <span key={index} className={POSTHOG_REPLAY_MASK_CLASS} title={title}>
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}
