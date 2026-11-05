import { useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { LedgerScopeNames } from '@canopy/ui-app/ledger';
import type { LedgerViewScope } from '@canopy/protocol/ledger-view';
import {
  describeLedgerScope,
  type LedgerFeedScopeSources,
} from '@/lib/ledger/ledger-feed-scopes';
import { useProjectsStore } from '@/stores/projectsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

export interface LedgerScopeNaming {
  readonly sources: LedgerFeedScopeSources;
  /** "Project · Task", or null when this device doesn't list the scope. */
  readonly describeScope: (scope: LedgerViewScope) => string | null;
  readonly scopeNames: (scope: LedgerViewScope) => LedgerScopeNames | null;
}

/** This device's project and task names for Feed scopes, page and panel. */
export function useLedgerScopeNames(): LedgerScopeNaming {
  const projects = useProjectsStore((state) => state.projects);
  const organizations = useWorkspaceContextStore(
    (state) => state.state.organizations,
  );
  const { workEntries, activeChatProjectId, sidebarEntriesByProject } =
    useStandaloneChatStore(
      useShallow((state) => ({
        workEntries: state.workEntries,
        activeChatProjectId: state.activeChatProjectId,
        sidebarEntriesByProject: state.sidebarEntriesByProject,
      })),
    );
  const sources = useMemo(
    (): LedgerFeedScopeSources => ({
      projects,
      coworkEntries: {
        ...sidebarEntriesByProject,
        [activeChatProjectId]: workEntries,
      },
      organizations,
    }),
    [
      projects,
      sidebarEntriesByProject,
      activeChatProjectId,
      workEntries,
      organizations,
    ],
  );
  const describeScope = useCallback(
    (scope: LedgerViewScope): string | null =>
      describeLedgerScope(scope, sources),
    [sources],
  );
  const scopeNames = useCallback(
    (scope: LedgerViewScope): LedgerScopeNames | null => {
      const name = describeLedgerScope(scope, sources);
      if (name === null) return null;
      const separator = name.lastIndexOf(' · ');
      return separator === -1
        ? { projectName: name, taskName: null }
        : {
            projectName: name.slice(0, separator),
            taskName: name.slice(separator + 3),
          };
    },
    [sources],
  );
  return { sources, describeScope, scopeNames };
}
