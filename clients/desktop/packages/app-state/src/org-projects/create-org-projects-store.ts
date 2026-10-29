import { useCanopyClientStore } from '../CanopyClientProvider';
import { create } from 'zustand';
import type { CanopyClient, Unsubscribe } from '@canopy/app-core';
import type {
  OrgProjectCatalogSnapshot,
  OrgProjectPreference,
  OrgProjectSetupProgress,
  OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import { isOrgProjectPlaceholder } from '@canopy/protocol/org-projects';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  CLIENT_STORE_ACTIVATE,
  CLIENT_STORE_DISPOSE,
  type ClientStore,
} from '../create-client-store';

/**
 * The listing rule from plan chapter 02, applied client-side only to keep an
 * optimistic preference change consistent until the server's `listed` arrives:
 * `listed = use AND (ADDED OR (FOLLOW_DEFAULTS AND defaultListed))`.
 * ADMINISTER never implies USE, so it plays no part here.
 */
export function computeOrgProjectListed(
  project: Pick<OrgProjectSummary, 'capabilities' | 'defaultListed'>,
  preference: OrgProjectPreference,
): boolean {
  if (!project.capabilities.use) {
    return false;
  }
  return (
    preference === 'ADDED' ||
    (preference === 'FOLLOW_DEFAULTS' && project.defaultListed)
  );
}

/**
 * The shared organization-projects catalog store (CAN-2944). One snapshot per
 * serialized workspace context, refreshed from the host on demand and whenever
 * `org-projects.changed` names that context. Setup progress is held per
 * project so a placeholder row can render its state without a re-query.
 */
export interface OrgProjectsStoreState {
  /** Catalog snapshots keyed by serialized context (`personal`, `org:<uuid>`). */
  readonly snapshots: Readonly<Record<string, OrgProjectCatalogSnapshot>>;
  /**
   * Incremented on every account change, which also clears every snapshot.
   * Readers that load a context from an effect must depend on it: a new
   * account can select the same organization, and then nothing else in their
   * inputs changes while the data underneath them is gone.
   */
  readonly accountEpoch: number;
  readonly loading: Readonly<Record<string, boolean>>;
  readonly errors: Readonly<Record<string, string>>;
  /** Latest setup report per project id, on this device. */
  readonly setupProgress: Readonly<Record<string, OrgProjectSetupProgress>>;
  readonly setupRequest: {
    readonly organizationId: string;
    readonly projectId: string;
  } | null;
  readonly requestSetup: (organizationId: string, projectId: string) => void;
  readonly clearSetupRequest: () => void;
  /**
   * Query the host for one context; concurrent loads of a context coalesce.
   * `repositories` (with `refresh`) first re-reads the organization's
   * repositories from GitHub (CAN-3489).
   */
  readonly load: (
    context: WorkspaceContext,
    options?: { readonly refresh?: boolean; readonly repositories?: boolean },
  ) => Promise<void>;
  /**
   * Optimistically update the row, send the command, and roll back on
   * failure (the rejection is re-thrown so the UI can say so).
   */
  readonly setPreference: (
    context: WorkspaceContext,
    projectId: string,
    preference: OrgProjectPreference,
  ) => Promise<void>;
  /** `destinationRoot` is omitted for Cowork projects, which clone nothing. */
  readonly startSetup: (
    projectId: string,
    destinationRoot?: string,
  ) => Promise<void>;
  readonly cancelSetup: (projectId: string) => Promise<void>;
  readonly applySnapshot: (snapshot: OrgProjectCatalogSnapshot) => void;
  readonly applySetupProgress: (progress: OrgProjectSetupProgress) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withoutKey<T>(
  record: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (!(key in record)) {
    return record;
  }
  const next: Record<string, T> = { ...record };
  delete next[key];
  return next;
}

function patchProject(
  snapshot: OrgProjectCatalogSnapshot,
  projectId: string,
  patch: (project: OrgProjectSummary) => OrgProjectSummary,
): OrgProjectCatalogSnapshot {
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) =>
      project.id === projectId ? patch(project) : project,
    ),
  };
}

export function createOrgProjectsStore(
  client: CanopyClient,
): ClientStore<OrgProjectsStoreState> {
  let accountEpoch = 0;
  const requestGenerations = new Map<string, number>();
  const mutationGenerations = new Map<string, number>();
  const snapshotGenerations = new Map<string, number>();
  // Optimistic rows must never become the rollback baseline for another write.
  const confirmedPreferences = new Map<
    string,
    Map<string, OrgProjectPreference>
  >();
  const optimisticGenerations = new Map<string, number>();
  const inFlight = new Map<string, Promise<void>>();

  const store: ClientStore<OrgProjectsStoreState> =
    create<OrgProjectsStoreState>((set, get) => ({
      snapshots: {},
      loading: {},
      errors: {},
      setupProgress: {},
      accountEpoch: 0,
      setupRequest: null,
      requestSetup: (organizationId, projectId): void => {
        set({ setupRequest: { organizationId, projectId } });
      },
      clearSetupRequest: (): void => {
        set({ setupRequest: null });
      },
      applySnapshot: (snapshot): void => {
        confirmedPreferences.set(
          snapshot.context,
          new Map(
            snapshot.projects.map((project) => [
              project.id,
              project.preference,
            ]),
          ),
        );
        snapshotGenerations.set(
          snapshot.context,
          (snapshotGenerations.get(snapshot.context) ?? 0) + 1,
        );
        set((state) => ({
          snapshots: { ...state.snapshots, [snapshot.context]: snapshot },
          errors: withoutKey(state.errors, snapshot.context),
        }));
      },
      applySetupProgress: (progress): void => {
        set((state) => ({
          setupProgress: {
            ...state.setupProgress,
            [progress.projectId]: progress,
          },
        }));
      },
      load: (context, options): Promise<void> => {
        const key = serializeWorkspaceContext(context);
        const pending = inFlight.get(key);
        if (pending !== undefined && options?.refresh !== true) {
          return pending;
        }
        const epoch = accountEpoch;
        const generation = (requestGenerations.get(key) ?? 0) + 1;
        requestGenerations.set(key, generation);
        const isCurrent = (): boolean =>
          accountEpoch === epoch && requestGenerations.get(key) === generation;
        const run = (async (): Promise<void> => {
          set((state) => ({ loading: { ...state.loading, [key]: true } }));
          try {
            const snapshot = await client.query('orgProjects.catalog', {
              context,
              ...(options?.refresh === true ? { refresh: true } : {}),
              ...(options?.refresh === true && options.repositories === true
                ? { repositories: true }
                : {}),
            });
            if (isCurrent()) {
              get().applySnapshot(snapshot);
            }
          } catch (error) {
            if (isCurrent()) {
              set((state) => ({
                errors: { ...state.errors, [key]: errorMessage(error) },
              }));
            }
          } finally {
            if (isCurrent()) {
              inFlight.delete(key);
              set((state) => ({ loading: withoutKey(state.loading, key) }));
            }
          }
        })();
        inFlight.set(key, run);
        return run;
      },
      setPreference: async (context, projectId, preference): Promise<void> => {
        const key = serializeWorkspaceContext(context);
        const epoch = accountEpoch;
        const mutationKey = JSON.stringify([key, projectId]);
        const snapshotGeneration = snapshotGenerations.get(key);
        const generation = (mutationGenerations.get(mutationKey) ?? 0) + 1;
        mutationGenerations.set(mutationKey, generation);
        optimisticGenerations.set(mutationKey, generation);
        const before = get().snapshots[key];
        if (before !== undefined) {
          set((state) => ({
            snapshots: {
              ...state.snapshots,
              [key]: patchProject(before, projectId, (project) => ({
                ...project,
                preference,
                listed: computeOrgProjectListed(project, preference),
              })),
            },
          }));
        }
        try {
          await client.command('orgProjects.setPreference', {
            projectId,
            preference,
          });
          if (
            accountEpoch === epoch &&
            snapshotGenerations.get(key) === snapshotGeneration
          ) {
            const confirmed =
              confirmedPreferences.get(key) ??
              new Map<string, OrgProjectPreference>();
            confirmed.set(projectId, preference);
            confirmedPreferences.set(key, confirmed);
            const optimisticGeneration = optimisticGenerations.get(mutationKey);
            const current = get().snapshots[key];
            if (
              (optimisticGeneration === generation ||
                optimisticGeneration === undefined) &&
              current !== undefined
            ) {
              optimisticGenerations.delete(mutationKey);
              set((state) => ({
                snapshots: {
                  ...state.snapshots,
                  [key]: patchProject(current, projectId, (project) => ({
                    ...project,
                    preference,
                    listed: computeOrgProjectListed(project, preference),
                  })),
                },
              }));
            }
          }
        } catch (error) {
          const current = get().snapshots[key];
          const confirmed = confirmedPreferences.get(key)?.get(projectId);
          if (
            accountEpoch === epoch &&
            mutationGenerations.get(mutationKey) === generation &&
            snapshotGenerations.get(key) === snapshotGeneration
          ) {
            optimisticGenerations.delete(mutationKey);
            if (confirmed === undefined) {
              void get().load(context, { refresh: true });
            } else if (current !== undefined) {
              set((state) => ({
                snapshots: {
                  ...state.snapshots,
                  [key]: patchProject(current, projectId, (project) => ({
                    ...project,
                    preference: confirmed,
                    listed: computeOrgProjectListed(project, confirmed),
                  })),
                },
              }));
            }
          }
          throw error;
        }
      },
      startSetup: async (projectId, destinationRoot): Promise<void> => {
        const epoch = accountEpoch;
        const progress = await client.command('orgProjects.setupStart', {
          projectId,
          destinationRoot,
        });
        if (accountEpoch === epoch) {
          get().applySetupProgress(progress);
        }
      },
      cancelSetup: async (projectId): Promise<void> => {
        await client.command('orgProjects.setupCancel', { projectId });
      },
    }));

  const unsubscribes: Unsubscribe[] = [];
  store[CLIENT_STORE_ACTIVATE] = (): void => {
    for (const unsubscribe of unsubscribes.splice(0)) {
      unsubscribe();
    }
    unsubscribes.push(
      client.subscribe('workspace-context.changed', (event) => {
        if (event.reason === 'departed' || event.reason === 'organizations') {
          const organizations = new Set(
            event.state.organizations.map(
              (organization) => `org:${organization.id}`,
            ),
          );
          const state = store.getState();
          const keys = new Set([
            ...Object.keys(state.snapshots),
            ...Array.from(requestGenerations.keys()),
          ]);
          let { snapshots, loading, errors, setupProgress } = state;
          for (const key of Array.from(keys)) {
            if (!key.startsWith('org:') || organizations.has(key)) {
              continue;
            }
            requestGenerations.set(key, (requestGenerations.get(key) ?? 0) + 1);
            snapshotGenerations.set(
              key,
              (snapshotGenerations.get(key) ?? 0) + 1,
            );
            inFlight.delete(key);
            confirmedPreferences.delete(key);
            for (const project of snapshots[key]?.projects ?? []) {
              optimisticGenerations.delete(JSON.stringify([key, project.id]));
              setupProgress = withoutKey(setupProgress, project.id);
            }
            snapshots = withoutKey(snapshots, key);
            loading = withoutKey(loading, key);
            errors = withoutKey(errors, key);
          }
          store.setState({ snapshots, loading, errors, setupProgress });
          return;
        }
        if (event.reason !== 'account-change') {
          return;
        }
        accountEpoch += 1;
        inFlight.clear();
        requestGenerations.clear();
        mutationGenerations.clear();
        snapshotGenerations.clear();
        confirmedPreferences.clear();
        optimisticGenerations.clear();
        store.setState({
          accountEpoch,
          setupRequest: null,
          snapshots: {},
          loading: {},
          errors: {},
          setupProgress: {},
        });
      }),
      client.subscribe('org-projects.changed', (event) => {
        const key = serializeWorkspaceContext(event.context);
        if (key in store.getState().snapshots) {
          void store.getState().load(event.context, { refresh: true });
        }
      }),
      client.subscribe('org-projects.setup-progress', (event) => {
        store.getState().applySetupProgress(event.progress);
      }),
    );
  };
  store[CLIENT_STORE_DISPOSE] = (): void => {
    for (const unsubscribe of unsubscribes.splice(0)) {
      unsubscribe();
    }
  };
  return store;
}

const orgProjectsStoreKey = Symbol('org-projects-store');

export function useOrgProjectsStoreApi(): ClientStore<OrgProjectsStoreState> {
  return useCanopyClientStore(orgProjectsStoreKey, createOrgProjectsStore);
}

export function useOrgProjectsStore<TSelected>(
  selector: (state: OrgProjectsStoreState) => TSelected,
): TSelected {
  return useOrgProjectsStoreApi()(selector);
}

/** The snapshot for a context, or `null` before its first successful load. */
export function selectCatalogSnapshot(
  state: OrgProjectsStoreState,
  context: WorkspaceContext,
): OrgProjectCatalogSnapshot | null {
  return state.snapshots[serializeWorkspaceContext(context)] ?? null;
}

/** Active projects the server lists for the caller in this context. */
export function selectListedProjects(
  state: OrgProjectsStoreState,
  context: WorkspaceContext,
): OrgProjectSummary[] {
  const snapshot = selectCatalogSnapshot(state, context);
  if (snapshot === null) {
    return [];
  }
  return snapshot.projects.filter(
    (project) => project.listed && project.state === 'ACTIVE',
  );
}

/**
 * Listed projects with no ready instance on this device: the sidebar renders
 * them as placeholder rows that offer setup instead of opening.
 */
export function selectPlaceholderRows(
  state: OrgProjectsStoreState,
  context: WorkspaceContext,
): OrgProjectSummary[] {
  // Shared with main's relationship resolver so the two cannot drift apart.
  return selectListedProjects(state, context).filter(isOrgProjectPlaceholder);
}

export function selectSetupProgress(
  state: OrgProjectsStoreState,
  projectId: string,
): OrgProjectSetupProgress | null {
  return state.setupProgress[projectId] ?? null;
}

export function selectCatalogLoading(
  state: OrgProjectsStoreState,
  context: WorkspaceContext,
): boolean {
  return state.loading[serializeWorkspaceContext(context)] === true;
}

export function selectCatalogError(
  state: OrgProjectsStoreState,
  context: WorkspaceContext,
): string | null {
  return state.errors[serializeWorkspaceContext(context)] ?? null;
}
