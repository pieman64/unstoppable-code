import type { JSX, SVGProps } from 'react';
import { AppAdvisorIcon as AppCatalogAppAdvisorIcon } from './AppIcons';

/**
 * App Advisor icon — robot-style glyph used in the App Advisor sidebar
 * button, settings nav, and floating dialog header. Previously exported as
 * `AgentAssistantIcon`; the legacy name remains as a re-export alias for
 * compatibility with downstream code.
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
