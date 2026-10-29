import type { CodeGraphPreferences } from '@canopy/desktop-shared/types';
import { isCodeGraphFeatureEnabled } from './code-graph-feature-flag';

export const CODE_GRAPH_UNAVAILABLE_MESSAGE =
  'Code graph tools are not available for this project.';

const DEFAULT_CODE_GRAPH_PREFERENCES: CodeGraphPreferences = {
  mode: 'enabled',
  selectedWorkspaceIds: [],
  generationTimeoutMinutes: 30,
};

let currentPreferences: CodeGraphPreferences = {
  ...DEFAULT_CODE_GRAPH_PREFERENCES,
  selectedWorkspaceIds: [],
};
let reconciliationQueue: Promise<void> = Promise.resolve();

function normalizePreferences(
  preferences: CodeGraphPreferences | undefined,
): CodeGraphPreferences {
  const mode =
    preferences?.mode === 'disabled' ||
    preferences?.mode === 'selected-workspaces'
      ? preferences.mode
      : 'enabled';
  const seen = new Set<string>();
  const selectedWorkspaceIds: string[] = [];
  for (const value of preferences?.selectedWorkspaceIds ?? []) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    selectedWorkspaceIds.push(trimmed);
  }
  const timeout = preferences?.generationTimeoutMinutes;
  return {
    mode,
    selectedWorkspaceIds,
    generationTimeoutMinutes:
      typeof timeout === 'number' &&
      Number.isFinite(timeout) &&
      Number.isInteger(timeout) &&
      timeout >= 1 &&
      timeout <= 1_440
        ? timeout
        : DEFAULT_CODE_GRAPH_PREFERENCES.generationTimeoutMinutes,
  };
}

export function setCodeGraphPreferences(
  preferences: CodeGraphPreferences | undefined,
): void {
  currentPreferences = normalizePreferences(preferences);
}

export function getCodeGraphPreferencesSnapshot(): CodeGraphPreferences {
  return {
    ...currentPreferences,
    selectedWorkspaceIds: [...currentPreferences.selectedWorkspaceIds],
  };
}

export function isCodeGraphPreferenceEnabledForWorkspace(
  workspaceId: string,
): boolean {
  if (currentPreferences.mode === 'enabled') {
    return true;
  }
  return (
    currentPreferences.mode === 'selected-workspaces' &&
    currentPreferences.selectedWorkspaceIds.includes(workspaceId)
  );
}

export function isCodeGraphAvailableForWorkspace(workspaceId: string): boolean {
  return (
    isCodeGraphFeatureEnabled() &&
    isCodeGraphPreferenceEnabledForWorkspace(workspaceId)
  );
}

export function getCodeGraphGenerationTimeoutMinutes(): number {
  return currentPreferences.generationTimeoutMinutes;
}

export function getCodeGraphGenerationTimeoutMs(): number {
  return getCodeGraphGenerationTimeoutMinutes() * 60_000;
}

export function reconcileCodeGraphAvailability(): Promise<void> {
  const reconciliation = reconciliationQueue.then(async () => {
    // Defer these heavy lifecycle modules and break their intentional cycle
    // back to this availability cache; Electron main resolves the local chunks
    // through the normal packaged main bundle path.
    const [{ reconcileCodeGraphBuildAvailability }, scheduler, baseManager] =
      await Promise.all([
        import('../code-graph/build-runner'),
        import('./code-graph-scheduler'),
        import('./code-graph-base-manager'),
      ]);
    await reconcileCodeGraphBuildAvailability(isCodeGraphAvailableForWorkspace);
    await Promise.all([
      scheduler.reconcileCodeGraphSchedulerAvailability(),
      baseManager.reconcileCodeGraphBaseAvailability(),
    ]);
  });
  reconciliationQueue = reconciliation.catch(() => undefined);
  return reconciliation;
}

export function resetCodeGraphAvailabilityForTests(): void {
  currentPreferences = {
    ...DEFAULT_CODE_GRAPH_PREFERENCES,
    selectedWorkspaceIds: [],
  };
  reconciliationQueue = Promise.resolve();
}
