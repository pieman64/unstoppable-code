'use client';

import {
  createContext,
  useContext,
  useMemo,
  type JSX,
  type ReactNode,
} from 'react';
import {
  resourceOwnerContext,
  type ResourceOwner,
} from '@canopy/protocol/resource-owner';
import {
  isOwnerInContext,
  normalizePersonalOrganizationId,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';

interface ResourceContextValue {
  context: WorkspaceContext | undefined;
  personalOrganizationId: string | null;
  /**
   * `false` while the host has not yet learned whether context policy
   * applies. An undefined `context` then means "loading", not "disabled".
   */
  ready: boolean;
}

const ResourceContext = createContext<ResourceContextValue>({
  context: undefined,
  personalOrganizationId: null,
  ready: true,
});

/** Hosts replace this projection from their current authoritative account. */
export function ResourceContextProvider({
  children,
  context,
  personalOrganizationId,
  ready = true,
}: {
  children: ReactNode;
  context: WorkspaceContext | undefined;
  personalOrganizationId: string | null | undefined;
  /** Pass `false` while organization scoping is on but not yet hydrated. */
  ready?: boolean;
}): JSX.Element {
  const kind = context?.kind;
  const organizationId =
    context?.kind === 'organization' ? context.organizationId : null;
  const value = useMemo(
    (): ResourceContextValue => ({
      context:
        kind === 'organization' && organizationId
          ? { kind, organizationId }
          : kind === 'personal'
            ? { kind }
            : undefined,
      personalOrganizationId: normalizePersonalOrganizationId(
        personalOrganizationId,
      ),
      ready,
    }),
    [kind, organizationId, personalOrganizationId, ready],
  );
  return (
    <ResourceContext.Provider value={value}>
      {children}
    </ResourceContext.Provider>
  );
}

export function useResourceContext(): ResourceContextValue {
  return useContext(ResourceContext);
}

export function isResourceOwnerInContext(
  owner: ResourceOwner,
  context: WorkspaceContext | undefined,
  personalOrganizationId: string | null,
): boolean {
  if (context === undefined) return true;
  const ownerContext = resourceOwnerContext(owner);
  if (ownerContext === 'global') return true;
  return isOwnerInContext(
    ownerContext === 'personal'
      ? { kind: 'personal' }
      : { kind: 'organization', organizationId: ownerContext.organizationId },
    context,
    personalOrganizationId,
  );
}
