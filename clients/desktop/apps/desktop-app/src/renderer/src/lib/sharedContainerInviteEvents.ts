import type { SharedContainerType } from '@canopy/protocol/shared-containers';
import type { SharedContainerInviteAudience } from '@canopy/desktop-shared/types';

export const OPEN_SHARED_CONTAINER_INVITE_EVENT =
  'canopy:shared-container-invite-open';
const EXCLUSIVE_SHARED_CONTAINER_INVITE_EVENT =
  'canopy:shared-container-invite-exclusive';

export interface SharedContainerInviteRequest {
  projectId: string;
  worktreeId: string;
  containerType: SharedContainerType;
  /** Audience to preselect when the modal opens (App Advisor). */
  audience?: SharedContainerInviteAudience;
}

/**
 * The audience a request asked for, held until the modal for that target
 * mounts and reads it. The hosts that render the modal only carry the target,
 * so the preselection travels beside them instead of through every host.
 */
let requestedInviteAudience: {
  projectId: string;
  worktreeId: string;
  audience: SharedContainerInviteAudience;
} | null = null;

/** Read and clear the audience requested for this target, if any. */
export function consumeRequestedSharedContainerInviteAudience(
  projectId: string,
  worktreeId: string,
): SharedContainerInviteAudience | undefined {
  const requested = requestedInviteAudience;
  if (
    !requested ||
    requested.projectId !== projectId ||
    requested.worktreeId !== worktreeId
  ) {
    return undefined;
  }
  requestedInviteAudience = null;
  return requested.audience;
}

function isSharedContainerInviteRequest(
  value: unknown,
): value is SharedContainerInviteRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'worktreeId' in value &&
    typeof value.worktreeId === 'string' &&
    'containerType' in value &&
    (value.containerType === 'CODE_WORKTREE' ||
      value.containerType === 'COWORK_WORK_ENTRY') &&
    (!('audience' in value) ||
      value.audience === undefined ||
      value.audience === 'team' ||
      value.audience === 'organization' ||
      value.audience === 'public')
  );
}

export function requestSharedContainerInvite(
  request: SharedContainerInviteRequest,
): boolean {
  requestedInviteAudience = request.audience
    ? {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        audience: request.audience,
      }
    : null;
  const handled = !window.dispatchEvent(
    new CustomEvent(OPEN_SHARED_CONTAINER_INVITE_EVENT, {
      detail: request,
      cancelable: true,
    }),
  );
  if (!handled) requestedInviteAudience = null;
  if (handled) {
    window.dispatchEvent(
      new CustomEvent(EXCLUSIVE_SHARED_CONTAINER_INVITE_EVENT, {
        detail: request,
      }),
    );
  }
  return handled;
}

export function subscribeToSharedContainerInviteRequests(
  listener: (request: SharedContainerInviteRequest) => boolean,
  onExclusiveRequest: (request: SharedContainerInviteRequest) => void,
): () => void {
  const handleOpen = (event: Event): void => {
    if (event.defaultPrevented || !(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (isSharedContainerInviteRequest(detail) && listener(detail)) {
      event.preventDefault();
    }
  };
  const handleExclusive = (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (isSharedContainerInviteRequest(detail)) {
      onExclusiveRequest(detail);
    }
  };
  window.addEventListener(OPEN_SHARED_CONTAINER_INVITE_EVENT, handleOpen);
  window.addEventListener(
    EXCLUSIVE_SHARED_CONTAINER_INVITE_EVENT,
    handleExclusive,
  );
  return () => {
    window.removeEventListener(OPEN_SHARED_CONTAINER_INVITE_EVENT, handleOpen);
    window.removeEventListener(
      EXCLUSIVE_SHARED_CONTAINER_INVITE_EVENT,
      handleExclusive,
    );
  };
}
