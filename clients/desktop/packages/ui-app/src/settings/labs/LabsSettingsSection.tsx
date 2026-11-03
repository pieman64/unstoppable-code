'use client';

import type { JSX, ReactNode } from 'react';
import {
  LabsExperimentsSection,
  type LabsExperimentsSectionLayout,
} from '@canopy/ui-shared/components';
import {
  SETTINGS_CARD_ROW_CLASS,
  SettingsCard,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { useLabsSettingsPort } from './labs-settings-port';

function CardSection({
  title,
  description,
  dataTestId,
  children,
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly headingId?: string;
  readonly dataTestId?: string;
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <SettingsCard title={title} subtitle={description} testId={dataTestId}>
      {children}
    </SettingsCard>
  );
}

function CardGroup({
  children,
}: {
  readonly children?: ReactNode;
}): JSX.Element {
  return <div className="flex flex-col gap-3">{children}</div>;
}

function CardRow({
  label,
  description,
  control,
  dataTestId,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
  readonly htmlFor?: string;
  readonly dataTestId?: string;
}): JSX.Element {
  return (
    <div className={SETTINGS_CARD_ROW_CLASS} data-testid={dataTestId}>
      <div className="min-w-0">
        <p className="text-s font-medium fg-primary">{label}</p>
        {description != null && (
          <p className="text-s fg-secondary">{description}</p>
        )}
      </div>
      {control}
    </div>
  );
}

/** The account settings card kit, for hosts without their own layout. */
const CARD_LAYOUT: LabsExperimentsSectionLayout = {
  Section: CardSection,
  Group: CardGroup,
  Row: CardRow,
};

/**
 * Labs: one switch per experiment the host lists. Shared by desktop
 * Settings → Labs and web account Labs; the host supplies the rows and the
 * save path through `LabsSettingsPortProvider`.
 */
export function LabsSettingsSection(): JSX.Element | null {
  const port = useLabsSettingsPort();
  if (port === null) return null;
  return (
    <LabsExperimentsSection
      rows={port.rows}
      error={port.error}
      errorDetails={port.errorDetails}
      onToggle={port.onToggle}
      layout={port.layout ?? CARD_LAYOUT}
    />
  );
}
