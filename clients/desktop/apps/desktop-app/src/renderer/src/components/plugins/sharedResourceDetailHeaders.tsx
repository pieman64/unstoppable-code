import type { ReactNode } from 'react';
import type { SharedAgentSummary } from '@canopy/desktop-shared/types/agent-models';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import { getModelDisplayName } from '@canopy/desktop-shared/types';
import { describeAgentBaseModel } from '@canopy/protocol/agents';
import { ShareAudienceLabel } from '@canopy/ui-shared/components';
import type { MarketplaceDetailPageHeader } from '@canopy/ui-app/capability';
import { existingShareAudienceLabel } from '@canopy/ui-app/sharing';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

/**
 * The page-shell item headers (CAN-4266) for the kinds a recipient reaches
 * only through a share: what each is, who shared it and with whom. The
 * bodies are in `SharedResourceMarketplaceDetail`.
 */

type ShareAudience = ReturnType<typeof existingShareAudienceLabel>;

/** "By <author>" and the audience, as the header's quiet meta facts. */
function sharedByMeta(
  author: string | null,
  audience: ShareAudience,
  testId: string,
): ReactNode[] {
  return [
    author ? (
      <span key="author">
        {/* The author is a person: replay records a box for the name. */}
        By <span className={POSTHOG_REPLAY_BLOCK_CLASS}>{author}</span>
      </span>
    ) : null,
    audience ? (
      <ShareAudienceLabel
        key="audience"
        audience={audience.audience}
        teamName={audience.teamName}
        personal={audience.personal}
        dataTestId={testId}
      />
    ) : null,
  ];
}

/** A shared agent's header: its model, author and audience. */
export function sharedAgentDetailHeader(
  agent: SharedAgentSummary,
  personalOrganizationId: string | null,
): MarketplaceDetailPageHeader {
  return {
    description: `Agent using ${describeAgentBaseModel(agent.baseModel, getModelDisplayName)}`,
    meta: sharedByMeta(
      agent.createdBy.name,
      existingShareAudienceLabel(agent, personalOrganizationId),
      'shared-agent-detail-audience',
    ),
  };
}

/** A shared project template's header: its description, author, audience. */
export function sharedBlueprintDetailHeader(
  blueprint: WorkspaceTemplateShareSummary,
  personalOrganizationId: string | null,
): MarketplaceDetailPageHeader {
  return {
    ...(blueprint.description ? { description: blueprint.description } : {}),
    meta: sharedByMeta(
      blueprint.createdBy.name,
      {
        audience:
          blueprint.audience === 'TEAM'
            ? 'team'
            : blueprint.audience === 'ORGANIZATION'
              ? 'organization'
              : 'public',
        personal:
          blueprint.audience === 'ORGANIZATION' &&
          blueprint.owner.type === 'organization' &&
          blueprint.owner.id === personalOrganizationId,
        ...(blueprint.audience === 'TEAM'
          ? {
              teamName:
                blueprint.owner.type === 'team'
                  ? (blueprint.owner.name ?? undefined)
                  : undefined,
            }
          : {}),
      },
      'shared-blueprint-detail-audience',
    ),
  };
}

/** A shared plugin's header: its description, author and audience. */
export function sharedPluginDetailHeader(
  plugin: SharedPluginSummary,
  personalOrganizationId: string | null,
): MarketplaceDetailPageHeader {
  return {
    ...(plugin.description ? { description: plugin.description } : {}),
    meta: sharedByMeta(
      plugin.createdBy.name,
      existingShareAudienceLabel(plugin, personalOrganizationId),
      'shared-plugin-detail-audience',
    ),
  };
}
