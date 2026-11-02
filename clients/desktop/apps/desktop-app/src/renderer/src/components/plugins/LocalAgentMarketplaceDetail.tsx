import type { JSX, ReactNode } from 'react';
import type { AgentModelDefinition } from '@canopy/desktop-shared/types/agent-models';
import { getAgentModelAvailability } from '@canopy/desktop-shared/types';
import {
  AgentDefinitionSummary,
  DetailPageActions,
  ExecutionActionButton,
} from '@canopy/ui-shared/components';
import { MarketplaceEntityHeader } from '@canopy/ui-app/capability';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { McpServerLogo } from '@/components/shared/McpServerLogo';
import { formatDateOrEmpty } from '@/lib/format';
import {
  agentBaseModelLabel,
  agentPluginLabels,
} from '@/lib/marketplaceAgents';

export interface LocalAgentMarketplaceDetailProps {
  agent: AgentModelDefinition;
  onEdit: () => void;
  /**
   * While the agent list is loading or its last read failed, the cached
   * definition may be older than the agent, so Edit waits for a fresh one.
   */
  editDisabled?: boolean;
  /** The list's load failure and its Try again, above the detail. */
  notice?: ReactNode;
  onDelete: () => void;
}

function DetailFact({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-3 text-s">
      <dt className="w-28 shrink-0 fg-secondary">{label}</dt>
      <dd className="min-w-0 fg-primary">{children}</dd>
    </div>
  );
}

/**
 * A local agent in the Marketplace (CAN-4266): what it runs and selects, with
 * Edit and Delete beside the shell's Share. The dialogs stay host-mounted.
 */
export function LocalAgentMarketplaceDetail({
  agent,
  onEdit,
  onDelete,
  editDisabled = false,
  notice,
}: LocalAgentMarketplaceDetailProps): JSX.Element {
  const available = getAgentModelAvailability(agent.id).available;
  return (
    <div className="space-y-6" data-testid="local-agent-marketplace-detail">
      <DetailPageActions
        secondary={
          <ExecutionActionButton
            placement="detail"
            label="Delete"
            ariaLabel={`Delete ${agent.name}`}
            onClick={onDelete}
            dataTestId="local-agent-detail-delete"
            stopKeyDownPropagation={false}
          />
        }
        primary={
          <ExecutionActionButton
            placement="detail"
            label="Edit"
            ariaLabel={`Edit ${agent.name}`}
            variant="primary"
            onClick={onEdit}
            disabled={editDisabled}
            dataTestId="local-agent-detail-edit"
            stopKeyDownPropagation={false}
          />
        }
      />
      {notice}
      <MarketplaceEntityHeader
        name={agent.name}
        McpServerLogoComponent={McpServerLogo}
        meta={
          <span data-testid="local-agent-detail-availability">
            {available ? 'Installed' : 'Unavailable'}
          </span>
        }
      />

      <dl className="space-y-2">
        <DetailFact label="Base model">{agentBaseModelLabel(agent)}</DetailFact>
        <DetailFact label="Model ID">
          <span className="font-mono text-xs">{agent.id}</span>
        </DetailFact>
        <DetailFact label="Updated">
          {formatDateOrEmpty(agent.updatedAt) || '—'}
        </DetailFact>
      </dl>

      {/* Instructions are prompt content, not a label. */}
      <div className={POSTHOG_REPLAY_BLOCK_CLASS}>
        <AgentDefinitionSummary
          instructions={agent.instructions}
          plugins={agentPluginLabels(agent)}
        />
      </div>
    </div>
  );
}
