'use client';

import type { JSX, ReactNode } from 'react';
import { DialogModal } from '@canopy/ui-shared/components';

export function FeedbackDialogShell({
  appName,
  errorMode,
  onClose,
  ownerDocument,
  children,
}: {
  readonly appName: string;
  readonly errorMode: boolean;
  readonly onClose: () => void;
  readonly ownerDocument?: Document | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      ownerDocument={ownerDocument}
      title={errorMode ? 'Report this' : 'Feedback'}
      subtitle={
        errorMode
          ? `Sends this error to the ${appName} team so they can look into it.`
          : `Ideas, bugs, anything that felt off — they all go to the ${appName} team.`
      }
      maxWidth="lg"
      scrollableBody={false}
      // Opens over fallbacks and pages that trap focus themselves: without its
      // own trap, keyboard users stay behind the scrim and can't reach the form.
      trapFocus
      dataTestId="feedback-modal"
    >
      {children}
    </DialogModal>
  );
}
