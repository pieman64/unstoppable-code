import type { JSX, SVGProps } from 'react';
import { AgentAssistantIcon as AppCatalogAgentAssistantIcon } from './AppIcons';

/**
 * Generic assistant icon — the robot glyph used for assistants other than
 * Orchestrator, such as Pipeline Advisor and the Ledger sidecar. Orchestrator
 * uses {@link AppAdvisorIcon} (the orbit) instead.
 */
export function AgentAssistantIcon(
  props: SVGProps<SVGSVGElement>,
): JSX.Element {
  return (
    <AppCatalogAgentAssistantIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
