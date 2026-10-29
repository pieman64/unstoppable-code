import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  RepoBranchInfo,
  WorkspaceRepoData,
  WorktreeData,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import type { PipelineInfo } from '@canopy/desktop-shared/types/pipeline';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useClipboardCopy } from '@/hooks/useClipboardCopy';
import { BaseBranchDropdown } from './BaseBranchDropdown';
import { BranchPicker } from './BranchPicker';
import { LabelField } from './LabelField';
import { resolveDisplayedBaseBranch } from './branch-options';
import { refreshWorktreeActivity } from './refresh-worktree-activity';
import { CopyButton } from '../shared/CopyButton';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { CodeGraphSummaryPanel } from './CodeGraphSummaryPanel';
import { GraphIcon } from '@canopy/ui-shared/icons';
import {
  PencilIcon as AppCatalogPencilIcon,
  ChevronDownMediumIcon as AppCatalogChevronDownMediumIcon,
  CheckIcon as AppCatalogCheckIcon,
  Copy as AppCatalogCopy,
  CloseIcon as AppCatalogCloseIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { useCodeGraphExperimentEnabled } from '@/hooks/useCodeGraphExperimentEnabled';
import { useCodeGraphBuildStore } from '@/stores/codeGraphBuildStore';
import { Tooltip } from '@canopy/ui-shared';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';
import { LoadingIndicator } from '@canopy/ui-shared/components';
import { RichHoverTooltip } from '@/components/shared/RichHoverTooltip';

type BranchInfoTab = 'details' | 'pipelines' | 'code-graph';
type WorktreeDirectoryStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Renders the per-repo provenance badge (`local` / `remote`) when the base
 * branch only resolves on one side.
 */
function getBaseBranchProvenance(params: {
  existsLocally: boolean | undefined;
  existsInRemote: boolean | undefined;
}): { label: 'local' | 'remote'; className: string } | null {
  const { existsLocally, existsInRemote } = params;
  if (existsLocally === true && existsInRemote === false) {
    return { label: 'local', className: 'fg-warning' };
  }
  if (existsLocally === false && existsInRemote === true) {
    return { label: 'remote', className: 'fg-success' };
  }
  return null;
}

/**
 * Multi-repo equivalent — only returns a label when every repo whose
 * base branch matches `sharedBaseBranch` agrees on the provenance side.
 */
function getSharedBaseBranchProvenance(
  repoBranches: RepoBranchInfo[] | undefined,
  sharedBaseBranch: string | null,
): { label: 'local' | 'remote'; className: string } | null {
  if (!repoBranches || !sharedBaseBranch) {
    return null;
  }
  const matchingBaseBranches = repoBranches.filter(
    (repoBranch) => repoBranch.baseBranch === sharedBaseBranch,
  );
  if (matchingBaseBranches.length === 0) {
    return null;
  }
  const allLocalOnly = matchingBaseBranches.every(
    (repoBranch) =>
      repoBranch.baseBranchExistsLocally === true &&
      repoBranch.baseBranchExistsInRemote === false,
  );
  if (allLocalOnly) {
    return { label: 'local', className: 'fg-warning' };
  }
  const allRemoteOnly = matchingBaseBranches.every(
    (repoBranch) =>
      repoBranch.baseBranchExistsLocally === false &&
      repoBranch.baseBranchExistsInRemote === true,
  );
  if (allRemoteOnly) {
    return { label: 'remote', className: 'fg-success' };
  }
  return null;
}

interface WorktreeHealthAlertProps {
  issue: WorktreeHealthIssue;
  retrying: boolean;
  retryError: string | null;
  onRetry: () => void;
}

function WorktreeHealthAlert({
  issue,
  retrying,
  retryError,
  onRetry,
}: WorktreeHealthAlertProps): JSX.Element {
  const hasDetail = Boolean(issue.gitError) || Boolean(retryError);
  return (
    <Notice
      intent="attention"
      className="mb-2"
      title="Health check warning"
      {...(hasDetail
        ? {
            detail: (
              <>
                {issue.gitError && (
                  <p
                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words font-mono`}
                  >
                    {issue.gitError}
                  </p>
                )}
                {retryError && (
                  <p
                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words`}
                  >
                    {retryError}
                  </p>
                )}
              </>
            ),
          }
        : {})}
      // The status chip rides in the trailing slot beside the action: the
      // title is inline text now, so a flex row inside it would break the
      // line.
      actions={
        <>
          <span className="rounded bg-warning-subtle px-1.5 py-0.5 text-xs font-medium fg-primary">
            Broken
          </span>
          <NoticeButton variant="primary" onClick={onRetry} disabled={retrying}>
            {retrying && <LoadingSpinner />}
            <span>{retrying ? 'Retrying' : 'Retry health check'}</span>
          </NoticeButton>
        </>
      }
    >
      {issue.message}
    </Notice>
  );
}

function formatHealthRetryError(
  issue: WorktreeHealthIssue | undefined,
): string {
  const issueMessage = issue?.message.trim() ?? '';
  const gitError = issue?.gitError?.trim() ?? '';
  if (!issueMessage) {
    return 'Still broken after retry.';
  }
  if (gitError && gitError !== issueMessage) {
    return `${issueMessage} (${gitError})`;
  }
  return issueMessage;
}

function ProjectPipelineList({
  pipelines,
  loading,
  onView,
}: {
  pipelines: PipelineInfo[];
  loading: boolean;
  onView: (pipeline: PipelineInfo) => void;
}): JSX.Element {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-s fg-secondary">
        <LoadingSpinner />
        <span className="ml-2">Loading pipelines…</span>
      </div>
    );
  }

  if (pipelines.length === 0) {
    return (
      <p className="py-6 text-center text-xs fg-secondary">
        No project pipelines found.
        <br />
        <span className="mt-1 inline-block text-3xs">
          Add YAML files to <code>.canopy/pipelines/</code> in your repo.
        </span>
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {pipelines.map((p) => (
        <div
          key={p.id}
          className="flex items-center gap-3 rounded-lg border px-3 py-2"
        >
          <span className="shrink-0 text-m">{p.icon || '⚡'}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-s font-medium fg-primary">
              {p.name}
            </div>
            {p.description && (
              <div className="truncate text-xs fg-secondary">
                {p.description}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => onView(p)}
            className="shrink-0 rounded-md bg-secondary px-3 py-1 text-xs font-medium fg-primary transition-colors hover:bg-accent-subtle"
          >
            View
          </button>
        </div>
      ))}
    </div>
  );
}

function BranchInfoTabs({
  active,
  onChange,
  codeGraphEnabled,
}: {
  active: BranchInfoTab;
  onChange: (tab: BranchInfoTab) => void;
  codeGraphEnabled: boolean;
}): JSX.Element {
  const tabs: BranchInfoTab[] = codeGraphEnabled
    ? ['details', 'pipelines', 'code-graph']
    : ['details', 'pipelines'];
  return (
    <div className="canopy-tab-list mb-3 flex gap-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={active === tab}
          onClick={() => onChange(tab)}
          className={`canopy-tab-trigger px-3 py-1.5 text-xs font-medium transition ${
            active === tab ? 'fg-primary' : 'fg-secondary hover:fg-primary'
          }`}
        >
          {tab === 'details' ? (
            'Details'
          ) : tab === 'pipelines' ? (
            'Pipelines'
          ) : (
            <span className="inline-flex items-center gap-1">
              <GraphIcon width={12} height={12} />
              Code Graph
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function PencilIcon(): JSX.Element {
  return <AppCatalogPencilIcon width="14" height="14" />;
}

function ChevronDownIcon(): JSX.Element {
  return (
    <AppCatalogChevronDownMediumIcon
      width="10"
      height="10"
      className="shrink-0"
    />
  );
}

function CheckIcon(): JSX.Element {
  return <AppCatalogCheckIcon width="14" height="14" />;
}

function CopyIcon(): JSX.Element {
  return <AppCatalogCopy width="14" height="14" />;
}

function CloseIcon(): JSX.Element {
  return <AppCatalogCloseIcon width="16" height="16" />;
}

interface DirectoryInfoRowProps {
  worktreeDirectory: string | null;
  worktreeDirectoryStatus: WorktreeDirectoryStatus;
  className?: string;
}

function DirectoryInfoRow({
  worktreeDirectory,
  worktreeDirectoryStatus,
  className,
}: DirectoryInfoRowProps): JSX.Element {
  return (
    <div className={`rounded-lg border px-3 py-2 ${className ?? ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-3xs font-medium fg-secondary">Directory</span>
        {worktreeDirectory && (
          <CopyButton
            value={worktreeDirectory}
            ariaLabel="Copy worktree directory"
            title="Copy worktree directory"
          />
        )}
      </div>
      <p
        className="mt-1 truncate font-mono text-xs fg-secondary"
        style={{
          direction: 'rtl',
          textAlign: 'left',
        }}
        title={worktreeDirectory ?? undefined}
      >
        {worktreeDirectory ? (
          `‎${worktreeDirectory}`
        ) : worktreeDirectoryStatus === 'error' ? (
          'Unavailable'
        ) : (
          <LoadingIndicator text="Loading…" />
        )}
      </p>
    </div>
  );
}

interface RemoteRenameWarningProps {
  message: string;
  /** Label for the confirm button when not loading. Existing copy variants are
   * `Rename anyway` (single repo or per-repo in multi-repo) and
   * `Rename all anyway` (rename-all in multi-repo modal). */
  confirmLabel: 'Rename anyway' | 'Rename all anyway';
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function RemoteRenameWarning({
  message,
  confirmLabel,
  loading,
  onCancel,
  onConfirm,
}: RemoteRenameWarningProps): JSX.Element {
  return (
    <Notice
      intent="attention"
      className="mt-2"
      actions={
        <>
          <NoticeButton variant="secondary" onClick={onCancel}>
            Cancel
          </NoticeButton>
          <NoticeButton
            variant="primary"
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? 'Renaming…' : confirmLabel}
          </NoticeButton>
        </>
      }
    >
      {message}
    </Notice>
  );
}

interface BranchRenameFormProps {
  /** Stable ref so callers can preserve focus after re-rendering. */
  inputRef: RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (next: string) => void;
  loading: boolean;
  error: string | null;
  /** Submit label: `Save` for per-branch rename, `Rename All` when renaming
   * every repo's branch in a multi-repo workspace. */
  submitLabel: 'Save' | 'Rename all';
  ariaLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  /** When true, the warning panel below is shown instead of triggering an
   * immediate rename — the parent surfaces it via {@link RemoteRenameWarning}. */
  confirmRemote: boolean;
  warningMessage: string;
  /** Confirmation button text inside the warning panel. */
  warningConfirmLabel: 'Rename anyway' | 'Rename all anyway';
  onWarningConfirm: () => void;
}

function BranchRenameForm({
  inputRef,
  value,
  onChange,
  loading,
  error,
  submitLabel,
  ariaLabel,
  onSubmit,
  onCancel,
  confirmRemote,
  warningMessage,
  warningConfirmLabel,
  onWarningConfirm,
}: BranchRenameFormProps): JSX.Element {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') {
              onSubmit();
            } else if (e.key === 'Escape') {
              onCancel();
            }
          }}
          disabled={loading}
          className="min-w-0 flex-1 rounded border bg-fg-primary/5 px-2 py-1 font-mono text-xs fg-primary outline-none focus:border-line-accent disabled:opacity-60"
          aria-label={ariaLabel}
        />
        <button
          type="button"
          disabled={loading}
          onClick={onSubmit}
          className="focus-ring shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-medium fg-emphasis hover:bg-accent/90 disabled:opacity-60"
        >
          {loading ? 'Saving…' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="focus-ring shrink-0 rounded-md border px-2 py-1 text-xs fg-secondary hover:bg-secondary hover:fg-primary disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
      {confirmRemote && (
        <RemoteRenameWarning
          message={warningMessage}
          confirmLabel={warningConfirmLabel}
          loading={loading}
          onCancel={onCancel}
          onConfirm={onWarningConfirm}
        />
      )}
      {error && <p className="mt-1.5 text-xs fg-destructive">{error}</p>}
    </div>
  );
}

interface BranchActionButtonsProps {
  branch: string;
  copyKey: string;
  copiedBranch: string | null;
  disabled: boolean;
  onSwitchBranchClick: () => void;
  onRenameClick: () => void;
  onCopyClick: (e: MouseEvent<HTMLButtonElement>) => void;
}

function BranchActionButtons({
  branch,
  copyKey,
  copiedBranch,
  disabled,
  onSwitchBranchClick,
  onRenameClick,
  onCopyClick,
}: BranchActionButtonsProps): JSX.Element {
  return (
    <>
      {/* RichHoverTooltip (not Tooltip): its wrapper carries no `shrink-0`,
          so the branch name can still truncate inside the row. */}
      <RichHoverTooltip
        triggerWrapperClassName="min-w-0"
        surfaceClassName="w-max"
        surfacePadding="compact"
        content={<span className="text-xs fg-primary">Switch branch</span>}
      >
        <button
          type="button"
          disabled={disabled}
          onClick={onSwitchBranchClick}
          className="flex min-w-0 items-center gap-1 rounded bg-fg-primary/5 px-2 py-0.5 font-mono text-xs fg-secondary transition-colors hover:bg-fg-primary/10 hover:fg-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-fg-primary/5 disabled:hover:fg-secondary"
          aria-label={
            copyKey === 'single' ? 'Switch branch' : `Switch branch ${branch}`
          }
        >
          <span className="truncate">{branch}</span>
          <ChevronDownIcon />
        </button>
      </RichHoverTooltip>
      <Tooltip label="Rename branch">
        <button
          type="button"
          disabled={disabled}
          onClick={onRenameClick}
          className="focus-ring shrink-0 rounded p-0.5 fg-secondary transition-colors hover:fg-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:fg-secondary"
          aria-label={
            copyKey === 'single' ? 'Rename branch' : `Rename branch ${branch}`
          }
        >
          <PencilIcon />
        </button>
      </Tooltip>
      <Tooltip
        label={copiedBranch === copyKey ? 'Copied' : `Copy branch ${branch}`}
      >
        <button
          type="button"
          onClick={onCopyClick}
          className="focus-ring shrink-0 rounded p-0.5 fg-secondary transition-colors hover:fg-primary"
          aria-label={
            copiedBranch === copyKey ? 'Copied' : `Copy branch ${branch}`
          }
        >
          {copiedBranch === copyKey ? <CheckIcon /> : <CopyIcon />}
        </button>
      </Tooltip>
    </>
  );
}

interface RepoBranchRowProps {
  rb: RepoBranchInfo;
  isRenamingThis: boolean;
  pickerOpen: boolean;
  copiedBranch: string | null;
  branchMutationsDisabled: boolean;
  projectId: string;
  worktreeId: string;
  renameInputRef: RefObject<HTMLInputElement | null>;
  renameValue: string;
  renameError: string | null;
  renameLoading: boolean;
  renameConfirmRemote: boolean;
  onRenameChange: (next: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onRenameWarningConfirm: () => void;
  onSwitchBranchClick: () => void;
  onRenameClick: () => void;
  onCopyClick: (e: MouseEvent<HTMLButtonElement>) => void;
  onBranchSwitched: (newBranch: string) => void;
  onBranchCreated: (newBranch: string, baseBranch: string) => void;
  onBaseBranchChange: (
    branchName: string,
    presence?: { existsLocally: boolean; existsInRemote: boolean },
  ) => void;
  onClosePicker: () => void;
}

function RepoBranchRow({
  rb,
  isRenamingThis,
  pickerOpen,
  copiedBranch,
  branchMutationsDisabled,
  projectId,
  worktreeId,
  renameInputRef,
  renameValue,
  renameError,
  renameLoading,
  renameConfirmRemote,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onRenameWarningConfirm,
  onSwitchBranchClick,
  onRenameClick,
  onCopyClick,
  onBranchSwitched,
  onBranchCreated,
  onBaseBranchChange,
  onClosePicker,
}: RepoBranchRowProps): JSX.Element {
  const repoHasChanges = (rb.insertions ?? 0) + (rb.deletions ?? 0) > 0;
  const baseBranchProvenance = getBaseBranchProvenance({
    existsLocally: rb.baseBranchExistsLocally,
    existsInRemote: rb.baseBranchExistsInRemote,
  });

  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span
          className="shrink-0 text-s font-medium fg-primary"
          title={rb.repoName}
        >
          {rb.repoName}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {repoHasChanges && (
            <span className="inline-flex items-center gap-1 text-xs font-semibold tabular-nums">
              <span className="fg-success">+{rb.insertions}</span>
              <span className="fg-destructive">-{rb.deletions}</span>
            </span>
          )}
          {!isRenamingThis && (
            <BranchActionButtons
              branch={rb.branch}
              copyKey={rb.repoId}
              copiedBranch={copiedBranch}
              disabled={branchMutationsDisabled}
              onSwitchBranchClick={onSwitchBranchClick}
              onRenameClick={onRenameClick}
              onCopyClick={onCopyClick}
            />
          )}
        </span>
      </div>
      {!isRenamingThis && (
        <div className="mt-1 flex items-center gap-2">
          <span className="text-3xs fg-secondary">base:</span>
          <div className="min-w-0 flex-1">
            <BaseBranchDropdown
              projectId={projectId}
              worktreeId={worktreeId}
              repoId={rb.repoId}
              currentValue={rb.baseBranch ?? null}
              disabled={branchMutationsDisabled}
              onChange={onBaseBranchChange}
            />
          </div>
          {baseBranchProvenance && (
            <span
              className={`shrink-0 text-3xs ${baseBranchProvenance.className}`}
            >
              {baseBranchProvenance.label}
            </span>
          )}
        </div>
      )}
      {!isRenamingThis && pickerOpen && (
        <div className="mt-1">
          <BranchPicker
            projectId={projectId}
            worktreeId={worktreeId}
            repoId={rb.repoId}
            currentBranch={rb.branch}
            baseBranch={rb.baseBranch}
            onBranchSwitched={onBranchSwitched}
            onBranchCreated={onBranchCreated}
            onClose={onClosePicker}
          />
        </div>
      )}
      {isRenamingThis && (
        <div className="mt-2">
          <BranchRenameForm
            inputRef={renameInputRef}
            value={renameValue}
            onChange={onRenameChange}
            loading={renameLoading}
            error={renameError}
            submitLabel="Save"
            ariaLabel="New branch name"
            onSubmit={onRenameSubmit}
            onCancel={onRenameCancel}
            confirmRemote={renameConfirmRemote}
            warningMessage="This branch has already been pushed to remote. Renaming will only change the local branch name — the old remote branch and any associated PRs will still exist."
            warningConfirmLabel="Rename anyway"
            onWarningConfirm={onRenameWarningConfirm}
          />
        </div>
      )}
    </div>
  );
}

interface BranchInfoModalFrameProps {
  /** DOM id used for `aria-labelledby` on the dialog. */
  titleId: string;
  /** Tailwind max-w class. Single-repo uses max-w-md; multi-repo uses max-w-xl. */
  maxWidthClass: 'max-w-md' | 'max-w-xl';
  /** Header content (title + optional inline action). */
  header: ReactNode;
  /** Whether keyboard Escape should defer to the rename cancel handler first. */
  escapeFirstClosesRename: boolean;
  onCancelRename: () => void;
  onClose: () => void;
  children: ReactNode;
}

function BranchInfoModalFrame({
  titleId: _titleId,
  maxWidthClass,
  header,
  escapeFirstClosesRename,
  onCancelRename,
  onClose,
  children,
}: BranchInfoModalFrameProps): JSX.Element {
  const overlay = (
    <div
      data-canopy-browser-native-overlay="true"
      className="fixed inset-0 z-modal flex items-center justify-center bg-overlay-scrim p-4"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
        onCancelRename();
      }}
    >
      {/* Git error output is blocked. */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={_titleId}
        className={`w-full ${maxWidthClass} rounded-2xl bg-card p-5 shadow-xl`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            if (escapeFirstClosesRename) {
              onCancelRename();
            } else {
              onClose();
            }
          }
        }}
      >
        {header}
        {children}
      </div>
    </div>
  );

  // The dialog is commonly opened from a worktree row inside the sidebar.
  // Portal it out of the sidebar's backdrop-filter containing block so fixed
  // positioning always resolves against the full app window.
  return typeof document !== 'undefined' && document.body
    ? createPortal(overlay, document.body)
    : overlay;
}

export interface WorktreeBranchInfoDialogPendingRename {
  /** `'single'`, `'all'`, or a repoId — must match the form selection scheme. */
  id: string;
  branch: string;
}

export interface WorktreeBranchInfoDialogProps {
  open: boolean;
  worktree: WorktreeData;
  projectId: string;
  isMultiRepo?: boolean;
  repoBranches?: RepoBranchInfo[];
  configRepos?: WorkspaceRepoData[];
  /** Single-repo only. Whether the worktree branch has been pushed to remote
   * — controls the rename remote-confirmation warning. */
  hasBranchBeenPushed?: boolean;
  baseBranch?: string | null;
  baseBranchExistsLocally?: boolean;
  baseBranchExistsInRemote?: boolean;
  /** Prevent Git branch mutations while checkout or setup scripts are active. */
  branchMutationsDisabled?: boolean;
  onAddRepoToWorktree?: (
    worktreeId: string,
    repoId: string,
  ) => void | Promise<void>;
  onRemoveRepoFromWorktree?: (
    worktreeId: string,
    repoId: string,
  ) => void | Promise<void>;
  onClose: () => void;
  /** When set, the dialog opens (or, if already open, switches) directly into
   * a rename flow seeded with this id/branch, then calls
   * {@link onPendingRenameConsumed} so the parent can clear its request. */
  pendingRename?: WorktreeBranchInfoDialogPendingRename | null;
  onPendingRenameConsumed?: () => void;
  /**
   * Generated fallback shown by the Label field when no custom label is set
   * (the computed branch display name used as the sidebar row's primary name).
   */
  labelFallback?: string;
  /** When set, open directly into the Label edit flow with the input focused. */
  pendingLabelEdit?: boolean;
  /** Called once the `pendingLabelEdit` request has been consumed. */
  onPendingLabelEditConsumed?: () => void;
}

export function WorktreeBranchInfoDialog({
  open,
  worktree,
  projectId,
  isMultiRepo,
  repoBranches,
  configRepos,
  hasBranchBeenPushed,
  baseBranch,
  baseBranchExistsLocally,
  baseBranchExistsInRemote,
  branchMutationsDisabled = false,
  onAddRepoToWorktree,
  onRemoveRepoFromWorktree,
  onClose,
  pendingRename,
  onPendingRenameConsumed,
  labelFallback,
  pendingLabelEdit,
  onPendingLabelEditConsumed,
}: WorktreeBranchInfoDialogProps): JSX.Element | null {
  const { copiedKey: copiedBranch, copy: copyBranch } = useClipboardCopy();
  const setWorktreeLabel = useProjectsStore((state) => state.setWorktreeLabel);
  const [labelEditRequested, setLabelEditRequested] = useState(false);

  // Branch rename state
  const [renamingBranch, setRenamingBranch] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameLoading, setRenameLoading] = useState(false);
  const [renameConfirmRemote, setRenameConfirmRemote] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [branchPickerOpen, setBranchPickerOpen] = useState<string | null>(null);

  const [branchInfoTab, setBranchInfoTab] = useState<BranchInfoTab>('details');
  const [projectPipelines, setProjectPipelines] = useState<PipelineInfo[]>([]);
  const [pipelinesLoading, setPipelinesLoading] = useState(false);

  const codeGraphExperimentEnabled = useCodeGraphExperimentEnabled();
  // Live "building" flag for this worktree's code graph, keyed
  // `${projectId}/${worktreeId}`, so the panel reflects a build already running
  // (started elsewhere) and refreshes when it finishes.
  const isBuildingCodeGraph = useCodeGraphBuildStore(
    (state) => state.building[`${projectId}/${worktree.id}`] === true,
  );
  // If the flag flips off while the Code Graph tab is active, fall back to
  // Details so a hidden tab's panel never lingers.
  const effectiveBranchInfoTab: BranchInfoTab =
    branchInfoTab === 'code-graph' && !codeGraphExperimentEnabled
      ? 'details'
      : branchInfoTab;

  const openCodeGraphSettings = useCallback((): void => {
    onClose();
    useNavigationStore.getState().openSettings('code-graph');
  }, [onClose]);

  const codeGraphPanel = (
    <div className="mt-3">
      <CodeGraphSummaryPanel
        advisorContext={{
          scope: 'worktree',
          workspaceId: projectId,
          worktreeId: worktree.id,
        }}
        load={(): ReturnType<typeof window.api.codeGraphGetWorktreeSummary> =>
          window.api.codeGraphGetWorktreeSummary({
            workspaceId: projectId,
            worktreeId: worktree.id,
          })
        }
        build={(): ReturnType<typeof window.api.codeGraphBuildWorktree> =>
          window.api.codeGraphBuildWorktree({
            workspaceId: projectId,
            worktreeId: worktree.id,
          })
        }
        onOpenSettings={openCodeGraphSettings}
        externalBuilding={isBuildingCodeGraph}
      />
    </div>
  );

  const [worktreeDirectory, setWorktreeDirectory] = useState<string | null>(
    null,
  );
  const [worktreeDirectoryStatus, setWorktreeDirectoryStatus] =
    useState<WorktreeDirectoryStatus>('idle');

  const [healthRetrying, setHealthRetrying] = useState(false);
  const [healthRetryError, setHealthRetryError] = useState<string | null>(null);
  const healthRetryAttemptRef = useRef(0);

  const [addingRepoId, setAddingRepoId] = useState<string | null>(null);
  const [removingRepoId, setRemovingRepoId] = useState<string | null>(null);

  const startRename = useCallback((id: string, currentBranch: string): void => {
    setRenamingBranch(id);
    setRenameValue(currentBranch);
    setRenameError(null);
    setRenameConfirmRemote(false);
    setTimeout(() => {
      const input = renameInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }, 0);
  }, []);

  const cancelRename = useCallback((): void => {
    setRenamingBranch(null);
    setRenameValue('');
    setRenameError(null);
    setRenameConfirmRemote(false);
  }, []);

  useEffect(() => {
    if (!branchMutationsDisabled) return;
    cancelRename();
    setBranchPickerOpen(null);
  }, [branchMutationsDisabled, cancelRename]);

  // Reset transient modal state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setBranchInfoTab('details');
      setProjectPipelines([]);
    }
  }, [open]);

  // Reset modal-only health retry state when it closes.
  useEffect(() => {
    if (open) return;
    healthRetryAttemptRef.current += 1;
    setHealthRetrying(false);
    setHealthRetryError(null);
  }, [open]);

  // Clear cached retry-error whenever the underlying issue changes upstream.
  useEffect(() => {
    setHealthRetryError(null);
  }, [
    worktree.healthIssue?.checkedAt,
    worktree.healthIssue?.code,
    worktree.healthIssue?.gitError,
    worktree.healthIssue?.message,
    worktree.healthIssue?.worktreePath,
  ]);

  // Load worktree directory while the modal is open.
  useEffect(() => {
    if (!open) {
      setWorktreeDirectory(null);
      setWorktreeDirectoryStatus('idle');
      return;
    }
    setWorktreeDirectoryStatus('loading');
    let cancelled = false;
    void (async (): Promise<void> => {
      try {
        const dir = await window.api.getWorktreePath({
          projectId,
          worktreeId: worktree.id,
        });
        if (!cancelled) {
          setWorktreeDirectory(dir.replace(/\/+$/, ''));
          setWorktreeDirectoryStatus('loaded');
        }
      } catch {
        if (!cancelled) {
          setWorktreeDirectory(null);
          setWorktreeDirectoryStatus('error');
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [open, projectId, worktree.id]);

  // Load project pipelines when switching to the pipelines tab.
  useEffect(() => {
    if (!open || branchInfoTab !== 'pipelines') return;
    let cancelled = false;

    async function discover(): Promise<void> {
      setPipelinesLoading(true);
      try {
        const cwd = await window.api.getWorktreePath({
          projectId,
          worktreeId: worktree.id,
        });
        const result = await window.pipelines.discoverProject(cwd);
        if (!cancelled && result.success && result.data) {
          setProjectPipelines(result.data);
        }
      } catch {
        // Swallow — empty list is fine
      } finally {
        if (!cancelled) setPipelinesLoading(false);
      }
    }

    void discover();
    return (): void => {
      cancelled = true;
    };
  }, [open, branchInfoTab, projectId, worktree.id]);

  // Consume external "open with rename" requests from the store. The parent
  // sets `pendingRename` and invokes `onPendingRenameConsumed` once we've
  // primed the rename form so it doesn't fire repeatedly.
  useEffect(() => {
    if (!open || !pendingRename) return;
    if (!branchMutationsDisabled) {
      startRename(pendingRename.id, pendingRename.branch);
    }
    onPendingRenameConsumed?.();
  }, [
    open,
    pendingRename,
    branchMutationsDisabled,
    startRename,
    onPendingRenameConsumed,
  ]);

  // Consume external "open into label edit" requests (the "Set label" action).
  useEffect(() => {
    if (!open || !pendingLabelEdit) return;
    setBranchInfoTab('details');
    setLabelEditRequested(true);
    onPendingLabelEditConsumed?.();
  }, [open, pendingLabelEdit, onPendingLabelEditConsumed]);

  const handleRetryHealthCheck = useCallback(async (): Promise<void> => {
    const attemptId = healthRetryAttemptRef.current + 1;
    healthRetryAttemptRef.current = attemptId;
    setHealthRetrying(true);
    setHealthRetryError(null);
    try {
      const response = await useProjectsStore
        .getState()
        .retryWorktreeHealthCheck(projectId, worktree.id);
      if (healthRetryAttemptRef.current !== attemptId) {
        return;
      }
      if (!response.healthy) {
        setHealthRetryError(formatHealthRetryError(response.issue));
      }
    } catch (error) {
      if (healthRetryAttemptRef.current !== attemptId) {
        return;
      }
      setHealthRetryError(
        error instanceof Error ? error.message : 'Health check retry failed.',
      );
    } finally {
      if (healthRetryAttemptRef.current === attemptId) {
        setHealthRetrying(false);
      }
    }
  }, [projectId, worktree.id]);

  const handleBranchSwitched = useCallback(
    async (newBranch: string, pickerRepoId?: string): Promise<void> => {
      useProjectsStore
        .getState()
        .updateBranchName(projectId, worktree.id, newBranch, pickerRepoId);
      // Do NOT clear tracked base on simple switch — preserve tracked base metadata.
      await Promise.all([
        useProjectsStore.getState().refreshDiffStats(),
        refreshWorktreeActivity(projectId, worktree.id),
      ]);
      setBranchPickerOpen(null);
    },
    [projectId, worktree.id],
  );

  const handleBranchCreated = useCallback(
    async (
      newBranch: string,
      newBaseBranch: string,
      pickerRepoId?: string,
    ): Promise<void> => {
      useProjectsStore
        .getState()
        .updateBranchName(projectId, worktree.id, newBranch, pickerRepoId);
      // Persist the selected base branch so diff stats use it.
      await useProjectsStore
        .getState()
        .setTrackedBaseBranch(
          projectId,
          worktree.id,
          newBaseBranch,
          pickerRepoId,
        );
      await refreshWorktreeActivity(projectId, worktree.id);
      setBranchPickerOpen(null);
    },
    [projectId, worktree.id],
  );

  const handleCopyBranch = useCallback(
    (
      repoId: string,
      branch: string,
      e: MouseEvent<HTMLButtonElement>,
    ): void => {
      e.stopPropagation();
      void copyBranch(branch, repoId);
    },
    [copyBranch],
  );

  const handleRenameBranch = useCallback(
    async (
      repoId: string | undefined,
      currentBranch: string,
      isPushedToRemote: boolean,
    ): Promise<void> => {
      const trimmed = renameValue.trim();
      if (!trimmed || trimmed === currentBranch) {
        cancelRename();
        return;
      }
      if (isPushedToRemote && !renameConfirmRemote) {
        setRenameConfirmRemote(true);
        return;
      }
      setRenameLoading(true);
      setRenameError(null);
      try {
        await window.api.renameBranch({
          projectId,
          worktreeId: worktree.id,
          newBranchName: trimmed,
          repoId,
        });
        useProjectsStore
          .getState()
          .updateBranchName(projectId, worktree.id, trimmed, repoId);
        cancelRename();
        void useProjectsStore.getState().refreshDiffStats();
      } catch (err: unknown) {
        setRenameError(
          err instanceof Error ? err.message : 'Failed to rename branch',
        );
      } finally {
        setRenameLoading(false);
      }
    },
    [renameValue, projectId, worktree.id, renameConfirmRemote, cancelRename],
  );

  const handleRenameAll = useCallback(
    async (isPushedToRemote: boolean): Promise<void> => {
      const trimmed = renameValue.trim();
      if (!trimmed || !repoBranches || repoBranches.length === 0) {
        cancelRename();
        return;
      }
      if (isPushedToRemote && !renameConfirmRemote) {
        setRenameConfirmRemote(true);
        return;
      }
      setRenameLoading(true);
      setRenameError(null);
      try {
        const errors: string[] = [];
        for (const rb of repoBranches) {
          if (rb.branch === trimmed) continue;
          try {
            await window.api.renameBranch({
              projectId,
              worktreeId: worktree.id,
              newBranchName: trimmed,
              repoId: rb.repoId,
            });
            useProjectsStore
              .getState()
              .updateBranchName(projectId, worktree.id, trimmed, rb.repoId);
          } catch (err: unknown) {
            errors.push(
              `${rb.repoName}: ${err instanceof Error ? err.message : 'Failed'}`,
            );
          }
        }
        if (errors.length > 0) {
          setRenameError(errors.join('; '));
        } else {
          cancelRename();
        }
        void useProjectsStore.getState().refreshDiffStats();
      } finally {
        setRenameLoading(false);
      }
    },
    [
      renameValue,
      projectId,
      worktree.id,
      repoBranches,
      renameConfirmRemote,
      cancelRename,
    ],
  );

  const handleViewPipeline = useCallback(
    (pipeline: PipelineInfo): void => {
      onClose();

      void (async (): Promise<void> => {
        let pipelineCwd: string | undefined;
        try {
          pipelineCwd = await window.api.getWorktreePath({
            projectId,
            worktreeId: worktree.id,
          });
        } catch {
          // Fall through — editor can still attempt to open without cwd
        }

        const { openPipelineEdit } = useNavigationStore.getState();
        openPipelineEdit({
          pipelineId: pipeline.id,
          cwd: pipelineCwd,
          filePath: pipeline.filePath,
        });
      })();
    },
    [projectId, worktree.id, onClose],
  );

  const displayBaseBranch = useMemo(
    (): string | null =>
      resolveDisplayedBaseBranch({
        isMultiRepo,
        repoBranches,
        baseBranch,
        trackedBaseBranch: worktree.trackedBaseBranch,
      }),
    [baseBranch, isMultiRepo, repoBranches, worktree.trackedBaseBranch],
  );

  const displayBaseBranchProvenance = useMemo((): {
    label: 'local' | 'remote';
    className: string;
  } | null => {
    if (isMultiRepo) {
      return getSharedBaseBranchProvenance(repoBranches, displayBaseBranch);
    }
    return getBaseBranchProvenance({
      existsLocally: baseBranchExistsLocally,
      existsInRemote: baseBranchExistsInRemote,
    });
  }, [
    baseBranchExistsLocally,
    baseBranchExistsInRemote,
    displayBaseBranch,
    isMultiRepo,
    repoBranches,
  ]);

  const missingRepos = useMemo(() => {
    if (!isMultiRepo || !configRepos || !repoBranches) return [];
    const onDiskRepoIds = new Set(repoBranches.map((rb) => rb.repoId));
    return configRepos.filter((r) => !onDiskRepoIds.has(r.id));
  }, [isMultiRepo, configRepos, repoBranches]);

  const staleRepos = useMemo(() => {
    if (!isMultiRepo || !configRepos) return [];
    const configRepoIds = new Set(configRepos.map((r) => r.id));
    return (repoBranches ?? []).filter(
      (rb) =>
        rb.repoId !== WORKSPACE_ROOT_REPO_ID && !configRepoIds.has(rb.repoId),
    );
  }, [isMultiRepo, configRepos, repoBranches]);

  // Per-repo health problems on repos that are present on disk. Missing-repo
  // issues are already rendered via `missingRepos`, so they're excluded here.
  const brokenRepoIssues = useMemo(() => {
    if (!isMultiRepo) return [];
    return (worktree.healthIssue?.repoIssues ?? []).filter(
      (issue) => issue.code !== 'missing-repository',
    );
  }, [isMultiRepo, worktree.healthIssue]);
  const brokenRepoIds = useMemo(
    () => new Set(brokenRepoIssues.map((issue) => issue.repoId)),
    [brokenRepoIssues],
  );

  if (!open) return null;

  const handleClose = (): void => {
    onClose();
    cancelRename();
  };

  const handleAddRepo = async (repoId: string): Promise<void> => {
    setAddingRepoId(repoId);
    try {
      await onAddRepoToWorktree?.(worktree.id, repoId);
    } catch {
      // Error handled upstream
    } finally {
      setAddingRepoId(null);
    }
  };

  const handleRemoveRepo = async (repoId: string): Promise<void> => {
    setRemovingRepoId(repoId);
    try {
      await onRemoveRepoFromWorktree?.(worktree.id, repoId);
    } catch {
      // Error handled upstream
    } finally {
      setRemovingRepoId(null);
    }
  };

  const labelField = (
    <LabelField
      label={worktree.label}
      fallback={labelFallback ?? worktree.branchName}
      placeholder={labelFallback ?? worktree.branchName}
      startInEdit={labelEditRequested}
      onEditConsumed={() => setLabelEditRequested(false)}
      onSubmit={(label) => setWorktreeLabel(projectId, worktree.id, label)}
    />
  );
  const branchSetupNotice = branchMutationsDisabled ? (
    <div
      className="mb-2 rounded-lg border bg-fg-primary/5 px-3 py-2"
      data-testid="branch-setup-pending-notice"
    >
      <p className="text-xs font-medium fg-primary">Setting up worktree</p>
      <p className="mt-0.5 text-xs fg-secondary">
        Branch changes will be available when setup finishes.
      </p>
    </div>
  ) : null;

  if (!isMultiRepo) {
    const titleId = `branch-info-${worktree.id}`;
    const header = (
      <div className="flex items-center justify-between">
        <h2 id={titleId} className="text-m font-semibold fg-primary">
          Branch info
        </h2>
        <button
          type="button"
          onClick={handleClose}
          className="focus-ring rounded p-1 fg-secondary hover:fg-primary"
          aria-label="Close"
        >
          <CloseIcon />
        </button>
      </div>
    );

    return (
      <BranchInfoModalFrame
        titleId={titleId}
        maxWidthClass="max-w-md"
        header={header}
        escapeFirstClosesRename={renamingBranch !== null}
        onCancelRename={cancelRename}
        onClose={onClose}
      >
        <div className="mt-3">
          <BranchInfoTabs
            active={effectiveBranchInfoTab}
            onChange={setBranchInfoTab}
            codeGraphEnabled={codeGraphExperimentEnabled}
          />
        </div>
        {effectiveBranchInfoTab === 'pipelines' && (
          <ProjectPipelineList
            pipelines={projectPipelines}
            loading={pipelinesLoading}
            onView={handleViewPipeline}
          />
        )}
        {effectiveBranchInfoTab === 'code-graph' && codeGraphPanel}
        {effectiveBranchInfoTab === 'details' && (
          <div className="mt-3">
            <div className="mb-2">{labelField}</div>
            {branchSetupNotice}
            {worktree.healthIssue?.status === 'broken' && (
              <WorktreeHealthAlert
                issue={worktree.healthIssue}
                retrying={healthRetrying}
                retryError={healthRetryError}
                onRetry={handleRetryHealthCheck}
              />
            )}
            <DirectoryInfoRow
              worktreeDirectory={worktreeDirectory}
              worktreeDirectoryStatus={worktreeDirectoryStatus}
              className="mb-2"
            />
            {renamingBranch === 'single' ? (
              <BranchRenameForm
                inputRef={renameInputRef}
                value={renameValue}
                onChange={(next) => {
                  setRenameValue(next);
                  setRenameError(null);
                  setRenameConfirmRemote(false);
                }}
                loading={renameLoading}
                error={renameError}
                submitLabel="Save"
                ariaLabel="New branch name"
                onSubmit={() =>
                  void handleRenameBranch(
                    undefined,
                    worktree.branchName,
                    hasBranchBeenPushed ?? false,
                  )
                }
                onCancel={cancelRename}
                confirmRemote={renameConfirmRemote}
                warningMessage="This branch has already been pushed to remote. Renaming will only change the local branch name — the old remote branch and any associated PRs will still exist."
                warningConfirmLabel="Rename anyway"
                onWarningConfirm={() => {
                  setRenameConfirmRemote(true);
                  void handleRenameBranch(
                    undefined,
                    worktree.branchName,
                    false,
                  );
                }}
              />
            ) : (
              <div>
                <div className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                  <BranchActionButtons
                    branch={worktree.branchName}
                    copyKey="single"
                    copiedBranch={copiedBranch}
                    disabled={branchMutationsDisabled}
                    onSwitchBranchClick={() =>
                      setBranchPickerOpen(
                        branchPickerOpen === 'single' ? null : 'single',
                      )
                    }
                    onRenameClick={() =>
                      startRename('single', worktree.branchName)
                    }
                    onCopyClick={(e) =>
                      handleCopyBranch('single', worktree.branchName, e)
                    }
                  />
                </div>
                <div className="mt-2 rounded-lg border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-3xs font-medium fg-secondary">
                      Base branch
                    </span>
                    {displayBaseBranchProvenance && (
                      <span
                        className={`text-3xs ${displayBaseBranchProvenance.className}`}
                        data-testid="base-branch-provenance-badge"
                      >
                        {displayBaseBranchProvenance.label}
                      </span>
                    )}
                  </div>
                  <div className="mt-1">
                    <BaseBranchDropdown
                      projectId={projectId}
                      worktreeId={worktree.id}
                      currentValue={displayBaseBranch}
                      disabled={branchMutationsDisabled}
                      onChange={(branchName, presence) => {
                        void (async (): Promise<void> => {
                          await useProjectsStore
                            .getState()
                            .setTrackedBaseBranch(
                              projectId,
                              worktree.id,
                              branchName,
                              undefined,
                              presence,
                            );
                          await refreshWorktreeActivity(projectId, worktree.id);
                        })();
                      }}
                    />
                  </div>
                </div>
                {branchPickerOpen === 'single' && (
                  <div className="mt-1">
                    <BranchPicker
                      projectId={projectId}
                      worktreeId={worktree.id}
                      currentBranch={worktree.branchName}
                      baseBranch={displayBaseBranch}
                      onBranchSwitched={(newBranch) =>
                        void handleBranchSwitched(newBranch, undefined)
                      }
                      onBranchCreated={(newBranch, newBaseBranch) =>
                        void handleBranchCreated(
                          newBranch,
                          newBaseBranch,
                          undefined,
                        )
                      }
                      onClose={() => setBranchPickerOpen(null)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </BranchInfoModalFrame>
    );
  }

  // Multi-repo modal
  const titleId = `repo-branches-${worktree.id}`;
  const header = (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1.5">
        <h2 id={titleId} className="text-m font-semibold fg-primary">
          Repo branches
        </h2>
        {renamingBranch !== 'all' && (
          <Tooltip label="Rename all branches">
            <button
              type="button"
              disabled={branchMutationsDisabled}
              onClick={() => {
                cancelRename();
                startRename(
                  'all',
                  repoBranches && repoBranches.length > 0
                    ? repoBranches[0].branch
                    : worktree.branchName,
                );
              }}
              className="focus-ring shrink-0 rounded p-0.5 fg-secondary transition-colors hover:fg-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:fg-secondary"
              aria-label="Rename all branches"
            >
              <PencilIcon />
            </button>
          </Tooltip>
        )}
      </div>
      <button
        type="button"
        onClick={handleClose}
        className="focus-ring rounded p-1 fg-secondary hover:fg-primary"
        aria-label="Close"
      >
        <CloseIcon />
      </button>
    </div>
  );

  return (
    <BranchInfoModalFrame
      titleId={titleId}
      maxWidthClass="max-w-xl"
      header={header}
      escapeFirstClosesRename={renamingBranch !== null}
      onCancelRename={cancelRename}
      onClose={onClose}
    >
      <div className="mt-3">
        <BranchInfoTabs
          active={effectiveBranchInfoTab}
          onChange={setBranchInfoTab}
          codeGraphEnabled={codeGraphExperimentEnabled}
        />
      </div>
      {effectiveBranchInfoTab === 'pipelines' && (
        <ProjectPipelineList
          pipelines={projectPipelines}
          loading={pipelinesLoading}
          onView={handleViewPipeline}
        />
      )}
      {effectiveBranchInfoTab === 'code-graph' && codeGraphPanel}
      {effectiveBranchInfoTab === 'details' && (
        <>
          <div className="mt-3">{labelField}</div>
          {branchSetupNotice && <div className="mt-2">{branchSetupNotice}</div>}
          {worktree.healthIssue?.status === 'broken' && (
            <WorktreeHealthAlert
              issue={worktree.healthIssue}
              retrying={healthRetrying}
              retryError={healthRetryError}
              onRetry={handleRetryHealthCheck}
            />
          )}
          <DirectoryInfoRow
            worktreeDirectory={worktreeDirectory}
            worktreeDirectoryStatus={worktreeDirectoryStatus}
            className="mt-3"
          />
          {renamingBranch === 'all' && (
            <div className="mt-3">
              <BranchRenameForm
                inputRef={renameInputRef}
                value={renameValue}
                onChange={(next) => {
                  setRenameValue(next);
                  setRenameError(null);
                  setRenameConfirmRemote(false);
                }}
                loading={renameLoading}
                error={renameError}
                submitLabel="Rename all"
                ariaLabel="New branch name for all repos"
                onSubmit={() => {
                  const anyPushed =
                    repoBranches?.some((rb) => rb.hasBranchBeenPushed) ?? false;
                  void handleRenameAll(anyPushed);
                }}
                onCancel={cancelRename}
                confirmRemote={renameConfirmRemote}
                warningMessage="One or more branches have already been pushed to remote. Renaming will only change local branch names — the old remote branches and any associated PRs will still exist."
                warningConfirmLabel="Rename all anyway"
                onWarningConfirm={() => {
                  setRenameConfirmRemote(true);
                  void handleRenameAll(false);
                }}
              />
            </div>
          )}
          <div className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto">
            {/* Missing repos — in config but not on disk */}
            {missingRepos.map((repo) => (
              <div
                key={repo.id}
                className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line-attention/40 bg-warning-subtle px-3 py-2"
              >
                <span className="shrink-0 text-s font-medium fg-primary">
                  {repo.name}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-xs fg-primary">Not in worktree</span>
                  <button
                    type="button"
                    disabled={addingRepoId === repo.id}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await handleAddRepo(repo.id);
                    }}
                    className="focus-ring shrink-0 rounded-md bg-accent px-2 py-1 text-xs font-medium fg-emphasis hover:bg-accent/90 disabled:opacity-60"
                  >
                    {addingRepoId === repo.id ? 'Adding…' : 'Add'}
                  </button>
                </span>
              </div>
            ))}

            {/* Stale repos — on disk but removed from config */}
            {staleRepos.map((rb) => (
              <div
                key={rb.repoId}
                className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-line-attention/40 bg-warning-subtle px-3 py-2"
              >
                <span className="shrink-0 text-s font-medium fg-primary">
                  {rb.repoName}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="text-xs fg-primary">
                    Removed from project
                  </span>
                  <button
                    type="button"
                    disabled={removingRepoId === rb.repoId}
                    onClick={async (e) => {
                      e.stopPropagation();
                      await handleRemoveRepo(rb.repoId);
                    }}
                    className="focus-ring shrink-0 rounded-md border border-line-attention/40 bg-warning-subtle px-2 py-1 text-xs fg-primary transition hover:bg-warning-subtle/80 disabled:opacity-60"
                  >
                    {removingRepoId === rb.repoId ? 'Removing…' : 'Remove'}
                  </button>
                </span>
              </div>
            ))}

            {/* Broken repos — present on disk but failed health checks */}
            {brokenRepoIssues.map((issue) => (
              <div
                key={issue.repoId}
                className="rounded-lg border border-line-attention/40 bg-warning-subtle px-3 py-2"
              >
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <span className="shrink-0 text-s font-medium fg-primary">
                    {issue.repoName}
                  </span>
                  <span className="text-xs fg-primary">
                    Branch info unavailable
                  </span>
                </div>
                <p className="mt-1 text-xs fg-primary">{issue.message}</p>
                {issue.gitError && (
                  <p
                    className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-1 whitespace-pre-wrap break-words font-mono text-2xs fg-secondary`}
                  >
                    {issue.gitError}
                  </p>
                )}
              </div>
            ))}

            {/* Normal repos — exist both in config and on disk */}
            {repoBranches && repoBranches.length > 0
              ? repoBranches
                  .filter(
                    (rb) =>
                      !staleRepos.some((s) => s.repoId === rb.repoId) &&
                      !brokenRepoIds.has(rb.repoId),
                  )
                  .map((rb) => {
                    const isRenamingThis = renamingBranch === rb.repoId;
                    const pickerOpen = branchPickerOpen === rb.repoId;
                    return (
                      <RepoBranchRow
                        key={rb.repoId}
                        rb={rb}
                        isRenamingThis={isRenamingThis}
                        pickerOpen={pickerOpen}
                        copiedBranch={copiedBranch}
                        branchMutationsDisabled={branchMutationsDisabled}
                        projectId={projectId}
                        worktreeId={worktree.id}
                        renameInputRef={renameInputRef}
                        renameValue={renameValue}
                        renameError={renameError}
                        renameLoading={renameLoading}
                        renameConfirmRemote={renameConfirmRemote}
                        onRenameChange={(next) => {
                          setRenameValue(next);
                          setRenameError(null);
                          setRenameConfirmRemote(false);
                        }}
                        onRenameSubmit={() =>
                          void handleRenameBranch(
                            rb.repoId,
                            rb.branch,
                            rb.hasBranchBeenPushed ?? false,
                          )
                        }
                        onRenameCancel={cancelRename}
                        onRenameWarningConfirm={() => {
                          setRenameConfirmRemote(true);
                          void handleRenameBranch(rb.repoId, rb.branch, false);
                        }}
                        onSwitchBranchClick={() =>
                          setBranchPickerOpen(
                            branchPickerOpen === rb.repoId ? null : rb.repoId,
                          )
                        }
                        onRenameClick={() => startRename(rb.repoId, rb.branch)}
                        onCopyClick={(e) =>
                          handleCopyBranch(rb.repoId, rb.branch, e)
                        }
                        onBranchSwitched={(newBranch) =>
                          void handleBranchSwitched(newBranch, rb.repoId)
                        }
                        onBranchCreated={(newBranch, newBaseBranch) =>
                          void handleBranchCreated(
                            newBranch,
                            newBaseBranch,
                            rb.repoId,
                          )
                        }
                        onBaseBranchChange={(branchName, presence) => {
                          void (async (): Promise<void> => {
                            await useProjectsStore
                              .getState()
                              .setTrackedBaseBranch(
                                projectId,
                                worktree.id,
                                branchName,
                                rb.repoId,
                                presence,
                              );
                            await refreshWorktreeActivity(
                              projectId,
                              worktree.id,
                            );
                          })();
                        }}
                        onClosePicker={() => setBranchPickerOpen(null)}
                      />
                    );
                  })
              : missingRepos.length === 0 &&
                staleRepos.length === 0 &&
                brokenRepoIssues.length === 0 && (
                  <p className="text-s fg-secondary">
                    No branch information available yet.
                  </p>
                )}
          </div>
        </>
      )}
    </BranchInfoModalFrame>
  );
}
