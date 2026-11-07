import type { JSX } from 'react';
import {
  AgentAssistantIcon as AppCatalogAgentAssistantIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Generic assistant icon — the robot glyph used for assistants other than
 * Orchestrator, such as Pipeline Advisor and the Ledger sidecar. Orchestrator
 * uses {@link AppAdvisorIcon} (the orbit) instead.
 */
export function AgentAssistantIcon(props: AppIconProps): JSX.Element {
  return (
    <AppCatalogAgentAssistantIcon size="sm" aria-hidden="true" {...props} />
  );
}
