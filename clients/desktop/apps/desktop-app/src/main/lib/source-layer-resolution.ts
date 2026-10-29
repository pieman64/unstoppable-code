import type {
  CanopyJsonRepoEntry,
  CanopyJsonFile,
  HookSourceLayer,
  ScriptSourceLayer,
  WorkspaceConfigFile,
  WorkspaceRepoData,
} from '@canopy/desktop-shared/types';
import type { HookAction } from '@canopy/desktop-shared/hooks';
import type { ScriptValue } from '@canopy/desktop-shared/scripts';
import { isScriptDefinition } from '@canopy/desktop-shared/scripts';
import { getManifestRepoById, readCanopyJson } from './canopy-json';
import { getBaselineReadPath } from './repo-shadow';
import { readWorkspaceConfig } from './workspace-persistence';

type SourceLayerStatus = 'active' | 'disabled' | 'overridden' | 'absent';

interface MutableSourceLayer {
  status: SourceLayerStatus;
}

export interface WorkspaceRepoLayerPaths {
  workspaceRootPath?: string;
  repoPath?: string;
  localConfig?: WorkspaceConfigFile;
}

export interface WorkspaceRepoLayerContext {
  localConfig: WorkspaceConfigFile;
  repo: WorkspaceRepoData;
  repoPath: string;
  repoManifest: CanopyJsonFile | null;
  workspaceManifestRepo?: CanopyJsonRepoEntry;
}

export async function readWorkspaceRepoLayerContext(
  workspaceId: string,
  repoId: string,
  paths?: WorkspaceRepoLayerPaths,
): Promise<WorkspaceRepoLayerContext> {
  const localConfig =
    paths?.localConfig ?? (await readWorkspaceConfig(workspaceId));
  const repo = localConfig.repos.find((candidate) => candidate.id === repoId);
  if (!repo) {
    throw new Error(`Repo ${repoId} not found in project ${workspaceId}`);
  }

  const repoPath = paths?.repoPath ?? repo.repoPath;
  const [repoManifest, workspaceManifest] = await Promise.all([
    readCanopyJson(repoPath),
    readWorkspaceCanopyManifest(localConfig, paths?.workspaceRootPath),
  ]);
  const workspaceManifestRepo = workspaceManifest
    ? getManifestRepoById(workspaceManifest, repoId)
    : undefined;

  return {
    localConfig,
    repo,
    repoPath,
    repoManifest,
    workspaceManifestRepo,
  };
}

export function buildScriptSourceLayer(
  sourceKey: string,
  sourceLabel: string,
  scripts: Record<string, ScriptValue | undefined> | undefined,
  scriptName: string,
): ScriptSourceLayer | null {
  if (!scripts || !(scriptName in scripts)) {
    return null;
  }

  const value = scripts[scriptName];
  if (value === null) {
    return { sourceKey, sourceLabel, command: null, status: 'disabled' };
  }

  if (typeof value === 'string') {
    return { sourceKey, sourceLabel, command: value, status: 'active' };
  }

  if (isScriptDefinition(value)) {
    // ScriptSourceLayer intentionally stays string-only; per-script timeouts
    // are surfaced through dedicated settings UI, not the source-info layers.
    return {
      sourceKey,
      sourceLabel,
      command: value.command,
      status: 'active',
    };
  }

  return null;
}

export function buildHookSourceLayer(
  sourceKey: string,
  sourceLabel: string,
  hooks: Record<string, HookAction[] | null | undefined> | undefined,
  triggerName: string,
): HookSourceLayer | null {
  if (!hooks || !(triggerName in hooks)) {
    return null;
  }

  const actions = hooks[triggerName];
  if (actions === null) {
    return {
      sourceKey,
      sourceLabel,
      actions: null,
      status: 'disabled',
    };
  }
  if (Array.isArray(actions)) {
    return {
      sourceKey,
      sourceLabel,
      actions,
      status: 'active',
    };
  }

  return null;
}

export function assignEffectiveSourceLayerStatus<
  TLayer extends MutableSourceLayer,
>(layers: TLayer[]): void {
  let resolved = false;
  for (const layer of layers) {
    if (resolved) {
      if (layer.status === 'active') {
        layer.status = 'overridden';
      }
      continue;
    }
    if (layer.status === 'active' || layer.status === 'disabled') {
      resolved = true;
    }
  }
}

export async function readWorkspaceCanopyManifest(
  localConfig: {
    sourceRepoPath?: string;
  },
  workspaceRootPathOverride?: string,
): Promise<CanopyJsonFile | null> {
  const workspaceRootPath = workspaceRootPathOverride
    ? workspaceRootPathOverride
    : localConfig.sourceRepoPath
      ? await getBaselineReadPath(localConfig.sourceRepoPath)
      : undefined;
  if (!workspaceRootPath) {
    return null;
  }

  return readCanopyJson(workspaceRootPath);
}
