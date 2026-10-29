'use client';

// ---------------------------------------------------------------------------
// The empty organization sidebar (CAN-2954, CAN-3386), rendered by both the
// desktop sidebar and the web portal's (CAN-3537).
//
// An empty Projects list is one `None found` row under the Projects header,
// the same row an empty Chats section lists (CAN-3550). The sidebar lists only
// set-up projects, so an empty list does not mean the organization has none:
// the Projects header's "+" stays on screen while the list is empty and opens
// the host's Add project dialog. Hosts supply what only they know: whether the
// organization lacks a plan, and the copy and action for it.
// ---------------------------------------------------------------------------

import type { JSX } from 'react';
import { Button, EmptyState } from '@canopy/ui-shared';
import { SidebarNoneFoundRow } from '../code/shell/sidebar';

export interface OrgContextEmptyStatePlanMissing {
  readonly title: string;
  readonly subtitle: string;
  /** Offered only to someone who can choose a plan (an owner). */
  readonly choosePlan?: {
    readonly label: string;
    readonly onClick: () => void;
  };
}

export interface OrgContextEmptyStateProps {
  readonly organizationName: string;
  /**
   * Organization projects and Chats need an active plan, so an organization
   * without one is not "empty yet": the host says why and lets an owner fix it.
   */
  readonly planMissing?: OrgContextEmptyStatePlanMissing;
  /**
   * The organization's Chats section is listed above. The empty Projects row
   * shows either way; only the missing-plan explanation stays out of the way
   * of a listed Chats (CAN-3537).
   */
  readonly chatsListed?: boolean;
}

export function OrgContextEmptyState({
  planMissing,
  chatsListed = false,
}: OrgContextEmptyStateProps): JSX.Element {
  if (planMissing === undefined) {
    return (
      <div data-testid="sidebar-context-empty-state">
        <SidebarNoneFoundRow labelTestId="sidebar-context-empty-state-label" />
      </div>
    );
  }
  if (chatsListed) return <></>;
  return (
    <div data-testid="sidebar-context-empty-state">
      <EmptyState
        title={planMissing.title}
        subtitle={planMissing.subtitle}
        action={
          planMissing.choosePlan === undefined ? undefined : (
            <Button
              size="sm"
              variant="primary"
              data-testid="sidebar-context-empty-state-choose-plan"
              onClick={planMissing.choosePlan.onClick}
            >
              {planMissing.choosePlan.label}
            </Button>
          )
        }
      />
    </div>
  );
}
