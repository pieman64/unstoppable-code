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
 */
export function selectOrganizationWhenListed(organizationId: string): void {
  cancelPending?.();
  const wanted = organizationId.trim().toLowerCase();
  const pending: {
    settled: boolean;
    timeoutId: ReturnType<typeof setTimeout> | undefined;
    unsubscribe: () => void;
  } = { settled: false, timeoutId: undefined, unsubscribe: (): void => {} };
  const finish = (): void => {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timeoutId);
    pending.unsubscribe();
    if (cancelPending === finish) cancelPending = null;
  };
  const attempt = (): void => {
    const { hydrated, state, setContext } = useWorkspaceContextStore.getState();
    const listed = state.organizations.find(
      (organization) => organization.id.toLowerCase() === wanted,
    );
    if (pending.settled || !hydrated || listed === undefined) return;
    finish();
    setContext({ kind: 'organization', organizationId: listed.id }).catch(
      (error: unknown) => {
        reportRendererConsoleError(
          'Failed to select an organization chosen in settings',
          { error },
        );
      },
    );
  };
  cancelPending = finish;
  pending.timeoutId = setTimeout(finish, LISTING_TIMEOUT_MS);
  pending.unsubscribe = useWorkspaceContextStore.subscribe(attempt);
  attempt();
}
