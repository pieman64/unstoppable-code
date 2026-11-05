import { Fragment, type JSX } from 'react';
import type { UnifiedEntryAlternative } from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';

interface PluginAlternativesProps {
  alternatives?: readonly UnifiedEntryAlternative[];
  onOpenEntryId?: (entryId: string) => void;
  /** `plugin-detail-also-available` or a surface-specific prefix. */
  testIdPrefix: string;
}

/**
 * "Also available from …" on a plugin page: the same app published by other
 * catalogs, each a link to that copy's page (CAN-3653). Nothing without
 * alternatives.
 */
export function PluginAlternatives({
  alternatives,
  onOpenEntryId,
  testIdPrefix,
}: PluginAlternativesProps): JSX.Element | null {
  if (!alternatives || alternatives.length === 0) return null;
  return (
    <p data-testid={testIdPrefix} className="mt-2 text-xs fg-secondary">
      Also available from{' '}
      {alternatives.map((alternative, index) => (
        <Fragment key={alternative.entryId}>
          {index > 0 && ', '}
          <Button
            variant="link"
            data-testid={`${testIdPrefix}-${alternative.entryId}`}
            disabled={onOpenEntryId === undefined}
            onClick={() => onOpenEntryId?.(alternative.entryId)}
          >
            {alternative.label}
          </Button>
        </Fragment>
      ))}
    </p>
  );
}
