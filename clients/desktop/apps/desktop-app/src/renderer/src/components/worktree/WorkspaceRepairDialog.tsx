import { Button } from '@canopy/ui-shared/components';
import { useState, type JSX } from 'react';
import type { WorkspaceWorktreeRepairIssue } from '@canopy/desktop-shared/types';
import { DialogModal } from '../shared';
import { workspaceHealthIssueClassName } from './workspace-health-styles';

interface WorkspaceRepairDialogProps {
  workspaceName: string;
  worktreeId: string;
  branchName: string;
  issues: WorkspaceWorktreeRepairIssue[];
  isPending: boolean;
  onRepair: (restoreClaudeMd: boolean) => void;
  onCancel: () => void;
}

export function WorkspaceRepairDialog({
  workspaceName,
  worktreeId,
  branchName,
  issues,
  isPending,
  onRepair,
  onCancel,
}: WorkspaceRepairDialogProps): JSX.Element {
  const [restoreClaudeMd, setRestoreClaudeMd] = useState(true);

  return (
    <DialogModal
      onClose={onCancel}
      title="Repair project worktree"
      subtitle={workspaceName}
      titleId="workspace-repair-dialog-title"
      maxWidth="lg"
    >
      <div className="flex flex-col gap-4 p-5 pt-3 text-s fg-primary">
        <div className="rounded-lg border bg-secondary/20 p-3 text-xs fg-secondary">
          <div>
            Worktree{' '}
            <span className="font-medium fg-primary">{worktreeId}</span>
          </div>
          <div className="mt-1">
            Branch <span className="font-medium fg-primary">{branchName}</span>
          </div>
        </div>

        <div className="space-y-2">
          {issues.map((issue) => (
            <div
              key={issue.code}
              className={`rounded-lg border px-3 py-2 text-xs ${workspaceHealthIssueClassName(issue.blocking)}`}
            >
              <div className="font-medium">
                {issue.blocking ? 'Blocking issue' : 'Warning'}
              </div>
              <div className="mt-1">{issue.message}</div>
            </div>
          ))}
        </div>

        <label className="flex items-start gap-2 text-xs fg-secondary">
          <input
            type="checkbox"
            checked={restoreClaudeMd}
            onChange={(event) => setRestoreClaudeMd(event.target.checked)}
            className="mt-0.5"
          />
          <span>
            Restore project instructions from the project source repo while
            repairing.
          </span>
        </label>

        <div className="flex items-center justify-end gap-2">
          <Button size="compact" onClick={onCancel} disabled={isPending}>
            Cancel and clean up
          </Button>
          <Button
            variant="primary"
            size="compact"
            onClick={() => onRepair(restoreClaudeMd)}
            disabled={isPending}
          >
            {isPending ? 'Repairing…' : 'Repair worktree'}
          </Button>
        </div>
      </div>
    </DialogModal>
  );
}
