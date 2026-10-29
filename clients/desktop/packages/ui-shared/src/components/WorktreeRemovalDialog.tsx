'use client';

import { useRef, type JSX, type ReactNode } from 'react';
import { InfoIcon } from '../icons/AppIcons';
import { Button } from './Button';
import { DialogModal } from './DialogModal';
import { RichHoverTooltip } from './RichHoverTooltip';

/** The row a worktree removal confirmation names. */
export interface WorktreeRemovalDialogIdentity {
  readonly workspaceName: string;
  readonly worktreeName: string;
  readonly worktreeId: string;
  readonly branchName: string;
}

export interface WorktreeRemovalDialogProps {
  /** `Delete worktree?` or `Archive worktree?`. */
  readonly title: string;
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
  /** Branch-handling hint under the summary. */
  readonly branchChoiceHint: string;
  /**
   * The branch handling an App Advisor request asked for. Its button carries
   * `data-requested`; the hint names it and the user still decides.
   */
  readonly requestedDeleteBranch?: boolean;
  /** Removal cannot run right now; both removal actions are disabled. */
  readonly disabled: boolean;
  /** Suffix for the automation ids on a pinned row copy. */
  readonly testIdSuffix?: string;
  readonly onCancel: () => void;
  readonly onConfirm: (deleteBranch: boolean) => void;
}

function IdentityRow({
  term,
  children,
}: {
  term: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <>
      <dt className="fg-tertiary">{term}</dt>
      <dd className="min-w-0 truncate fg-primary">{children}</dd>
    </>
  );
}

/**
 * Worktree removal confirmation: the row being removed, what happens to its
 * work, and three actions. Preserve local and Delete local both remove the
 * worktree; they differ only in whether its local Git branch is kept.
 */
export function WorktreeRemovalDialog({
  title,
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
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = `worktree-removal-title-${identity.worktreeId}${testIdSuffix}`;
  const automationId = (base: string): string => `${base}${testIdSuffix}`;
  const confirm = (deleteBranch: boolean): void => {
    if (disabled) return;
    onConfirm(deleteBranch);
  };
  const hasLineStats =
    localChanges !== undefined &&
    (localChanges.insertions ?? 0) + (localChanges.deletions ?? 0) > 0;
  return (
    // The dialog portals to <body>, but React still bubbles its clicks to the
    // row that opened it; stop them here so a backdrop click cannot also
    // select or open that row.
    <div className="contents" onClick={(event) => event.stopPropagation()}>
      <DialogModal
        title={title}
        titleId={titleId}
        maxWidth="md"
        headerBorder={false}
        headerSpacing="tight"
        showCloseButton={false}
        scrollableBody={false}
        trapFocus
        initialFocusRef={cancelRef}
        onClose={onCancel}
      >
        <div className="flex flex-col gap-4 px-5 pb-5 pt-1">
          <dl
            className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-s"
            data-testid={automationId('worktree-removal-target-identity')}
          >
            <IdentityRow term="Worktree">
              {identity.worktreeName}{' '}
              <span className="fg-tertiary">{identity.worktreeId}</span>
            </IdentityRow>
            <IdentityRow term="Branch">{identity.branchName}</IdentityRow>
            <IdentityRow term="Project">{identity.workspaceName}</IdentityRow>
          </dl>
          <div className="flex flex-col gap-1 text-s">
            <p
              className="fg-secondary"
              data-testid={automationId('worktree-removal-summary')}
            >
              {localChanges && (
                <>
                  <span className="fg-primary">Has local changes</span>
                  {hasLineStats && (
                    <>
                      {' '}
                      <span className="font-medium tabular-nums">
                        <span className="fg-success">
                          +{localChanges.insertions ?? 0}
                        </span>{' '}
                        <span className="fg-destructive">
                          -{localChanges.deletions ?? 0}
                        </span>
                      </span>
                    </>
                  )}
                  .{' '}
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
            <p className="fg-tertiary">{branchChoiceHint}</p>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              ref={cancelRef}
              variant="ghost"
              size="lg"
              onClick={onCancel}
              data-testid={automationId('worktree-removal-cancel')}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="ml-auto"
              disabled={disabled}
              data-requested={
                requestedDeleteBranch === false ? 'true' : undefined
              }
              data-testid={automationId('worktree-removal-preserve-branch')}
              onClick={(): void => confirm(false)}
            >
              Preserve local
            </Button>
            {/* Both actions delete the worktree; this one also deletes the
                local branch, so it carries the destructive role rather than the
                accent (DESIGN.md: never style a destructive action with the
                accent role). Preserve local stays the quieter alternative. */}
            <Button
              variant="destructive"
              size="lg"
              disabled={disabled}
              data-requested={
                requestedDeleteBranch === true ? 'true' : undefined
              }
              data-testid={automationId('worktree-removal-delete-branch')}
              onClick={(): void => confirm(true)}
            >
              Delete local
            </Button>
          </div>
        </div>
      </DialogModal>
    </div>
  );
}
