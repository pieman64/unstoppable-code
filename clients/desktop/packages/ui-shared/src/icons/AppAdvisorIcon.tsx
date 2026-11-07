import type { JSX } from 'react';
import {
  AppAdvisorIcon as AppCatalogAppAdvisorIcon,
  type AppIconProps,
} from './AppIcons';

/**
 * Orchestrator icon (internally App Advisor) — the orbit glyph used in the
 * Orchestrator sidebar button, settings nav, and floating dialog header. Other
 * assistants keep the robot glyph through `AgentAssistantIcon`.
 */
export function AppAdvisorIcon(props: AppIconProps): JSX.Element {
  return <AppCatalogAppAdvisorIcon size="sm" aria-hidden="true" {...props} />;
}
