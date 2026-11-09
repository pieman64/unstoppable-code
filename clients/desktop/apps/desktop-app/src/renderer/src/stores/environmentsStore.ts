import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import { create } from 'zustand';
import {
  isStoredSecretValue,
  type EnvironmentConfigView,
  type LoadEnvironmentConfigResponse,
  type SaveEnvironmentConfigResponse,
} from '@canopy/desktop-shared/types';

export type EnvironmentsStoreStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'saving'
  | 'error';

interface PendingEnvironmentSave {
  kind: 'environment' | 'workspaceAssignments';
  data: EnvironmentConfigView;
  dataVersion: number;
  preserveLocal?: boolean;
}

export function environmentEditorBaseline(data: EnvironmentConfigView): string {
  return JSON.stringify({
    environments: data.environments,
    globalRuntimes: data.globalRuntimes,
  });
}

/**
 * A save can rename a kept secret, which gives it a new reference: maps each
 * reference the save submitted to the one it returned for the same
 * environment and key.
 */
function renamedStoredSecretRefs(
  submitted: EnvironmentConfigView,
  saved: EnvironmentConfigView,
): Map<string, string> {
  const savedRefs = new Map<string, string>();
  for (const environment of saved.environments) {
    for (const entry of environment.variables) {
      if (isStoredSecretValue(entry.value))
        savedRefs.set(`${environment.id}\0${entry.key}`, entry.value.ref);
    }
  }
  const renamed = new Map<string, string>();
  for (const environment of submitted.environments) {
    for (const entry of environment.variables) {
      const savedRef = savedRefs.get(`${environment.id}\0${entry.key}`);
      if (isStoredSecretValue(entry.value) && savedRef !== undefined)
        renamed.set(entry.value.ref, savedRef);
    }
  }
  return renamed;
}

/** Points every kept reference in `data` at its current reference. */
function rebaseStoredSecretRefs(
  data: EnvironmentConfigView,
  renamed: ReadonlyMap<string, string>,
): EnvironmentConfigView {
  if (renamed.size === 0) return data;
  return {
    ...data,
    environments: data.environments.map((environment) => ({
      ...environment,
      variables: environment.variables.map((entry) => {
        const ref = isStoredSecretValue(entry.value)
          ? renamed.get(entry.value.ref)
          : undefined;
        return ref === undefined
          ? entry
          : { ...entry, value: { kind: 'stored-secret', ref } };
      }),
    })),
  };
}

function copyEnvironmentConfig(
  data: EnvironmentConfigView,
): EnvironmentConfigView {
  return {
    version: data.version,
    environments: data.environments.map((environment) => ({
      ...environment,
      variables: environment.variables.map((variable) => ({ ...variable })),
    })),
    globalRuntimes: { ...data.globalRuntimes },
    workspaceAssignments: data.workspaceAssignments.map((assignment) => ({
      ...assignment,
      runtimes: { ...assignment.runtimes },
    })),
  };
}

interface EnvironmentsState {
  data: EnvironmentConfigView | null;
  encryptionAvailable: boolean;
  status: EnvironmentsStoreStatus;
  error: string | null;
  secureStorageFailure: SecureStorageFailure | null;
  storageFailureAction: 'load' | 'save' | null;
  pendingSave: PendingEnvironmentSave | null;
  selectedEnvironmentId: string | null;
  loadVersion: number;
  requestVersion: number;
  dataVersion: number;
  environmentSaveVersion: number;
  environmentBaseline: string | null;
  lastSavedEnvironmentData: EnvironmentConfigView | null;
  load: () => Promise<void>;
  save: (next: EnvironmentConfigView, preserveLocal?: boolean) => Promise<void>;
  saveWorkspaceAssignments: (next: EnvironmentConfigView) => Promise<void>;
  retryStorageFailure: () => Promise<void>;
  selectEnvironment: (id: string | null) => void;
  setLocal: (next: EnvironmentConfigView) => void;
}

/**
 * Single source of truth for the Environments page configuration. Shared by
 * the main Environments page, the workspace Environment tab in both single
 * and multi-repo settings modals, and the App Advisor renderer wiring, so a
 * save in one surface reflects in the other without an explicit refresh.
 */
export const useEnvironmentsStore = create<EnvironmentsState>((set, get) => {
  let writeQueue: Promise<void> = Promise.resolve();
  let completedAssignmentVersion = 0;
  let baselineRequestSequence = 0;
  let completedBaselineRequest = 0;
  let latestCompletedAssignments: EnvironmentConfigView['workspaceAssignments'] =
    [];
  // The references each completed save renamed, in order. A save applies
  // only the renames that completed after it was submitted: references name
  // slots, so an older rename must not move a key the user has since reused.
  let renameLog: Map<string, string>[] = [];
  let renameLogStart = 0;
  let savesInFlight = 0;
  const rebaseSince = (
    data: EnvironmentConfigView,
    mark: number,
  ): EnvironmentConfigView =>
    renameLog
      .slice(Math.max(0, mark - renameLogStart))
      .reduce(
        (rebased, renamed) => rebaseStoredSecretRefs(rebased, renamed),
        data,
      );
  const persistSave = async (
    next: EnvironmentConfigView,
    kind: PendingEnvironmentSave['kind'],
    preserveLocal = false,
    replayPendingSave = false,
  ): Promise<void> => {
    let submitted = copyEnvironmentConfig(next);
    const renameMark = renameLogStart + renameLog.length;
    let savedRenames = new Map<string, string>();
    savesInFlight += 1;
    const baselineRequest = ++baselineRequestSequence;
    const assignmentVersion = completedAssignmentVersion;
    const dataVersion = get().dataVersion + 1;
    const requestVersion = get().requestVersion + 1;
    set({
      dataVersion,
      requestVersion,
      status: 'saving',
      error: null,
      secureStorageFailure: null,
      storageFailureAction: null,
      pendingSave: null,
    });
    let failureAction: 'load' | 'save' = 'save';
    const write = writeQueue.then(
      async (): Promise<SaveEnvironmentConfigResponse> => {
        if (kind === 'workspaceAssignments') {
          // Assignment callers own only assignments. Read after preceding writes
          // finish so an earlier snapshot cannot undo saved environment edits.
          failureAction = 'load';
          const persisted = await window.api.loadEnvironmentConfig();
          if (!('data' in persisted)) return persisted;
          failureAction = 'save';
          submitted = copyEnvironmentConfig({
            ...persisted.data,
            workspaceAssignments: submitted.workspaceAssignments,
          });
          const response = await window.api.saveEnvironmentConfig(submitted);
          if (response.ok) {
            latestCompletedAssignments = copyEnvironmentConfig(
              response.data,
            ).workspaceAssignments;
            completedAssignmentVersion += 1;
          }
          return response;
        }
        if (completedAssignmentVersion !== assignmentVersion) {
          // Preserve confirmed assignments; backend validation owns conflicts
          // with definitions deleted by this environment submission.
          submitted = copyEnvironmentConfig({
            ...submitted,
            workspaceAssignments: latestCompletedAssignments,
          });
        }
        submitted = rebaseSince(submitted, renameMark);
        const sent = submitted;
        return window.api.saveEnvironmentConfig(sent).then((saved) => {
          if (saved.ok) {
            savedRenames = renamedStoredSecretRefs(sent, saved.data);
            renameLog.push(savedRenames);
          }
          return saved;
        });
      },
    );
    writeQueue = write.then(
      () => undefined,
      () => undefined,
    );
    void write
      .finally((): void => {
        savesInFlight -= 1;
        if (savesInFlight === 0) {
          renameLogStart += renameLog.length;
          renameLog = [];
        }
      })
      .catch((): void => undefined);
    try {
      const response: SaveEnvironmentConfigResponse = await write;
      if (response.ok === false) {
        if (get().requestVersion === requestVersion) {
          set({
            status: 'error',
            error: response.error,
            secureStorageFailure: response.secureStorageFailure ?? null,
            storageFailureAction: failureAction,
            pendingSave:
              (failureAction === 'save' && response.secureStorageFailure) ||
              replayPendingSave
                ? { kind, data: submitted, dataVersion, preserveLocal }
                : null,
          });
        }
        throw new Error(response.error);
      }
      if (kind === 'environment') completedBaselineRequest = baselineRequest;
      set((state) => {
        // Durable environment saves settle their editor even when a newer
        // assignment save or read owns the shared request state.
        const projectedData = {
          ...(state.data
            ? rebaseStoredSecretRefs(state.data, savedRenames)
            : response.data),
          workspaceAssignments: response.data.workspaceAssignments,
        };
        const environmentSaveState = {
          data: projectedData,
          // Assignment-first hydration needs the confirmed baseline, not the draft.
          environmentBaseline:
            kind === 'environment' || state.environmentBaseline === null
              ? environmentEditorBaseline(response.data)
              : state.environmentBaseline,
          environmentSaveVersion:
            kind === 'environment'
              ? state.environmentSaveVersion + 1
              : state.environmentSaveVersion,
          lastSavedEnvironmentData:
            kind === 'environment'
              ? response.data
              : state.lastSavedEnvironmentData,
        };
        if (state.requestVersion !== requestVersion)
          return environmentSaveState;
        const keepDraft = preserveLocal || state.dataVersion !== dataVersion;
        const previousSelected = state.selectedEnvironmentId;
        const nextSelected =
          previousSelected &&
          response.data.environments.some(
            (environment) => environment.id === previousSelected,
          )
            ? previousSelected
            : (response.data.environments[0]?.id ?? null);
        return {
          ...environmentSaveState,
          data:
            kind === 'workspaceAssignments' || keepDraft
              ? projectedData
              : response.data,
          encryptionAvailable: response.encryptionAvailable,
          status: 'ready',
          error: null,
          secureStorageFailure: null,
          storageFailureAction: null,
          pendingSave: null,
          selectedEnvironmentId:
            kind === 'environment' && !keepDraft
              ? nextSelected
              : state.selectedEnvironmentId,
        };
      });
    } catch (error: unknown) {
      if (get().requestVersion === requestVersion && get().status !== 'error') {
        set({
          status: 'error',
          error:
            error instanceof Error
              ? error.message
              : 'Failed to save environments.',
          secureStorageFailure: null,
          storageFailureAction: failureAction,
          pendingSave: replayPendingSave
            ? { kind, data: submitted, dataVersion, preserveLocal }
            : null,
        });
      }
      throw error;
    }
  };
  return {
    data: null,
    encryptionAvailable: true,
    status: 'idle',
    error: null,
    secureStorageFailure: null,
    storageFailureAction: null,
    pendingSave: null,
    selectedEnvironmentId: null,
    loadVersion: 0,
    requestVersion: 0,
    dataVersion: 0,
    environmentSaveVersion: 0,
    environmentBaseline: null,
    lastSavedEnvironmentData: null,
    load: async (): Promise<void> => {
      const requestVersion = get().requestVersion + 1;
      const dataVersion = get().dataVersion;
      const baselineRequest = ++baselineRequestSequence;
      const { data, environmentBaseline } = get();
      const keepExistingDraft =
        data !== null &&
        environmentBaseline !== null &&
        environmentEditorBaseline(data) !== environmentBaseline;
      set({
        requestVersion,
        status: 'loading',
        error: null,
        secureStorageFailure: null,
        storageFailureAction: null,
        pendingSave: null,
      });
      try {
        const response: LoadEnvironmentConfigResponse = await writeQueue.then(
          () => window.api.loadEnvironmentConfig(),
        );
        if (!('data' in response)) {
          if (get().requestVersion !== requestVersion) return;
          set({
            status: 'error',
            error: response.error,
            secureStorageFailure: response.secureStorageFailure ?? null,
            storageFailureAction: 'load',
          });
          return;
        }
        // A delayed read may confirm the baseline but cannot regress a newer
        // successful read/save observation or replace an intervening draft.
        const baselineUpdate =
          completedBaselineRequest < baselineRequest
            ? { environmentBaseline: environmentEditorBaseline(response.data) }
            : {};
        if (completedBaselineRequest < baselineRequest)
          completedBaselineRequest = baselineRequest;
        if (get().requestVersion !== requestVersion) {
          set(baselineUpdate);
          return;
        }
        if (keepExistingDraft || get().dataVersion !== dataVersion) {
          set((state) => ({
            ...baselineUpdate,
            encryptionAvailable: response.encryptionAvailable,
            data: {
              ...(state.data ?? response.data),
              workspaceAssignments: response.data.workspaceAssignments,
            },
            status: 'ready',
            error: null,
            secureStorageFailure: null,
            storageFailureAction: null,
          }));
          return;
        }
        const previousSelected = get().selectedEnvironmentId;
        const nextSelected =
          previousSelected &&
          response.data.environments.some(
            (environment) => environment.id === previousSelected,
          )
            ? previousSelected
            : (response.data.environments[0]?.id ?? null);
        set((state) => ({
          ...baselineUpdate,
          data: response.data,
          encryptionAvailable: response.encryptionAvailable,
          status: 'ready',
          error: null,
          secureStorageFailure: null,
          storageFailureAction: null,
          selectedEnvironmentId: nextSelected,
          loadVersion: state.loadVersion + 1,
          dataVersion: state.dataVersion + 1,
        }));
      } catch (error: unknown) {
        if (get().requestVersion !== requestVersion) return;
        const message =
          error instanceof Error
            ? error.message
            : 'Failed to load environments.';
        set({
          status: 'error',
          error: message,
          secureStorageFailure: null,
          storageFailureAction: null,
        });
      }
    },
    save: (next, preserveLocal = false): Promise<void> =>
      persistSave(next, 'environment', preserveLocal),
    saveWorkspaceAssignments: (next): Promise<void> =>
      persistSave(next, 'workspaceAssignments'),
    retryStorageFailure: async (): Promise<void> => {
      const pending = get().pendingSave;
      if (pending?.kind === 'environment') {
        await persistSave(
          pending.data,
          'environment',
          pending.preserveLocal || get().dataVersion !== pending.dataVersion,
          true,
        );
      } else if (pending?.kind === 'workspaceAssignments') {
        await persistSave(pending.data, 'workspaceAssignments', false, true);
      } else if (
        get().storageFailureAction === 'load' ||
        get().storageFailureAction === 'save'
      ) {
        // A preliminary assignment read can fail before any save is submitted.
        // Without a payload, recover the read; never save the current draft.
        await get().load();
      }
    },
    selectEnvironment: (id: string | null): void => {
      set({ selectedEnvironmentId: id });
    },
    setLocal: (next: EnvironmentConfigView): void => {
      const previousSelected = get().selectedEnvironmentId;
      const nextSelected =
        previousSelected &&
        next.environments.some(
          (environment) => environment.id === previousSelected,
        )
          ? previousSelected
          : (next.environments[0]?.id ?? null);
      set((state) => ({
        data: next,
        selectedEnvironmentId: nextSelected,
        dataVersion: state.dataVersion + 1,
        status: state.status,
      }));
    },
  };
});
