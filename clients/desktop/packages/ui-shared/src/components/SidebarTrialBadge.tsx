import type { JSX } from 'react';
import { Badge } from './Badge';

/**
 * The warning "Trial" badge beside a plan name, shared by the sidebar account
 * row's plan line and the desktop account menu header. A trial runs out, so it
 * takes the warning tone. Hidden from assistive tech: "Trial" only restates
 * the accessible plan label beside it.
 */
export function SidebarTrialBadge(): JSX.Element {
  return (
    <span aria-hidden="true" className="inline-flex">
      <Badge tone="warning" data-testid="sidebar-subscription-trial-pill">
        Trial
      </Badge>
    </span>
  );
}
