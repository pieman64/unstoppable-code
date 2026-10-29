import { readPersonalProjectConversionPolicy } from '../canopy-cloud/personal-organization-upgrade';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import { getFeatureFlagService } from '../feature-flags';
import { getObservabilityService } from '../observability';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { getRemoteUrlStrict } from '../lib/git';
import { getOrgProjectMaterialization } from '../lib/org-project-materialization';
import { createOrgProjectMigrationPassStore } from '../lib/org-project-migration-passes';
import { getOrgProjectMigrationPassesFilePath } from '../lib/paths';
import { readAllSidebarItemsSnapshot } from '../lib/sidebar-items';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import { readWorkspaceOwnership } from '../lib/workspace-persistence';
import { getOrgProjectCatalogService } from './org-project-catalog-service';
import {
  createOrgProjectAutoConversion,
  type OrgProjectAutoConversion,
  type OrgProjectAutoConversionDeps,
  type OrgProjectAutoConversionEvent,
  type OrgProjectAutoConversionWorkspaces,
  type OrgProjectMigrationPassEvent,
} from './org-project-auto-conversion';

let service: OrgProjectAutoConversion | null = null;
let unsubscribers: Array<() => void> = [];

/**
 * E2E builds only: `CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT=off` keeps specs that
 * exercise the manual relationship and conversion flows deterministic.
 * Production builds ignore the variable.
 */
function allowedInThisBuild(): boolean {
  return !(
    __CANOPY_E2E__ && process.env.CANOPY_E2E_ORG_PROJECT_AUTO_CONVERT === 'off'
  );
}

function enabled(): boolean {
  return (
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
    ) && allowedInThisBuild()
  );
}

function record(event: OrgProjectAutoConversionEvent): void {
  getObservabilityService().recordSessionDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'org_project_auto_conversion',
    sessionKey: 'org-project-auto-conversion',
    // Tied to one workspace, so it belongs in session-events, never app-events.
    projectId: event.workspaceId,
    worktreeId: '',
    chatId: '',
    providerType: 'unknown',
    orgProjectAutoConversionOutcome: event.outcome,
    ...(event.outcome === 'converted'
      ? {}
      : { orgProjectAutoConversionReason: event.reason }),
    ...(event.outcome === 'failed'
      ? { orgProjectAutoConversionRetry: event.retry }
      : {}),
    ...(event.organizationId === undefined
      ? {}
      : { orgProjectAutoConversionOrganizationId: event.organizationId }),
    ...(event.projectId === undefined
      ? {}
      : { orgProjectAutoConversionProjectId: event.projectId }),
    ...(event.outcome === 'skipped' && event.organizationCount !== undefined
      ? { orgProjectAutoConversionOrganizationCount: event.organizationCount }
      : {}),
  });
}

/**
 * An organization's one-time pass is not tied to one workspace, so it is an
 * app-level record: organization id and counts only.
 */
function recordPass(event: OrgProjectMigrationPassEvent): void {
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'org_project_migration_pass',
    orgProjectMigrationPassOutcome: event.outcome,
    orgProjectMigrationPassOrganizationId: event.organizationId,
    ...(event.outcome === 'started'
      ? { orgProjectMigrationPassWorkspaceCount: event.workspaceCount }
      : { orgProjectMigrationPassCompletion: event.completion }),
  });
}

function createProductionDeps(): OrgProjectAutoConversionDeps {
  return {
    enabled,
    access: async (): Promise<
      Awaited<ReturnType<OrgProjectAutoConversionDeps['access']>>
    > => {
      try {
        const credentials = await getCanopyCloudCredentials();
        const policy = await readPersonalProjectConversionPolicy(
          credentials.account?.id ?? '',
        );
        return {
          accountId: policy.accountId,
          capabilities: credentials.capabilities,
          organizationIds: policy.organizationIds,
          excludedOrganizationIds: policy.excludedOrganizationIds,
        };
      } catch {
        return { accountId: null, capabilities: [], organizationIds: [] };
      }
    },
    loadCatalog: (organizationId) =>
      getOrgProjectCatalogService().list({
        kind: 'organization',
        organizationId,
      }),
    readWorkspaces: async (): Promise<OrgProjectAutoConversionWorkspaces> => {
      const snapshot = await readAllSidebarItemsSnapshot();
      return {
        items: snapshot.file.items.map((item) => ({
          id: item.id,
          repoPath: item.type === 'single-repo' ? item.repoPath : null,
          // All multi-repo checkouts, including temporary combinations, root first.
          ...(item.type === 'multi-repo'
            ? {
                retired: isRetiredTemporaryWorkspace(item),
                temporary: item.temporary,
                repoPaths: Array.from(
                  new Set(
                    [
                      item.sourceRepoPath,
                      ...item.repos.map((repo): string => repo.repoPath),
                    ].flatMap((path): string[] => (path ? [path] : [])),
                  ),
                ),
              }
            : {}),
          owner: item.owner,
        })),
        // Only a fully readable index lists every workspace a pass must hold.
        indexedIds:
          snapshot.indexAuthority === 'ok' ||
          snapshot.indexAuthority === 'absent'
            ? snapshot.indexedWorkspaceIds
            : null,
      };
    },
    readOwnership: readWorkspaceOwnership,
    readRemoteUrl: getRemoteUrlStrict,
    convert: (request, options) =>
      getOrgProjectMaterialization().convertWorkspace(request, options),
    convertMultiRepo: (request, options) =>
      getOrgProjectMaterialization().convertMultiRepoWorkspace(
        request,
        options,
      ),
    record,
    reportFailure: reportOrgProjectAutoConversionFailure,
    passes: createOrgProjectMigrationPassStore(
      getOrgProjectMigrationPassesFilePath,
    ),
    recordPass,
    now: (): number => Date.now(),
  };
}

/**
 * Start automatic conversion (CAN-3416). Called once after the context and
 * catalog services initialize; it only subscribes and schedules, so it costs
 * startup nothing. With the flag off nothing is scheduled; turning it on
 * later schedules a run through the flag subscription.
 */
export function startOrgProjectAutoConversion(): void {
  if (service) return;
  const current = createOrgProjectAutoConversion(createProductionDeps());
  service = current;
  let lastEnabled = enabled();
  unsubscribers = [
    // Every organization catalog refresh, including the periodic one.
    getOrgProjectCatalogService().subscribe((snapshot): void => {
      if (snapshot.context.startsWith('org:')) current.trigger();
    }),
    // Sign-in, account change and membership refreshes. A plain context
    // switch changes no membership, and refreshes that context's catalog.
    getWorkspaceContextService().subscribe((state): void => {
      if (state.reason !== 'switch') current.trigger();
    }),
    // Only the rollout flag matters; other flag updates are not triggers.
    getFeatureFlagService().onSnapshotChanged((): void => {
      const next = enabled();
      if (next === lastEnabled) return;
      lastEnabled = next;
      current.trigger();
    }),
  ];
  current.start();
}

/** Best-effort diagnostics must never reject an already committed mutation. */
export function reportOrgProjectAutoConversionFailure(error: unknown): void {
  try {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'startup_background_task_failed',
      reason: 'org_project_auto_conversion',
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // Diagnostics are best effort too.
  }
}

/** Await creation-time binding through the started service's shared queue. */
export async function convertOrgProjectCombinationNow(
  workspaceId: string,
): Promise<OrgProjectAutoConversionEvent | null> {
  try {
    if (!service || !enabled()) return null;
    return await service.convertNow(workspaceId);
  } catch (error) {
    reportOrgProjectAutoConversionFailure(error);
    return null;
  }
}

/** Request a scan after a durable mutation; reuse the existing scheduling policy. */
export function requestOrgProjectAutoConversion(): void {
  try {
    service?.trigger();
  } catch (error) {
    reportOrgProjectAutoConversionFailure(error);
  }
}

/** Test seam. */
export function stopOrgProjectAutoConversionForTests(): void {
  unsubscribers.forEach((unsubscribe): void => {
    unsubscribe();
  });
  unsubscribers = [];
  service?.dispose();
  service = null;
}
