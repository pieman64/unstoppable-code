import type {
  FeedbackArea,
  FeedbackContextSnapshot,
  FeedbackPrepareRequest,
  FeedbackDiagnosticsPrepareRequest,
} from '@canopy/desktop-shared/types';

/**
 * Maps the auto-captured UI context onto a {@link FeedbackPrepareRequest} so the
 * existing diagnostics collectors run unchanged. The mapping is best-effort:
 * core diagnostics are always included regardless of the resolved area.
 */
export function buildFeedbackPrepareRequest(
  request: FeedbackDiagnosticsPrepareRequest,
  description = '',
): FeedbackPrepareRequest {
  const context = request.context;
  const area = mapContextToArea(context);

  if (
    area === 'worktrees' &&
    isNonEmptyString(context.workspaceId) &&
    isNonEmptyString(context.worktreeId)
  ) {
    return {
      ...(request.error ? { error: request.error } : {}),
      description,
      area,
      workspaceSelections: [
        {
          workspaceId: context.workspaceId,
          worktreeIds: [context.worktreeId],
        },
      ],
      includeChatDetails: true,
    };
  }

  if (area === 'chat' && isNonEmptyString(context.chatProjectId)) {
    return {
      ...(request.error ? { error: request.error } : {}),
      description,
      area,
      chatProjectIds: [context.chatProjectId],
      includeChatDetails: true,
    };
  }

  return {
    description,
    area,
    ...(request.error ? { error: request.error } : {}),
  };
}

function mapContextToArea(context: FeedbackContextSnapshot): FeedbackArea {
  switch (context.activePage) {
    case 'pipelines':
    case 'workflows-library':
      return 'pipelines';
    case 'plugins':
      return 'plugins';
    case 'audit':
    case 'audit-trail':
      return 'audit-trail';
    case 'usage':
      return 'usage';
    case 'settings':
      return 'settings';
    case 'chat':
      return 'chat';
    case 'main':
      return isNonEmptyString(context.worktreeId) ? 'worktrees' : 'overview';
    default:
      return 'overview';
  }
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}
