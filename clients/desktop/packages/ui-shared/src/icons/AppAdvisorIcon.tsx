import type { JSX, SVGProps } from 'react';
import { AppAdvisorIcon as AppCatalogAppAdvisorIcon } from './AppIcons';

/**
 * Orchestrator icon (internally App Advisor) — the orbit glyph used in the
 * Orchestrator sidebar button, settings nav, and floating dialog header. Other
 * assistants keep the robot glyph through `AgentAssistantIcon`.
 */
export function AppAdvisorIcon(props: SVGProps<SVGSVGElement>): JSX.Element {
  return (
    <AppCatalogAppAdvisorIcon
      width="14"
      height="14"
      aria-hidden="true"
      {...props}
    />
  );
}
