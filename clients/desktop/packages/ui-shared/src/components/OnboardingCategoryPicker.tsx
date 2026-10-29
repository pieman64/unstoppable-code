import { useId, type JSX } from 'react';
import { CheckIcon } from '../icons/AppIcons';
import type { ProfileRoleId } from '@canopy/protocol/plugin-catalog';
import { onboardingCategoryOptions } from '../lib/onboarding-recommendations';
import { OnboardingChoiceTile } from './OnboardingChoiceTile';

export interface OnboardingCategoryPickerProps {
  selected: readonly ProfileRoleId[];
  /** Adds or removes one category; the host saves the roles and re-ranks. */
  onToggle: (role: ProfileRoleId) => void;
  disabled?: boolean;
  /** Each tile's test id is `${testIdPrefix}-${roleId}`. */
  testIdPrefix: string;
}

/**
 * The category row above the Getting started tool tiles: the profile roles
 * as compact multi-select toggles under a "Pick a category" label. It
 * replaces the separate roles step, so choosing a category re-ranks the tool
 * suggestions right below it instead of on a later step.
 */
export function OnboardingCategoryPicker({
  selected,
  onToggle,
  disabled = false,
  testIdPrefix,
}: OnboardingCategoryPickerProps): JSX.Element {
  const headingId = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span id={headingId} className="text-xs fg-secondary">
        Pick a category
      </span>
      <div
        role="group"
        aria-labelledby={headingId}
        data-testid={`${testIdPrefix}s`}
        // One row, as the tools tiles below it; a narrow host scrolls the row
        // sideways rather than clipping the trailing tiles, which is where a
        // saved role outside the top five sits so it can be turned off.
        className="flex min-w-0 flex-nowrap gap-1.5 overflow-x-auto"
      >
        {onboardingCategoryOptions(selected).map((option) => {
          const isSelected = selected.includes(option.id);
          return (
            <OnboardingChoiceTile
              key={option.id}
              variant="category"
              selected={isSelected}
              disabled={disabled}
              data-testid={`${testIdPrefix}-${option.id}`}
              icon={
                isSelected ? (
                  <CheckIcon
                    size={12}
                    className="shrink-0 fg-accent"
                    aria-hidden="true"
                  />
                ) : undefined
              }
              onClick={(): void => onToggle(option.id)}
            >
              {option.label}
            </OnboardingChoiceTile>
          );
        })}
      </div>
    </div>
  );
}
