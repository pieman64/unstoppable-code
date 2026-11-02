'use client';

import type { JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import { Button, SettingsRowsRow } from '@canopy/ui-shared/components';
import {
  requestScriptActionsReview,
  type ScriptActionsReviewSource,
} from '../review-requests';

export interface ScriptActionsReviewEntryProps {
  readonly projectId: string;
  /** The worktree whose scripts are reviewed; null when none is selected. */
  readonly worktreeId: string | null;
  readonly compact?: boolean;
  readonly source?: ScriptActionsReviewSource;
}

/**
 * The **Detected scripts** entry for a settings surface. Renders nothing
 * without `CanopyCapabilities.scriptActions`, so cloud chats never show it.
 */
export function ScriptActionsReviewEntry({
  projectId,
  worktreeId,
  source = 'settings',
  compact = false,
}: ScriptActionsReviewEntryProps): JSX.Element | null {
  const capabilities = useCapabilities();
  if (capabilities.scriptActions !== true) return null;
  if (compact)
    return (
      <Button
        size="compact"
        variant="secondary"
        disabled={worktreeId === null}
        data-testid="script-actions-review-entry-open"
        onClick={() => {
          if (worktreeId !== null)
            requestScriptActionsReview({ projectId, worktreeId, source });
        }}
      >
        Detected scripts
      </Button>
    );
  // One row of the settings list it sits in, never a box of its own.
  return (
    <SettingsRowsRow
      dataTestId="script-actions-review-entry"
      label="Detected scripts"
      description={
        worktreeId === null
          ? 'Open a worktree in this project to review the scripts found in it.'
          : 'Approve scripts found in this worktree and your shell aliases.'
      }
      control={
        <Button
          size="compact"
          variant="secondary"
          disabled={worktreeId === null}
          data-testid="script-actions-review-entry-open"
          onClick={(): void => {
            if (worktreeId !== null)
              requestScriptActionsReview({ projectId, worktreeId, source });
          }}
        >
          Review scripts
        </Button>
      }
    />
  );
}
