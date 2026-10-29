import type { PortalWorktreeSummaryEntity } from '@canopy/protocol/portal';
import type { SummarySectionBodyProps } from './SummarySectionBody';

/**
 * Maps the lenient portal projection onto the shared summary card.
 */
export function portalSummaryToSectionBodyProps(
  entity: PortalWorktreeSummaryEntity | undefined,
): SummarySectionBodyProps {
  return {
    summary: entity
      ? {
          title: entity.title,
          description: entity.description,
          highlights: entity.highlights,
          repos: entity.repos,
          generatedAt: entity.generatedAt,
          lastFullRefreshAt: entity.lastFullRefreshAt,
        }
      : undefined,
    generating: entity?.generating === true,
    refreshEnabled: false,
  };
}
