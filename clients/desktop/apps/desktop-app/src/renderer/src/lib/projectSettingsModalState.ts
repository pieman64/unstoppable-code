import type { WorkspaceSettingsDataResponse } from '@canopy/desktop-shared/types';
import {
  createEditableScripts,
  toScriptInputMap,
  type EditableScripts,
} from './editableScripts';
import {
  createEditableHooks,
  serializeHooks,
  type EditableHooks,
} from './editableHooks';

function serializeScripts(scripts: EditableScripts): string {
  const payload = toScriptInputMap(scripts);
  const entries = Object.entries(payload).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  return JSON.stringify(entries);
}

export function shouldResetProjectSettingsModalState(
  isOpen: boolean,
  wasOpen: boolean,
  previousProjectId: string,
  nextProjectId: string,
): boolean {
  return isOpen && (!wasOpen || previousProjectId !== nextProjectId);
}

export function canSubmitProjectSourceDraft(
  hasLoadedWorkspaceSettingsData: boolean,
  healthData: WorkspaceSettingsDataResponse | null,
): boolean {
  return hasLoadedWorkspaceSettingsData && healthData !== null;
}

export function hasProjectSourceDraft(
  sourceScripts: EditableScripts,
  healthData: WorkspaceSettingsDataResponse | null,
): boolean {
  const manifestScripts = createEditableScripts(healthData?.manifest?.scripts);
  return serializeScripts(sourceScripts) !== serializeScripts(manifestScripts);
}

export function hasProjectSourceHookDraft(
  sourceHooks: EditableHooks,
  healthData: WorkspaceSettingsDataResponse | null,
): boolean {
  const manifestHooks = createEditableHooks(healthData?.manifest?.hooks);
  return serializeHooks(sourceHooks) !== serializeHooks(manifestHooks);
}
