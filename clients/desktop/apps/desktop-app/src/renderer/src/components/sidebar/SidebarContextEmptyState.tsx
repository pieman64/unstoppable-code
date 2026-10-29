import type { JSX } from 'react';
import { OrgContextEmptyState } from '@canopy/ui-app';
import { useSelectedOrgWithoutPlan } from '@/hooks/useSelectedOrgWithoutPlan';
import {
  askOwnerToChoosePlanCopy,
  CHOOSE_ORG_PLAN_COPY,
  CHOOSE_ORG_PLAN_LABEL,
  openOrganizationBillingPage,
  orgWithoutPlanTitle,
} from '@/lib/organizationPlan';

interface SidebarContextEmptyStateProps {
  organizationName: string;
  /** The selected organization; decides whether its missing plan applies. */
  organizationId?: string;
  /** The organization's Chats section is listed above (CAN-3537). */
  chatsListed?: boolean;
}

/**
 * The desktop host of the shared empty organization sidebar (CAN-3537): the
 * presentation is `OrgContextEmptyState` from `@canopy/ui-app`, the same one
 * the web portal renders. This adapter supplies the plan state and its action.
 * Adding a project is the Projects header's "+", and switching to Personal is
 * the footer context picker's job, not this row's (CAN-3550).
 */
export function SidebarContextEmptyState({
  organizationName,
  organizationId,
  chatsListed = false,
}: SidebarContextEmptyStateProps): JSX.Element {
  const withoutPlan = useSelectedOrgWithoutPlan();
  const planMissing =
    withoutPlan !== null && withoutPlan.organizationId === organizationId;
  return (
    <OrgContextEmptyState
      organizationName={organizationName}
      chatsListed={chatsListed}
      planMissing={
        planMissing
          ? {
              title: orgWithoutPlanTitle(organizationName),
              subtitle: withoutPlan.canChoosePlan
                ? CHOOSE_ORG_PLAN_COPY
                : askOwnerToChoosePlanCopy(organizationName),
              ...(withoutPlan.canChoosePlan
                ? {
                    choosePlan: {
                      label: CHOOSE_ORG_PLAN_LABEL,
                      onClick: (): void => {
                        openOrganizationBillingPage(withoutPlan.organizationId);
                      },
                    },
                  }
                : {}),
            }
          : undefined
      }
    />
  );
}
