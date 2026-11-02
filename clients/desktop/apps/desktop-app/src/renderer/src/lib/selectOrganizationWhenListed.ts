import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { reportRendererConsoleError } from './renderer-error-logging';

/** How long a request waits for main to list the organization. */
const LISTING_TIMEOUT_MS = 15_000;

let cancelPending: (() => void) | null = null;

/**
 * Select an organization in the workspace context as soon as main lists it
 * as a membership, e.g. one settings just created or joined. Main refuses a
 * context it does not list, and this window may apply main's membership
 * broadcast a moment after the settings write resolves, so the switch waits
 * for it. A later request replaces an earlier one; a request never listed
 * within the timeout is dropped.
 *
 * `onSettled`, when given, hears once whether the organization ended up
 * selected: `false` for a timeout, a replacing request, or a refused switch.
 */
export function selectOrganizationWhenListed(
  organizationId: string,
  onSettled?: (selected: boolean) => void,
  signal?: AbortSignal,
): void {
  cancelPending?.();
  const wanted = organizationId.trim().toLowerCase();
  const pending: {
    settled: boolean;
    selecting: boolean;
    timeoutId: ReturnType<typeof setTimeout> | undefined;
    unsubscribe: () => void;
  } = {
    settled: false,
    selecting: false,
    timeoutId: undefined,
    unsubscribe: (): void => {},
  };
  const finish = (): boolean => {
    if (pending.settled) return false;
    pending.settled = true;
    clearTimeout(pending.timeoutId);
    pending.unsubscribe();
    signal?.removeEventListener('abort', drop);
    if (cancelPending === drop) cancelPending = null;
    return true;
  };
  const drop = (): void => {
    if (finish()) onSettled?.(false);
  };
  const attempt = (): void => {
    const { hydrated, state, setContext } = useWorkspaceContextStore.getState();
    const listed = state.organizations.find(
      (organization) => organization.id.toLowerCase() === wanted,
    );
    if (
      pending.settled ||
      pending.selecting ||
      !hydrated ||
      listed === undefined
    )
      return;
    pending.selecting = true;
    setContext({ kind: 'organization', organizationId: listed.id }).then(
      (next) => {
        if (finish())
          onSettled?.(
            next.context.kind === 'organization' &&
              next.context.organizationId === listed.id,
          );
      },
      (error: unknown) => {
        reportRendererConsoleError(
          'Failed to select an organization chosen in settings',
          { error },
        );
        if (finish()) onSettled?.(false);
      },
    );
  };
  cancelPending = drop;
  pending.timeoutId = setTimeout(drop, LISTING_TIMEOUT_MS);
  pending.unsubscribe = useWorkspaceContextStore.subscribe(attempt);
  signal?.addEventListener('abort', drop);
  if (signal?.aborted) drop();
  else attempt();
}
