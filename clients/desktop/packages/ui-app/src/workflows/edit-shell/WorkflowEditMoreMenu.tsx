'use client';

import type { JSX, ReactNode } from 'react';
import { DetailMoreMenu } from '@canopy/ui-shared/components';
import type {
  WorkflowEditActionState,
  WorkflowEditMenuActionId,
} from './workflow-edit-model';

export interface WorkflowEditMenuItem {
  readonly id: WorkflowEditMenuActionId;
  readonly label: string;
  readonly icon: ReactNode;
  readonly testId: string;
  readonly state: WorkflowEditActionState;
  readonly onSelect: () => void;
}

export interface WorkflowEditMoreMenuProps {
  /** The item's name, for the trigger's and menu's accessible names. */
  readonly name: string;
  /** Visible items in menu order. Delete sits below a divider. */
  readonly items: readonly WorkflowEditMenuItem[];
}

/**
 * The ⋯ menu that leads the edit shell's action bar: Turn on/off, Duplicate
 * and Delete, on the shared detail More menu.
 */
export function WorkflowEditMoreMenu({
  name,
  items,
}: WorkflowEditMoreMenuProps): JSX.Element | null {
  return (
    <DetailMoreMenu
      name={name}
      triggerTestId="workflow-edit-more"
      menuTestId="workflow-edit-menu"
      items={items.map((item) => ({
        id: item.id,
        label: item.label,
        icon: item.icon,
        testId: item.testId,
        onSelect: item.onSelect,
        disabled: item.state.disabled,
        reason: item.state.reason,
        destructive: item.id === 'delete',
      }))}
    />
  );
}
