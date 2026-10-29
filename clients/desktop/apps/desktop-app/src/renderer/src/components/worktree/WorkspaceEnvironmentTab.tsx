import { SecureStorageNotice } from '@/components/auth/SecureStorageNotice';
import { Notice } from '@canopy/ui-shared/components';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  EnvironmentConfigData,
  EnvironmentDefinition,
  EnvironmentRuntime,
  WorkspaceEnvironmentAssignment,
} from '@canopy/desktop-shared/types';
import { compareEnvironmentDefinitions } from '@canopy/desktop-shared/lib/user-environment';
import { useEnvironmentsStore } from '@/stores/environmentsStore';
import { EnvironmentRuntimeSelect } from '@/components/environments/EnvironmentRuntimeSelect';
import { brandText } from '@/lib/brand';

const RUNTIMES: EnvironmentRuntime[] = ['canopy', 'agent', 'pipeline'];

const RUNTIME_META: Record<
  EnvironmentRuntime,
  { label: string; helper: string }
> = {
  canopy: {
    label: `${brandText.shortName} Runtime`,
    helper:
      'Project scripts, hooks, terminals, setup, launch, and background processes.',
  },
  agent: {
    label: 'Agent runtime',
    helper: 'Interactive agent sessions and helper agents.',
  },
  pipeline: {
    label: 'Pipeline runtime',
    helper: 'Pipeline runs and agent steps launched inside pipelines.',
  },
};

export interface WorkspaceEnvironmentTabProps {
  workspaceId: string;
  workspaceName: string;
  workspaceKind?: 'code' | 'cowork';
  onManageEnvironments: () => void;
}

function runtimeHelper(
  runtime: EnvironmentRuntime,
  workspaceKind: 'code' | 'cowork',
): string {
  if (runtime === 'canopy' && workspaceKind === 'cowork') {
    return 'Project terminals, setup, and background processes.';
  }
  return RUNTIME_META[runtime].helper;
}

function findAssignment(
  data: EnvironmentConfigData,
  workspaceId: string,
): WorkspaceEnvironmentAssignment | undefined {
  return data.workspaceAssignments.find(
    (assignment) => assignment.workspaceId === workspaceId,
  );
}

function getEffectiveEnvironmentId(
  data: EnvironmentConfigData,
  assignment: WorkspaceEnvironmentAssignment | undefined,
  runtime: EnvironmentRuntime,
): string | null {
  const override = assignment?.runtimes[runtime];
  if (override === undefined) return null;
  return override ?? null;
}

function getFallbackEnvironment(
  data: EnvironmentConfigData,
  runtime: EnvironmentRuntime,
): EnvironmentDefinition | undefined {
  const globalId = data.globalRuntimes[runtime];
  if (!globalId) return undefined;
  return data.environments.find((environment) => environment.id === globalId);
}

function sortEnvironments(
  environments: ReadonlyArray<EnvironmentDefinition>,
): EnvironmentDefinition[] {
  return [...environments].sort(compareEnvironmentDefinitions);
}

/**
 * Shared assignment tab rendered by both single-repo
 * (`ProjectSettingsModal`) and multi-repo (`WorkspaceSettingsModal`)
 * settings modals. Selecting a runtime's "Global default (...)" option
 * removes the per-runtime key; clearing all three drops the workspace
 * entry entirely so the global default is the single source of truth.
 */
export function WorkspaceEnvironmentTab({
  workspaceId,
  workspaceName,
  workspaceKind = 'code',
  onManageEnvironments,
}: WorkspaceEnvironmentTabProps): JSX.Element {
  const data = useEnvironmentsStore((s) => s.data);
  const status = useEnvironmentsStore((s) => s.status);
  const secureStorageFailure = useEnvironmentsStore(
    (s) => s.secureStorageFailure,
  );
  const pendingSave = useEnvironmentsStore((s) => s.pendingSave);
  const retryStorageFailure = useEnvironmentsStore(
    (s) => s.retryStorageFailure,
  );
  const load = useEnvironmentsStore((s) => s.load);
  const saveWorkspaceAssignments = useEnvironmentsStore(
    (s) => s.saveWorkspaceAssignments,
  );

  const [pendingOverrides, setPendingOverrides] = useState<
    Partial<Record<EnvironmentRuntime, string | null>>
  >({});
  const pendingOverridesRef = useRef(pendingOverrides);
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const savedTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (status === 'idle') {
      void load();
    }
  }, [load, status]);

  useEffect(
    () => (): void => {
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
    },
    [],
  );

  const assignment = useMemo(
    () => (data ? findAssignment(data, workspaceId) : undefined),
    [data, workspaceId],
  );

  // Only a different workspace invalidates all local overrides.
  useEffect(() => {
    pendingOverridesRef.current = {};
    setPendingOverrides({});
    setSaveStatus('idle');
    setSaveError(null);
  }, [workspaceId]);

  useEffect(() => {
    const remaining = { ...pendingOverridesRef.current };
    for (const runtime of RUNTIMES) {
      if (
        runtime in remaining &&
        remaining[runtime] === (assignment?.runtimes[runtime] ?? null)
      ) {
        delete remaining[runtime];
      }
    }
    pendingOverridesRef.current = remaining;
    setPendingOverrides(remaining);
  }, [assignment]);

  const sortedEnvironments = useMemo(
    () => (data ? sortEnvironments(data.environments) : []),
    [data],
  );

  const dirty = Object.keys(pendingOverrides).length > 0;

  const resolveValue = useCallback(
    (runtime: EnvironmentRuntime): string | null => {
      if (runtime in pendingOverrides) {
        return pendingOverrides[runtime] ?? null;
      }
      if (!data) return null;
      return getEffectiveEnvironmentId(data, assignment, runtime);
    },
    [assignment, data, pendingOverrides],
  );

  const handleChange = useCallback(
    (runtime: EnvironmentRuntime, nextId: string | null): void => {
      pendingOverridesRef.current = {
        ...pendingOverridesRef.current,
        [runtime]: nextId,
      };
      setPendingOverrides((current) => ({
        ...current,
        [runtime]: nextId,
      }));
    },
    [],
  );

  const handleSave = useCallback(async (): Promise<void> => {
    if (!data) return;
    setSaveStatus('saving');
    setSaveError(null);

    try {
      const response = await window.api.loadEnvironmentConfig();
      if (!('data' in response)) {
        useEnvironmentsStore.setState({
          status: 'error',
          error: response.error,
          secureStorageFailure: response.secureStorageFailure ?? null,
          storageFailureAction: 'load',
        });
        throw new Error(response.error);
      }
      const persisted = response.data;
      const persistedAssignment = findAssignment(persisted, workspaceId);
      // Merge persisted runtimes with pending overrides into the canonical
      // "what should be saved" map. `null` removes the runtime from the
      // assignment.
      const mergedRuntimes: Partial<Record<EnvironmentRuntime, string | null>> =
        {
          ...persistedAssignment?.runtimes,
        };
      for (const runtime of RUNTIMES) {
        if (runtime in pendingOverrides) {
          const next = pendingOverrides[runtime] ?? null;
          if (next === null) {
            delete mergedRuntimes[runtime];
          } else {
            mergedRuntimes[runtime] = next;
          }
        }
      }

      const filteredRuntimes: Partial<
        WorkspaceEnvironmentAssignment['runtimes']
      > = {};
      for (const runtime of RUNTIMES) {
        const value = mergedRuntimes[runtime];
        if (value !== undefined && value !== null) {
          filteredRuntimes[runtime] = value;
        }
      }
      const keepEntry = Object.keys(filteredRuntimes).length > 0;
      const now = new Date().toISOString();
      const nextWorkspaceAssignments = persisted.workspaceAssignments.filter(
        (existing) => existing.workspaceId !== workspaceId,
      );
      if (keepEntry) {
        nextWorkspaceAssignments.push({
          workspaceId,
          runtimes: filteredRuntimes,
          updatedAt: now,
        });
      }
      const nextConfig: EnvironmentConfigData = {
        ...persisted,
        workspaceAssignments: nextWorkspaceAssignments,
      };
      await saveWorkspaceAssignments(nextConfig);
      const remaining = { ...pendingOverridesRef.current };
      for (const runtime of RUNTIMES) {
        if (
          runtime in pendingOverrides &&
          remaining[runtime] === pendingOverrides[runtime]
        ) {
          delete remaining[runtime];
        }
      }
      pendingOverridesRef.current = remaining;
      setPendingOverrides(remaining);
      setSaveStatus(Object.keys(remaining).length === 0 ? 'saved' : 'idle');
      if (savedTimerRef.current !== null) {
        window.clearTimeout(savedTimerRef.current);
      }
      savedTimerRef.current = window.setTimeout(() => {
        savedTimerRef.current = null;
        setSaveStatus((current) => (current === 'saved' ? 'idle' : current));
      }, 1500);
    } catch (err) {
      setSaveStatus('error');
      setSaveError(
        err instanceof Error
          ? err.message
          : 'Could not save environment assignments.',
      );
    }
  }, [data, pendingOverrides, saveWorkspaceAssignments, workspaceId]);

  if (!data) {
    return (
      <div
        className="space-y-4 p-2"
        data-testid={`workspace-environment-tab-${workspaceId}`}
      >
        {secureStorageFailure ? (
          <SecureStorageNotice
            failure={secureStorageFailure}
            retrying={status === 'loading'}
            onRetry={(): void => void load()}
          />
        ) : status === 'error' ? (
          <div className="space-y-3">
            <p
              className="text-s fg-destructive"
              data-testid="workspace-environment-error"
            >
              Could not load environment assignments.
            </p>
            <button
              type="button"
              onClick={() => {
                void useEnvironmentsStore.getState().load();
              }}
              data-testid="workspace-environment-retry"
              className="focus-ring rounded-md border bg-secondary px-3 py-1.5 text-s font-medium fg-primary transition-colors hover:bg-accent-subtle"
            >
              Retry
            </button>
          </div>
        ) : (
          <p
            className="text-s fg-secondary"
            data-testid="workspace-environment-loading"
          >
            Loading environment assignments…
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      className="space-y-4 p-2"
      data-testid={`workspace-environment-tab-${workspaceId}`}
    >
      <SecureStorageNotice
        failure={secureStorageFailure}
        retrying={saveStatus === 'saving' || status === 'loading'}
        onRetry={(): void => {
          void retryStorageFailure()
            .then(() => {
              setSaveStatus(
                pendingSave?.kind === 'workspaceAssignments' &&
                  Object.keys(pendingOverridesRef.current).length === 0
                  ? 'saved'
                  : 'idle',
              );
              setSaveError(null);
            })
            .catch((err: unknown) => {
              setSaveStatus('error');
              setSaveError(
                err instanceof Error
                  ? err.message
                  : 'Could not save environment assignments.',
              );
            });
        }}
      />
      <div className="space-y-1">
        <h3 className="text-s font-semibold fg-primary">Environment</h3>
        <p className="text-xs fg-secondary">
          Assign environments for{' '}
          <span className="font-medium fg-primary">{workspaceName}</span>.
          Unassigned runtimes use the global defaults in Settings →
          Environments.
        </p>
      </div>

      <div className="space-y-4">
        {RUNTIMES.map((runtime) => {
          const fallback = getFallbackEnvironment(data, runtime);
          const fallbackLabel = `Global default (${fallback?.name ?? 'unassigned'})`;
          return (
            <div key={runtime} className="space-y-1">
              <label className="block text-s font-medium fg-primary">
                {RUNTIME_META[runtime].label}
              </label>
              <p className="text-xs fg-secondary">
                {runtimeHelper(runtime, workspaceKind)}
              </p>
              <EnvironmentRuntimeSelect
                environments={sortedEnvironments}
                value={resolveValue(runtime)}
                onChange={(next) => handleChange(runtime, next)}
                fallbackOption={{ id: null, label: fallbackLabel }}
                testId={`workspace-environment-${runtime}`}
                ariaLabel={`${RUNTIME_META[runtime].label} assignment`}
              />
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <button
          type="button"
          onClick={onManageEnvironments}
          data-testid="workspace-environment-manage"
          className="focus-ring rounded-md border bg-secondary px-3 py-1.5 text-s font-medium fg-primary transition-colors hover:bg-accent-subtle"
        >
          Manage environments
        </button>
        <div className="flex items-center justify-end gap-3">
          {saveStatus === 'saved' && (
            <span
              className="text-xs fg-secondary"
              data-testid="workspace-environment-saved"
            >
              Saved.
            </span>
          )}
          {saveStatus === 'error' && !secureStorageFailure && (
            <Notice
              intent="attention"
              data-testid="workspace-environment-error"
            >
              {saveError ?? 'Could not save environment assignments.'}
            </Notice>
          )}
          <button
            type="button"
            onClick={() => {
              void handleSave();
            }}
            disabled={!dirty || saveStatus === 'saving'}
            data-testid="workspace-environment-save"
            className="focus-ring rounded-md bg-accent px-3 py-1.5 text-s font-medium fg-emphasis transition-colors hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saveStatus === 'saving'
              ? 'Saving…'
              : 'Save environment assignments'}
          </button>
        </div>
      </div>
    </div>
  );
}
