'use client';

import { useId, useState, type JSX } from 'react';
import { InfoIcon } from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { ConfirmDialog } from './ConfirmDialog';
import { RichHoverTooltip } from './RichHoverTooltip';
import { ToggleSwitch } from './ToggleSwitch';

/** The row a worktree removal confirmation names. */
export interface WorktreeRemovalDialogIdentity {
  readonly workspaceName: string;
  readonly worktreeName: string;
  readonly worktreeId: string;
  readonly branchName: string;
}

export interface WorktreeRemovalDialogProps {
  /**
   * The action, a verb and noun (`Delete worktree`). The title repeats it as
   * a question naming the worktree: `Delete worktree “owl”?`.
   */
  readonly confirmLabel: string;
  /** Delete takes the destructive role; Archive keeps everything. */
  readonly destructive: boolean;
  readonly identity: WorktreeRemovalDialogIdentity;
  /**
   * Local work the removal takes with it. `insertions`/`deletions` are shown
   * when the diff has line changes; an empty object still names the work.
   */
  readonly localChanges?: {
    readonly insertions?: number;
    readonly deletions?: number;
  };
  /** One-line retention outcome, such as how long the archive is kept. */
  readonly retentionSummary: string;
  /** The full retention explanation, shown from the info button. */
  readonly retentionDetail: string;
  /**
   * Who suggested the branch handling, such as an App Advisor request. Shown
   * under the switch; the user still decides.
   */
  readonly branchChoiceHint?: string | null;
  /**
   * The branch handling an App Advisor request asked for. It presets the
   * switch; without one, the local branch is kept.
   */
  readonly requestedDeleteBranch?: boolean;
  /** Removal cannot run right now; the action is disabled. */
  readonly disabled: boolean;
  /** Suffix for the automation ids on a pinned row copy. */
  readonly testIdSuffix?: string;
  readonly onCancel: () => void;
  readonly onConfirm: (deleteBranch: boolean) => void;
}

/**
 * Worktree removal confirmation in the shared confirmation shape: the
 * question naming the worktree, what goes with it, one switch for the local
 * Git branch, then Cancel and the action.
 */
export function WorktreeRemovalDialog({
  confirmLabel,
  destructive,
  identity,
  localChanges,
  retentionSummary,
  retentionDetail,
  branchChoiceHint,
  requestedDeleteBranch,
  disabled,
  testIdSuffix = '',
  onCancel,
  onConfirm,
}: WorktreeRemovalDialogProps): JSX.Element {
  const [keepBranch, setKeepBranch] = useState(requestedDeleteBranch !== true);
  // A replacement request (another worktree, the other mode, or a different
  // requested branch handling) presets the switch again instead of keeping
  // the choice made for the previous request.
  const requestKey = `${identity.worktreeId}|${String(destructive)}|${String(requestedDeleteBranch)}`;
  const [presetFor, setPresetFor] = useState(requestKey);
  if (presetFor !== requestKey) {
    setPresetFor(requestKey);
    setKeepBranch(requestedDeleteBranch !== true);
  }
  const switchLabelId = useId();
  const switchNoteId = useId();
  const automationId = (base: string): string => `${base}${testIdSuffix}`;
  const hasLineStats =
    localChanges !== undefined &&
    (localChanges.insertions ?? 0) + (localChanges.deletions ?? 0) > 0;
  return (
    // The dialog portals to <body>, but React still bubbles its clicks to the
    // row that opened it; stop them here so a backdrop click cannot also
    // select or open that row.
    <div className="contents" onClick={(event) => event.stopPropagation()}>
      <ConfirmDialog
        // User-authored names are masked in session replay.
        title={
          <>
            {confirmLabel} “
            <span className={REPLAY_MASK_CLASS}>{identity.worktreeName}</span>”?
          </>
        }
        message={
          <p data-testid={automationId('worktree-removal-summary')}>
            {localChanges && (
              <>
                Its local changes
                {hasLineStats && (
                  <>
                    {' ('}
                    <span className="tabular-nums">
                      <span className="fg-success">
                        +{localChanges.insertions ?? 0}
                      </span>{' '}
                      <span className="fg-destructive">
                        −{localChanges.deletions ?? 0}
                      </span>
                    </span>
                    {')'}
                  </>
                )}{' '}
                go with it.{' '}
              </>
            )}
            {retentionSummary}
            <RichHoverTooltip
              content={
                <span className="block text-xs leading-snug fg-primary">
                  {retentionDetail}
                </span>
              }
              surfaceClassName="w-72"
              dataTestId={automationId('worktree-removal-retention-detail')}
              triggerWrapperClassName="ml-1 align-middle"
            >
              <button
                type="button"
                aria-label="About restoring this worktree"
                data-testid={automationId('worktree-removal-retention-info')}
                className="focus-ring inline-flex rounded-full fg-tertiary hover:fg-primary"
              >
                <InfoIcon size={14} aria-hidden="true" />
              </button>
            </RichHoverTooltip>
          </p>
        }
        confirmLabel={confirmLabel}
        destructive={destructive}
        onConfirm={(): void => {
          if (disabled) return;
          onConfirm(!keepBranch);
        }}
        onCancel={onCancel}
        dataTestId={automationId('worktree-removal-dialog')}
        cancelTestId={automationId('worktree-removal-cancel')}
        // The action names what it will do with the branch, so automation that
        // asks for one outcome finds the button only while the switch says so.
        confirmTestId={automationId(
          keepBranch
            ? 'worktree-removal-preserve-branch'
            : 'worktree-removal-delete-branch',
        )}
        confirmDisabled={disabled}
      >
        <div className="flex items-center gap-3 rounded-xl bg-subtle py-2 pl-3 pr-2.5">
          <div className="min-w-0 flex-1">
            <div id={switchLabelId} className="text-s fg-primary">
              Keep the local branch
            </div>
            <div
              id={switchNoteId}
              className="truncate text-xs fg-tertiary"
              data-testid={automationId('worktree-removal-target-identity')}
            >
              {identity.branchName}
              {keepBranch ? ' stays in ' : ' is deleted from '}
              <span className={REPLAY_MASK_CLASS}>
                {identity.workspaceName}
              </span>
              .{branchChoiceHint ? ` ${branchChoiceHint}` : ''}
            </div>
          </div>
          <ToggleSwitch
            checked={keepBranch}
            label="Keep the local branch"
            describedBy={switchNoteId}
            onChange={setKeepBranch}
            dataTestId={automationId('worktree-removal-keep-branch')}
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
