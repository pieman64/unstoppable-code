import type { JSX, KeyboardEvent, MouseEvent } from 'react';
import type { Notification } from '@/stores/githubStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { EmptyState } from '@/components/shared/StatusBlocks';
import { formatRelativeTime } from '@/lib/format';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { Tooltip } from '@canopy/ui-shared';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { openInWorkspaceContext } from '@/lib/contextScope';
import { toastMessageReplayClass } from '@/lib/replayPrivacy';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { CloseIcon as AppCatalogCloseIcon } from '@canopy/ui-shared/icons/AppIcons';

function badgeClasses(type: Notification['type']): string {
  switch (type) {
    case 'error':
      return 'border-line-destructive/40 bg-destructive-subtle fg-destructive';
    case 'success':
      return 'border-line-positive/40 bg-success-subtle fg-success';
    case 'warning':
      return 'border-line-attention/40 bg-warning-subtle fg-warning';
    default:
      return 'border-fg-info/40 bg-info-subtle fg-info';
  }
}

function badgeLabel(notification: Notification): string {
  return notification.meta?.category ?? typeLabel(notification.type);
}

function typeLabel(type: Notification['type']): string {
  switch (type) {
    case 'error':
      return 'Error';
    case 'success':
      return 'Success';
    case 'warning':
      return 'Warning';
    default:
      return 'Info';
  }
}

export function NotificationsPanel({
  showAllContexts = false,
}: {
  showAllContexts?: boolean;
}): JSX.Element {
  const notifications = useGitHubStore((state) => state.notifications);
  const { isInContext } = useContextScopedWorkspaces();
  const dismissNotification = useGitHubStore(
    (state) => state.dismissNotification,
  );
  const visibleNotifications = notifications.filter(
    (notification) =>
      showAllContexts ||
      notification.meta?.projectId === undefined ||
      isInContext(notification.meta.projectId),
  );

  if (visibleNotifications.length === 0) {
    return (
      <EmptyState
        title="No notifications"
        subtitle="Recent messages you haven't dismissed yet will appear here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {visibleNotifications.map((notification) => (
        <NotificationCard
          key={notification.id}
          notification={notification}
          onDismiss={(): void => dismissNotification(notification.id)}
        />
      ))}
    </div>
  );
}

function NotificationCard({
  notification,
  onDismiss,
}: {
  notification: Notification;
  onDismiss: () => void;
}): JSX.Element {
  const meta = notification.meta;
  const projects = useProjectsStore((state) => state.projects);
  const hasHydratedProjects = useProjectsStore(
    (state) => state.hasHydratedProjects,
  );
  const projectId = meta?.projectId;
  const worktreeId = meta?.worktreeId;
  const hasWorktreeTarget = projectId !== undefined && worktreeId !== undefined;
  const canNavigateToWorktree =
    hasWorktreeTarget &&
    canNavigateToWorktreeFromSidebarItems(
      projects,
      projectId,
      worktreeId,
      hasHydratedProjects,
    );
  const clickable = hasWorktreeTarget
    ? canNavigateToWorktree
    : Boolean(notification.onClick);

  const activate = (): void => {
    if (
      projectId !== undefined &&
      worktreeId !== undefined &&
      !canNavigateToWorktreeFromSidebarItems(
        useProjectsStore.getState().projects,
        projectId,
        worktreeId,
        useProjectsStore.getState().hasHydratedProjects,
      )
    ) {
      return;
    }

    const open = (): void => {
      if (notification.onClick) {
        notification.onClick();
      } else if (projectId !== undefined && worktreeId !== undefined) {
        useNavigationStore.getState().navigate('main');
        useChatStore.getState().selectWorktree(projectId, worktreeId);
      }
      onDismiss();
    };
    if (projectId !== undefined) {
      openInWorkspaceContext(projectId, open);
    } else {
      open();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!clickable || event.currentTarget !== event.target) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  };

  const handleDismissClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    onDismiss();
  };

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? activate : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      data-testid="overview-notification-card"
      data-project-id={projectId}
      data-worktree-id={worktreeId}
      className={`w-full text-left rounded-md border bg-card transition-colors duration-150 focus-ring px-3 py-2.5 flex flex-col gap-1.5 ${
        clickable ? 'cursor-pointer hover:bg-secondary/40' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-3xs font-medium ${badgeClasses(notification.type)}`}
        >
          {badgeLabel(notification)}
        </span>
        <div className="min-w-0 flex-1 text-2xs font-mono fg-secondary truncate">
          <span className={POSTHOG_REPLAY_MASK_CLASS}>
            {meta?.workspaceName ?? ''}
          </span>
          {meta?.workspaceName && meta?.worktreeId && (
            <span className="mx-1 opacity-60">·</span>
          )}
          {meta?.worktreeId && (
            <span className={`${POSTHOG_REPLAY_MASK_CLASS} fg-primary/80`}>
              {meta.worktreeId}
            </span>
          )}
        </div>
        <span className="shrink-0 text-3xs fg-secondary/80">
          {formatRelativeTime(new Date(notification.createdAt).toISOString())}
        </span>
        <Tooltip label="Dismiss notification">
          <button
            type="button"
            onClick={handleDismissClick}
            aria-label="Dismiss notification"
            data-testid="overview-notification-dismiss"
            className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded fg-secondary hover:bg-secondary hover:fg-primary transition-colors focus-ring"
          >
            <AppCatalogCloseIcon width="14" height="14" aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div
        className={`text-xs fg-secondary line-clamp-3 whitespace-pre-line ${toastMessageReplayClass(notification.type, notification.meta?.category, notification.meta?.blockMessageFromReplay)}`}
      >
        {notification.message}
      </div>
    </div>
  );
}
