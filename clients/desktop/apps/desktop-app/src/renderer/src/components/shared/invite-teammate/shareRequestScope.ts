import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { PERSONAL_SHARE_OWNER_KEY } from '@/stores/sharedContainersStore';

/**
 * The modal keys every request by the container's *owner*: an organization id,
 * or {@link PERSONAL_SHARE_OWNER_KEY} for a personal container that no
 * organization owns (a Public share by someone without a fixed organization).
 * Switching owner invalidates everything in flight exactly as an organization
 * switch always has.
 */
export { PERSONAL_SHARE_OWNER_KEY };

/** The `organizationId` a request carries for an owner key. */
export function organizationIdForOwnerKey(
  ownerKey: string,
): string | undefined {
  return ownerKey === '' || ownerKey === PERSONAL_SHARE_OWNER_KEY
    ? undefined
    : ownerKey;
}

/**
 * The optional `organizationId` field a request carries for an owner key.
 * Omitted, never sent empty, for a personal container.
 */
export function organizationFieldsForOwnerKey(ownerKey: string): {
  organizationId?: string;
} {
  const organizationId = organizationIdForOwnerKey(ownerKey);
  return organizationId ? { organizationId } : {};
}

/** The owner key for a container owned by `organizationId` (or nobody). */
export function ownerKeyForOrganizationId(
  organizationId: string | undefined,
): string {
  return organizationId ?? PERSONAL_SHARE_OWNER_KEY;
}

/**
 * The race guards shared by every request the invite flow makes.
 *
 * These exist because the modal re-fires its whole request set on every
 * organization switch, and a response from the previous organization can
 * settle after the switch. Splitting the modal into hooks moved each request's
 * own ordering ref into the hook that owns it, but the two *cross-hook* facts
 * cannot live in any one hook:
 *
 * - `cancelledRef` - the modal unmounted; nothing may call `setState`.
 * - `activeOrganizationIdRef` - which organization the user is now looking at.
 *   It is a ref, not state, precisely so `selectOrganization` can invalidate
 *   every in-flight request *synchronously* at the click, closing the window
 *   between the state update and the effects that would otherwise re-key.
 *
 * A hook launches a request with the organization id it read, then calls
 * `isStale(thatId)` before touching state. Combined with each hook's own
 * incrementing request id (which orders requests *within* one organization),
 * that is the same guarantee the pre-split refs gave.
 */
export interface ShareRequestScope {
  cancelledRef: MutableRefObject<boolean>;
  /** The active owner key (see {@link organizationIdForOwnerKey}). */
  activeOrganizationIdRef: MutableRefObject<string>;
  /** True when a response launched for this owner key is no longer wanted. */
  isStale: (organizationId: string) => boolean;
  /** Synchronously retarget the scope, invalidating everything in flight. */
  setActiveOrganizationId: (organizationId: string) => void;
}

export function useShareRequestScope(
  organizationId: string,
): ShareRequestScope {
  const cancelledRef = useRef(false);
  const activeOrganizationIdRef = useRef(organizationId);

  useEffect(() => {
    cancelledRef.current = false;
    return (): void => {
      cancelledRef.current = true;
    };
  }, []);

  // Keeps the ref honest when the id changes through a path other than
  // `setActiveOrganizationId` (the initial default, or an organization list
  // that changed underneath the modal).
  useEffect(() => {
    activeOrganizationIdRef.current = organizationId;
  }, [organizationId]);

  const isStale = useCallback(
    (requestOrganizationId: string): boolean =>
      cancelledRef.current ||
      activeOrganizationIdRef.current !== requestOrganizationId,
    [],
  );

  const setActiveOrganizationId = useCallback(
    (nextOrganizationId: string): void => {
      activeOrganizationIdRef.current = nextOrganizationId;
    },
    [],
  );

  // Stable identity is mandatory, not an optimization: this object sits in the
  // dependency array of every request effect in the flow, so a fresh literal
  // per render would re-fire all of them on every render.
  return useMemo(
    () => ({
      cancelledRef,
      activeOrganizationIdRef,
      isStale,
      setActiveOrganizationId,
    }),
    [isStale, setActiveOrganizationId],
  );
}
