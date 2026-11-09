import type { JSX, ReactNode } from 'react';
import {
  Stack,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSection,
  SettingsRowsValue,
} from '@canopy/ui-shared/components';
import type { AgentModelDefinition } from '@canopy/execution-engine/types/agent-models';
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
    <Stack gap="section" data-testid="local-agent-marketplace-detail">
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

      <SettingsRowsSection title="Details">
        <SettingsRowsGroup>
          <SettingsRowsRow
            fact
            label="Base model"
            control={
              <SettingsRowsValue>
                {agentBaseModelLabel(agent)}
              </SettingsRowsValue>
            }
          />
          <SettingsRowsRow
            fact
            label="Model ID"
            control={
              <SettingsRowsValue>
                <span className="font-mono text-xs">{agent.id}</span>
              </SettingsRowsValue>
            }
          />
          <SettingsRowsRow
            fact
            label="Updated"
            control={
              <SettingsRowsValue>
                {formatDateOrEmpty(agent.updatedAt) || '—'}
              </SettingsRowsValue>
            }
          />
        </SettingsRowsGroup>
      </SettingsRowsSection>

      {/* Instructions are prompt content, not a label. */}
      <div className={POSTHOG_REPLAY_BLOCK_CLASS}>
        <AgentDefinitionSummary
          instructions={agent.instructions}
          plugins={agentPluginLabels(agent)}
        />
      </div>
    </Stack>
  );
}
