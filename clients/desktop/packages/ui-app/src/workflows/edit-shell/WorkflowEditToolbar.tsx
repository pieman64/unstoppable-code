'use client';

import type { JSX, Ref } from 'react';
import { CustomizeBreadcrumbs } from '@canopy/ui-shared/components';

export interface WorkflowEditToolbarProps {
  /** Where the first crumb goes, e.g. `Workflows`. */
  readonly backLabel: string;
  /** Leaves for the place `backLabel` names. */
  readonly onLeave: () => void;
  /** The workflow's name, or `New workflow` for a draft. */
  readonly title: string;
  /** `title` is user-authored: masked in session replay. */
  readonly privateTitle?: boolean;
  /**
   * Where the edit shell puts its actions (Run, Share, Save and the ⋯
   * menu), so they sit in this bar.
   */
  readonly actionsRef: Ref<HTMLDivElement>;
}

/**
 * The bar across the top of a workflow's edit view (CAN-4319), in the top
 * bar row other pages use: where the person is, `Workflows › Daily
 * standup`, with the way back in its first crumb, and the workflow's
 * actions. It spans the assistant and the editor below it.
 *
 * The bar sits in the window's drag band on desktop: the crumb and the
 * actions opt out of it, and the rest still drags the window.
 */
export function WorkflowEditToolbar({
  backLabel,
  onLeave,
  title,
  privateTitle = false,
  actionsRef,
}: WorkflowEditToolbarProps): JSX.Element {
  return (
    <div
      className="electron-drag flex min-h-11.5 shrink-0 items-center justify-between gap-3 px-3 py-2"
      data-testid="workflow-edit-toolbar"
    >
      <div className="electron-no-drag flex min-w-0">
        <CustomizeBreadcrumbs
          testId="workflow-edit-breadcrumb"
          items={[
            {
              key: 'back',
              label: backLabel,
              onSelect: onLeave,
              testId: 'workflow-edit-toolbar-back',
            },
            {
              key: 'current',
              label: title,
              title,
              privateLabel: privateTitle,
              shrink: true,
              testId: 'workflow-edit-toolbar-title',
            },
          ]}
        />
      </div>
      <div
        ref={actionsRef}
        className="electron-no-drag flex shrink-0 items-center"
        data-testid="workflow-edit-toolbar-actions"
      />
    </div>
  );
}
