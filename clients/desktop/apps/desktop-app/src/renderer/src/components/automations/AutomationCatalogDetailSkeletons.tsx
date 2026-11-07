import type { JSX } from 'react';
import {
  Heading,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
  Skeleton,
  Surface,
} from '@canopy/ui-shared/components';
import { McpServerLogo } from '../shared/McpServerLogo';

/**
 * Loading states for the automation catalog details, built from the same
 * heading and settings rows as the loaded details, with plain samples inside
 * `Skeleton`, so the bars sit where the details will. The loaded previews
 * fetch share state of their own, so they do not render from a sample. Wrap
 * each in `DelayedLoadingPlaceholder` so a fast read never flashes it.
 */

const SAMPLE_NAME = 'Daily review';
const SAMPLE_DESCRIPTION = 'Reviews open pull requests each weekday.';

const SAMPLE_SHARED_FACTS = [
  ['Trigger', 'Schedule · Weekdays at 9:00'],
  ['Action', 'Chat prompt'],
  ['Owner', 'Platform team · Organization'],
  ['Shared by', 'Sam Lee'],
] as const;

/** A team-shared automation: its preview card of name and details. */
export function SharedAutomationDetailSkeleton(): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading automation"
      testId="shared-automation-detail-loading"
    >
      <Surface variant="inset" padding="default" gap="group">
        <div className="min-w-0">
          <Heading level={3} variant="section" truncate>
            {SAMPLE_NAME}
          </Heading>
          <p className="text-s fg-secondary">{SAMPLE_DESCRIPTION}</p>
        </div>
        <SettingsRowsSection title="Details">
          <SettingsRowsGroup>
            {SAMPLE_SHARED_FACTS.map(([label, value]) => (
              <SettingsRowsRow
                key={label}
                fact
                label={label}
                control={<SettingsRowsValue>{value}</SettingsRowsValue>}
              />
            ))}
          </SettingsRowsGroup>
        </SettingsRowsSection>
      </Surface>
    </Skeleton>
  );
}

/** A curated catalog automation: its header, summary, and schedule. */
export function CuratedAutomationDetailSkeleton({
  name,
}: {
  /** The entry name, known before its detail arrives. */
  readonly name: string;
}): JSX.Element {
  return (
    <Skeleton
      loading
      label="Loading automation"
      testId="curated-automation-detail-loading"
    >
      <div className="flex flex-col gap-6">
        <div className="flex items-start gap-3">
          <McpServerLogo
            size={40}
            fallback="monogram"
            name={name || SAMPLE_NAME}
            shape="circle"
            fit="contain"
          />
          <div className="min-w-0 flex-1">
            <Heading level={2} variant="section">
              {name || SAMPLE_NAME}
            </Heading>
            <p className="text-xs fg-secondary">Curated</p>
          </div>
        </div>
        <p className="text-s fg-secondary">{SAMPLE_DESCRIPTION}</p>
        <SettingsRowsSection title="Details">
          <SettingsRowsGroup>
            <SettingsRowsRow
              fact
              label="Schedule"
              control={<SettingsRowsValue>Weekdays at 9:00</SettingsRowsValue>}
            />
          </SettingsRowsGroup>
        </SettingsRowsSection>
      </div>
    </Skeleton>
  );
}
