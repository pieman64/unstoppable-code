import type { JSX } from 'react';
import { Button } from '@canopy/ui-shared/components';
import { AttachmentIcon } from '@canopy/ui-shared/icons/AppIcons';
import { GUEST_FILES_MESSAGE } from './guest-files-copy';

export interface GuestFilesStateProps {
  readonly onSignIn: () => void;
}

export function GuestFilesState({
  onSignIn,
}: GuestFilesStateProps): JSX.Element {
  return (
    <div
      className="flex flex-col items-start gap-2 py-3"
      data-testid="guest-files-state"
    >
      <div className="flex items-start gap-2 text-xs fg-secondary">
        <AttachmentIcon size={14} aria-hidden="true" className="shrink-0" />
        <p>{GUEST_FILES_MESSAGE}</p>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="compact"
        onClick={onSignIn}
        data-testid="guest-files-sign-in"
      >
        Sign in
      </Button>
    </div>
  );
}
