import type { JSX } from 'react';
import type { UnifiedEntryKind } from '@canopy/protocol/unified-entry';
import {
  AgentIcon,
  AutomationsIcon,
  BundleIcon,
  McpServerIcon,
  PipelineIcon,
  PluginsIcon,
  SingleRepoWorkspaceIcon,
  SkillIcon,
} from '../icons/AppIcons';
import { UnstoppableDomainsIcon } from '../icons/UnstoppableDomainsIcon';
import { Tooltip } from './Tooltip';

interface MarketplaceTypeLabelProps {
  readonly kind: UnifiedEntryKind;
  readonly label: string;
  readonly dataTestId?: string;
}

function MarketplaceTypeIcon({
  kind,
}: {
  kind: UnifiedEntryKind;
}): JSX.Element {
  const props = { size: 12, exactSize: true, ariaHidden: true };
  switch (kind) {
    case 'plugin':
      return <PluginsIcon {...props} />;
    case 'app':
      return <McpServerIcon {...props} />;
    case 'skill':
      return <SkillIcon {...props} />;
    case 'pipeline':
      return <PipelineIcon {...props} />;
    case 'automation':
      return <AutomationsIcon {...props} />;
    case 'collection':
      return <BundleIcon {...props} />;
    case 'agent':
      return <AgentIcon {...props} />;
    case 'blueprint':
      return <SingleRepoWorkspaceIcon {...props} />;
  }
}

/** A quiet icon-and-text label for a Customize resource kind. */
export function MarketplaceTypeLabel({
  kind,
  label,
  dataTestId,
}: MarketplaceTypeLabelProps): JSX.Element {
  return (
    <span
      data-testid={dataTestId}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs fg-tertiary"
    >
      <MarketplaceTypeIcon kind={kind} />
      <span>{label}</span>
    </span>
  );
}

export const CURATED_SOURCE_TOOLTIP = 'Curated by Unstoppable Domains';

interface CuratedSourceLabelProps {
  readonly entryId: string;
  readonly dataTestId: string;
}

/** The quiet Curated source label and its attributed brand mark. */
export function CuratedSourceLabel({
  entryId,
  dataTestId,
}: CuratedSourceLabelProps): JSX.Element {
  return (
    <span
      data-testid={dataTestId}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs"
    >
      <Tooltip label={CURATED_SOURCE_TOOLTIP}>
        <span
          data-testid={`plugins-card-curated-mark-${entryId}`}
          role="img"
          aria-label="Curated by Unstoppable Domains"
          className="inline-flex shrink-0 fg-primary"
        >
          <UnstoppableDomainsIcon size={12} tone="mono" />
        </span>
      </Tooltip>
      <span className="fg-tertiary">Curated</span>
    </span>
  );
}
