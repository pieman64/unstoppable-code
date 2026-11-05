import type { JSX } from 'react';
import { Button, LoadingSpinner } from '@canopy/ui-shared/components';
import { FolderIcon } from '@canopy/ui-shared/icons/AppIcons';

/**
 * A project the host is still adding: a clone that has not produced a
 * workspace row yet. The host owns the lifecycle and every policy decision
 * (which actions are allowed, when the row goes away); this is presentation.
 */
export interface SidebarPendingProject {
  readonly id: string;
  readonly name: string;
  readonly status: 'cloning' | 'cancelling' | 'failed';
  /** Replaces the default status line while the row is not failed. */
  readonly statusText?: string;
  /** Failure detail, or the reason an unresolved row stopped. */
  readonly message?: string;
  /**
   * False when the host can no longer tell whether work is still happening,
   * so the row must not show motion. Defaults to true for non-failed rows.
   */
  readonly active?: boolean;
  /** True while a Retry is being submitted; disables the control. */
  readonly retrying?: boolean;
  readonly onRetry?: () => void;
  readonly onDismiss?: () => void;
}

function defaultStatusText(project: SidebarPendingProject): string {
  if (project.status === 'failed') return `Couldn't clone ${project.name}`;
  if (project.status === 'cancelling') return 'Cancelling…';
  return 'Cloning…';
}

export function PendingProjectRow({
  project,
}: {
  readonly project: SidebarPendingProject;
}): JSX.Element {
  const failed = project.status === 'failed';
  // The name is the row's title, so a failure with a reason shows the reason
  // alone instead of naming the project a second time.
  const statusLine = failed
    ? (project.message ?? defaultStatusText(project))
    : [project.statusText ?? defaultStatusText(project), project.message]
        .filter(Boolean)
        .join(' ');
  const hasActions =
    (failed && project.onRetry !== undefined) ||
    project.onDismiss !== undefined;
  const showsSpinner = !failed && project.active !== false;
  return (
    <div
      className="flex items-start gap-2 py-1.5 pl-2 pr-3"
      data-pending-project-row=""
      data-status={project.status}
      data-testid={`sidebar-pending-project-${project.id}`}
    >
      {/* Dashed like the organization project placeholder: "not here yet". */}
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border border-dashed fg-quaternary"
      >
        <FolderIcon className="size-3" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-s fg-primary" title={project.name}>
          {project.name}
        </div>
        <div
          role="status"
          className="break-words text-xs fg-secondary"
          data-testid={`sidebar-pending-project-status-${project.id}`}
        >
          {statusLine}
        </div>
        {hasActions && (
          // The link actions take the size of the copy around them.
          <div className="mt-1 flex items-center gap-3 text-xs">
            {failed && project.onRetry && (
              <Button
                variant="link"
                disabled={project.retrying === true}
                aria-label={`Try again for ${project.name}`}
                data-testid={`sidebar-pending-project-retry-${project.id}`}
                className="shrink-0"
                onClick={project.onRetry}
              >
                Try again
              </Button>
            )}
            {project.onDismiss && (
              <Button
                variant="link"
                aria-label={`Dismiss ${project.name}`}
                data-testid={`sidebar-pending-project-dismiss-${project.id}`}
                className="shrink-0"
                onClick={project.onDismiss}
              >
                Dismiss
              </Button>
            )}
          </div>
        )}
      </div>
      {showsSpinner && (
        <span
          className="mt-0.5 flex shrink-0 items-center"
          data-testid={`sidebar-pending-project-spinner-${project.id}`}
        >
          <LoadingSpinner tone="accent" />
        </span>
      )}
    </div>
  );
}

export function PendingProjectRows({
  projects,
}: {
  readonly projects: readonly SidebarPendingProject[];
}): JSX.Element | null {
  if (projects.length === 0) return null;
  return (
    <>
      {projects.map((project) => (
        <PendingProjectRow key={project.id} project={project} />
      ))}
    </>
  );
}
