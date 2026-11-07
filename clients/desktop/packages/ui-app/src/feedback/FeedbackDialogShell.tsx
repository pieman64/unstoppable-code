'use client';

import type { JSX, ReactNode } from 'react';
import { DialogModal } from '@canopy/ui-shared/components';

export function FeedbackDialogShell({
  appName,
  errorMode,
  onClose,
  children,
}: {
  readonly appName: string;
  readonly errorMode: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title={errorMode ? 'Report this' : 'Feedback'}
      subtitle={
        errorMode
          ? `Sends this error to the ${appName} team so they can look into it.`
          : `Ideas, bugs, anything that felt off — they all go to the ${appName} team.`
      }
      maxWidth="lg"
      scrollableBody={false}
      dataTestId="feedback-modal"
    >
      {children}
    </DialogModal>
  );
}
