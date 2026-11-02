import type { JSX } from 'react';
import { ComposerSelectionReason } from '@canopy/ui-shared/components';
import { useHomeComposerStore } from '@/stores/homeComposerStore';

interface HomeWorkspaceSelectionReasonProps {
  /** Opens the Home project picker without changing the selection. */
  onSwitch: () => void;
}

/**
 * Explains a first-run landing on the most recently active of several
 * imported projects (CAN-4674). Mount beside `HomeWorkspacePicker`, only
 * where that picker is visible; any later selection clears the reason.
 */
export function HomeWorkspaceSelectionReason({
  onSwitch,
}: HomeWorkspaceSelectionReasonProps): JSX.Element | null {
  const visible = useHomeComposerStore(
    (s) =>
      s.workspaceId !== null &&
      s.workspaceSelectionReason === 'most-recent-import',
  );
  if (!visible) return null;
  return (
    <ComposerSelectionReason
      reason="Most recent"
      actionLabel="Switch"
      actionAccessibleName="Switch project"
      onAction={onSwitch}
      testId="home-workspace-reason"
    />
  );
}
