import { type JSX } from 'react';
import { HeaderActionButton } from '@canopy/ui-shared/components';
import { SettingsIcon } from '@canopy/ui-shared/icons/AppIcons';

/** Settings gear button with the activity-row hover-treatment. Used by both
 * the Hooks and Scripts sections to open per-section settings. */
export function SettingsGearButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <HeaderActionButton iconOnly onClick={onClick} aria-label={label}>
      <SettingsIcon size={16} />
    </HeaderActionButton>
  );
}
