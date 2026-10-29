import { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_COWORK_WORKSPACE_NAME,
  defaultCoworkWorkspaceIdForContext,
} from '@canopy/protocol/ui-labels';
import type {
  CoworkSidebarItem,
  WorkspaceContext,
} from '@canopy/desktop-shared/types';
import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

const sessionIneligibleOrganizations = new Set<string>();
let sessionAccountEpoch = 0;

export interface OrgDefaultChatsWorkspaceState {
  readonly workspace: CoworkSidebarItem | undefined;
  readonly pending: boolean;
  readonly eligible: boolean;
}

/**
 * Resolve the context's real Chats workspace or its deterministic first-use
 * placeholder. Main performs the authoritative entitlement check and binding.
 * An ineligible answer hides Chats but is only a hint for the next render, not
 * a latch: the org-projects capability can arrive after the flag (an account
 * refresh), so every workspace-context broadcast re-reads eligibility. Main
 * remembers its own permanent 403/404 refusals, so re-reading is cheap.
 */
export function useOrgDefaultChatsWorkspace(
  context: WorkspaceContext | undefined,
): OrgDefaultChatsWorkspaceState {
  const defaultId = defaultCoworkWorkspaceIdForContext(context);
  const accountEpoch = useWorkspaceContextStore((state) => state.accountEpoch);
  const appliedGeneration = useWorkspaceContextStore(
    (state) => state.appliedGeneration,
  );
  if (accountEpoch !== sessionAccountEpoch) {
    sessionIneligibleOrganizations.clear();
    sessionAccountEpoch = accountEpoch;
  }
  const real = useProjectsStore((state) =>
    state.projects.find(
      (project): project is CoworkSidebarItem =>
        project.type === 'cowork' && project.id === defaultId,
    ),
  );
  const [, refreshEligibilityState] = useState(0);
  const knownIneligible =
    context?.kind === 'organization' &&
    sessionIneligibleOrganizations.has(context.organizationId);
  const eligible = context?.kind !== 'organization' || !knownIneligible;

  useEffect(() => {
    if (context?.kind !== 'organization') {
      return;
    }
    const organizationId = context.organizationId;
    let current = true;
    const api = window.api?.chatProject;
    if (!api || typeof api.getOrgDefaultCoworkEligibility !== 'function') {
      return (): void => {
        current = false;
      };
    }
    /** `null` when the read itself failed transiently. */
    const readEligibility = async (): Promise<boolean | null> => {
      try {
        const status = await api.getOrgDefaultCoworkEligibility(organizationId);
        if (!current) return null;
        if (status === 'ineligible') {
          sessionIneligibleOrganizations.add(organizationId);
        } else {
          sessionIneligibleOrganizations.delete(organizationId);
        }
        refreshEligibilityState((revision) => revision + 1);
        return status === 'eligible';
      } catch {
        // A status read is itself transient. Keep the current state and let
        // the next broadcast or list retry.
        return null;
      }
    };
    void (async (): Promise<void> => {
      const isEligible = await readEligibility();
      if (
        !current ||
        isEligible === false ||
        real ||
        typeof api.ensureOrgDefaultCoworkWorkspace !== 'function'
      ) {
        return;
      }
      await api
        .ensureOrgDefaultCoworkWorkspace(organizationId)
        .catch(() => undefined);
      if (current) await readEligibility();
    })();
    return (): void => {
      current = false;
    };
  }, [accountEpoch, appliedGeneration, context, real]);

  const placeholder = useMemo<CoworkSidebarItem | undefined>(() => {
    if (context?.kind !== 'organization' || real || !eligible) return undefined;
    return {
      id: defaultId,
      name: DEFAULT_COWORK_WORKSPACE_NAME,
      type: 'cowork',
      color: PROJECT_COLORS[0],
      collapsed: false,
      order: -1,
      cowork: {
        createdAt: '2025-01-01T00:00:00.000Z',
        archiveRetentionDays: 7,
      },
    };
  }, [context, defaultId, eligible, real]);

  return {
    workspace: eligible ? (real ?? placeholder) : undefined,
    pending: placeholder !== undefined,
    eligible,
  };
}
