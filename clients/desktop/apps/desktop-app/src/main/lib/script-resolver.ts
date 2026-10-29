import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  isProjectLifecycleScriptName,
  normalizeScriptDefinition,
  normalizeScriptInputMap,
  PROJECT_LIFECYCLE_SCRIPT_NAMES,
} from '@canopy/desktop-shared/scripts';
import { BRAND } from '@canopy/brand/current';
import type {
  ScriptDefinition,
  ScriptOverrides,
  ScriptValue,
} from '@canopy/desktop-shared/scripts';
import type {
  CanopyJsonFile,
  ProjectData,
  ScriptSourceLayer,
  WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import {
  getManifestRepoById,
  getProjectConfigFileCandidates,
  readCanopyJson,
  validateCanopyJson,
} from './canopy-json';
import { readConductorJson, type ConductorJsonScripts } from './conductor-json';
import {
  assignEffectiveSourceLayerStatus,
  buildScriptSourceLayer,
  readWorkspaceCanopyManifest,
  readWorkspaceRepoLayerContext,
} from './source-layer-resolution';
import { isMissingFileError } from './fs-utils';
import { getBaselineReadPath } from './repo-shadow';
import { readWorkspaceConfig } from './workspace-persistence';

export interface ResolvedScriptField {
  definition?: ScriptDefinition;
  value?: string;
  source:
    | 'local-override'
    | 'local-disabled'
    | 'repo-conductor'
    | 'repo-canopy'
    | 'workspace-conductor'
    | 'workspace-manifest'
    | 'workspace-manifest-disabled'
    | 'workspace-hook'
    | 'workspace-hook-disabled'
    | 'none';
}

export type ResolvedScriptMap = Record<string, ResolvedScriptField>;

export interface WorkspaceScriptResolutionPaths {
  workspaceRootPath?: string;
  repoPath?: string;
  localConfig?: WorkspaceConfigFile;
}

export async function resolveProjectScripts(
  project: Pick<ProjectData, 'repoPath' | 'scripts'>,
  repoPathOverride?: string,
): Promise<ResolvedScriptMap> {
  const resolved: ResolvedScriptMap = {};
  const repoPath = repoPathOverride ?? project.repoPath;
  const repoManifest = await readCanopyJson(repoPath);

  applyScriptDefinitions(resolved, repoManifest?.scripts, 'repo-canopy');
  applyOverrideScripts(
    resolved,
    project.scripts,
    'local-override',
    'local-disabled',
  );
  await applyConductorFallbackScripts(resolved, repoPath, 'repo-conductor');

  return resolved;
}

export async function resolveWorkspaceRepoScripts(
  workspaceId: string,
  repoId: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<ResolvedScriptMap> {
  const { repo, repoPath, repoManifest, workspaceManifestRepo } =
    await readWorkspaceRepoLayerContext(workspaceId, repoId, paths);

  const resolved: ResolvedScriptMap = {};
  applyScriptDefinitions(resolved, repoManifest?.scripts, 'repo-canopy');
  applyOverrideScripts(
    resolved,
    workspaceManifestRepo?.scripts,
    'workspace-manifest',
    'workspace-manifest-disabled',
  );
  applyOverrideScripts(
    resolved,
    repo.scripts,
    'local-override',
    'local-disabled',
  );
  await applyConductorFallbackScripts(resolved, repoPath, 'repo-conductor');

  return resolved;
}

export async function resolveWorkspaceRootScripts(
  workspaceId: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<ResolvedScriptMap> {
  const localConfig =
    paths?.localConfig ?? (await readWorkspaceConfig(workspaceId));
  const workspaceManifest = await readWorkspaceCanopyManifest(
    localConfig,
    paths?.workspaceRootPath,
  );
  const resolved: ResolvedScriptMap = {};

  applyScriptDefinitions(
    resolved,
    workspaceManifest?.scripts,
    'workspace-hook',
  );
  applyOverrideScripts(
    resolved,
    localConfig.scripts,
    'local-override',
    'local-disabled',
  );
  const workspaceRootPath =
    paths?.workspaceRootPath ??
    (localConfig.sourceRepoPath
      ? await getBaselineReadPath(localConfig.sourceRepoPath)
      : undefined);
  if (workspaceRootPath) {
    await applyConductorFallbackScripts(
      resolved,
      workspaceRootPath,
      'workspace-conductor',
    );
  }

  return resolved;
}

export function getResolvedScriptCommand(
  resolved: ResolvedScriptMap,
  scriptName: string,
): string | undefined {
  return getResolvedScriptDefinition(resolved, scriptName)?.command;
}

export function getResolvedScriptDefinition(
  resolved: ResolvedScriptMap,
  scriptName: string,
): ScriptDefinition | undefined {
  return resolved[scriptName]?.definition;
}

export function getResolvedScriptTimeoutSeconds(
  resolved: ResolvedScriptMap,
  scriptName: string,
): number | null | undefined {
  return getResolvedScriptDefinition(resolved, scriptName)?.timeoutSeconds;
}
export function toScriptOverrides(
  resolved: ResolvedScriptMap,
): ScriptOverrides | undefined {
  const overrides: Record<string, ScriptValue | undefined> = {};

  for (const [name, field] of Object.entries(resolved)) {
    if (!field) {
      continue;
    }
    if (field.definition) {
      overrides[name] = field.definition;
    } else if (
      field.source === 'local-disabled' ||
      field.source === 'workspace-manifest-disabled' ||
      field.source === 'workspace-hook-disabled'
    ) {
      overrides[name] = null;
    }
  }

  return normalizeScriptInputMap(overrides);
}

function applyScriptDefinitions(
  resolved: ResolvedScriptMap,
  scripts: Record<string, string | ScriptDefinition> | undefined,
  source: ResolvedScriptField['source'],
): void {
  if (!scripts) {
    return;
  }

  for (const [scriptName, value] of Object.entries(scripts)) {
    const definition = normalizeScriptDefinition(value);
    if (!definition) {
      continue;
    }
    resolved[scriptName] = {
      definition,
      value: definition.command,
      source,
    };
  }
}

function applyOverrideScripts(
  resolved: ResolvedScriptMap,
  scripts: Record<string, ScriptValue> | undefined,
  enabledSource: ResolvedScriptField['source'],
  disabledSource: ResolvedScriptField['source'],
): void {
  if (!scripts) {
    return;
  }

  for (const [scriptName, value] of Object.entries(scripts)) {
    if (value === null) {
      resolved[scriptName] = { source: disabledSource };
      continue;
    }
    const definition = normalizeScriptDefinition(value);
    if (!definition) {
      continue;
    }
    resolved[scriptName] = {
      definition,
      value: definition.command,
      source: enabledSource,
    };
  }
}

async function applyConductorFallbackScripts(
  resolved: ResolvedScriptMap,
  repoPath: string,
  source: ResolvedScriptField['source'],
): Promise<void> {
  if (!hasMissingConductorLifecycleScripts(resolved)) {
    return;
  }

  const conductorScripts = await readConductorJson(repoPath);
  applyMissingStringScripts(resolved, conductorScripts ?? undefined, source);
}

function hasMissingConductorLifecycleScripts(
  resolved: ResolvedScriptMap,
): boolean {
  return PROJECT_LIFECYCLE_SCRIPT_NAMES.some(
    (scriptName) => resolved[scriptName] === undefined,
  );
}

function applyMissingStringScripts(
  resolved: ResolvedScriptMap,
  scripts:
    | Record<string, ScriptValue | undefined>
    | ConductorJsonScripts
    | undefined,
  source: ResolvedScriptField['source'],
): void {
  if (!scripts) {
    return;
  }

  for (const [scriptName, value] of Object.entries(scripts)) {
    if (typeof value !== 'string') {
      continue;
    }
    if (resolved[scriptName] !== undefined) {
      continue;
    }

    resolved[scriptName] = {
      definition: { command: value },
      value,
      source,
    };
  }
}

// ---------------------------------------------------------------------------
// Layer collection — returns all sources for a given script without collapsing
// ---------------------------------------------------------------------------

function buildConductorLayer(
  sourceKey: string,
  sourceLabel: string,
  scripts: ConductorJsonScripts | null | undefined,
  scriptName: string,
): ScriptSourceLayer | null {
  if (!scripts) {
    return null;
  }

  const conductorKey = scriptName as keyof ConductorJsonScripts;
  const value = scripts[conductorKey];
  if (typeof value === 'string') {
    return { sourceKey, sourceLabel, command: value, status: 'active' };
  }

  return null;
}

interface ConfigCandidateLayerSource {
  fileName: string;
  manifest: CanopyJsonFile | null;
}

async function readConfigCandidateLayerSources(
  repoPath: string,
): Promise<ConfigCandidateLayerSource[]> {
  const candidates: ConfigCandidateLayerSource[] = [];

  for (const filePath of getProjectConfigFileCandidates(repoPath)) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      candidates.push({
        fileName: basename(filePath),
        manifest: validateCanopyJson(parsed, filePath),
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        candidates.push({
          fileName: basename(filePath),
          manifest: null,
        });
        continue;
      }
      throw error;
    }
  }

  return candidates;
}

function buildConfigScriptLayers({
  sourceKeyPrefix,
  sourceLabelSuffix,
  candidates,
  scriptName,
  getScripts,
}: {
  sourceKeyPrefix: string;
  sourceLabelSuffix?: string;
  candidates: ConfigCandidateLayerSource[];
  scriptName: string;
  getScripts: (
    manifest: CanopyJsonFile,
  ) => Record<string, ScriptValue | undefined> | undefined;
}): ScriptSourceLayer[] {
  const selectedIndex = candidates.findIndex(
    (candidate) => candidate.manifest !== null,
  );
  const layers: ScriptSourceLayer[] = [];
  const candidateLayers = candidates.map((candidate, index) => {
    if (!candidate.manifest) {
      return null;
    }
    const label = buildConfigSourceLabel(candidate.fileName, sourceLabelSuffix);
    const layer = buildScriptSourceLayer(
      `${sourceKeyPrefix}:${candidate.fileName}`,
      label,
      getScripts(candidate.manifest),
      scriptName,
    );
    if (layer && selectedIndex >= 0 && index > selectedIndex) {
      layer.status = 'overridden';
      layer.sourceLabel = `${label} (overridden fallback)`;
    }
    return layer;
  });
  const hasAnyConfigLayer = candidateLayers.some((layer) => layer !== null);

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!candidate) {
      continue;
    }
    const layer = candidateLayers[index];
    if (layer) {
      layers.push(layer);
      continue;
    }

    if (
      selectedIndex > index &&
      hasAnyConfigLayer &&
      candidate.manifest === null
    ) {
      layers.push({
        sourceKey: `${sourceKeyPrefix}:${candidate.fileName}`,
        sourceLabel: `${buildConfigSourceLabel(
          candidate.fileName,
          sourceLabelSuffix,
        )} (not found)`,
        command: null,
        status: 'absent',
      });
      continue;
    }

    if (
      selectedIndex === index &&
      hasAnyConfigLayer &&
      candidate.manifest !== null
    ) {
      layers.push({
        sourceKey: `${sourceKeyPrefix}:${candidate.fileName}`,
        sourceLabel: `${buildConfigSourceLabel(
          candidate.fileName,
          sourceLabelSuffix,
        )} (used config)`,
        command: null,
        status: 'absent',
      });
    }
  }

  return layers;
}

function buildConfigSourceLabel(
  fileName: string,
  suffix: string | undefined,
): string {
  return suffix ? `${fileName} ${suffix}` : fileName;
}

export async function collectProjectScriptLayers(
  project: Pick<ProjectData, 'repoPath' | 'scripts'>,
  scriptName: string,
  repoPathOverride?: string,
): Promise<ScriptSourceLayer[]> {
  const effectiveRepoPath = repoPathOverride ?? project.repoPath;
  const repoConfigCandidates =
    await readConfigCandidateLayerSources(effectiveRepoPath);

  const layers: ScriptSourceLayer[] = [];

  const localLayer = buildScriptSourceLayer(
    'local-override',
    `${BRAND.displayName} Local Override`,
    project.scripts,
    scriptName,
  );
  if (localLayer) {
    layers.push(localLayer);
  }

  layers.push(
    ...buildConfigScriptLayers({
      sourceKeyPrefix: 'repo-canopy',
      candidates: repoConfigCandidates,
      scriptName,
      getScripts: (manifest) => manifest.scripts,
    }),
  );

  if (isProjectLifecycleScriptName(scriptName)) {
    const conductorScripts = await readConductorJson(effectiveRepoPath);
    const conductorLayer = buildConductorLayer(
      'repo-conductor',
      'conductor.json',
      conductorScripts,
      scriptName,
    );
    if (conductorLayer) {
      layers.push(conductorLayer);
    }
  }

  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

export async function collectWorkspaceRootScriptLayers(
  workspaceId: string,
  scriptName: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<ScriptSourceLayer[]> {
  const localConfig = await readWorkspaceConfig(workspaceId);
  const workspaceManifest = await readWorkspaceCanopyManifest(
    localConfig,
    paths?.workspaceRootPath,
  );

  const layers: ScriptSourceLayer[] = [];

  const localLayer = buildScriptSourceLayer(
    'local-override',
    `${BRAND.displayName} Local Override`,
    localConfig.scripts,
    scriptName,
  );
  if (localLayer) {
    layers.push(localLayer);
  }

  const workspaceRootPath =
    paths?.workspaceRootPath ??
    (localConfig.sourceRepoPath
      ? await getBaselineReadPath(localConfig.sourceRepoPath)
      : undefined);

  if (workspaceRootPath) {
    const workspaceConfigCandidates =
      await readConfigCandidateLayerSources(workspaceRootPath);
    layers.push(
      ...buildConfigScriptLayers({
        sourceKeyPrefix: 'workspace-hook',
        sourceLabelSuffix: '(project)',
        candidates: workspaceConfigCandidates,
        scriptName,
        getScripts: (manifest) => manifest.scripts,
      }),
    );
  } else {
    const hookLayer = buildScriptSourceLayer(
      'workspace-hook',
      'Project config',
      workspaceManifest?.scripts,
      scriptName,
    );
    if (hookLayer) {
      layers.push(hookLayer);
    }
  }

  if (isProjectLifecycleScriptName(scriptName) && workspaceRootPath) {
    const conductorScripts = await readConductorJson(workspaceRootPath);
    const conductorLayer = buildConductorLayer(
      'workspace-conductor',
      'conductor.json',
      conductorScripts,
      scriptName,
    );
    if (conductorLayer) {
      layers.push(conductorLayer);
    }
  }

  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

export async function collectWorkspaceRepoScriptLayers(
  workspaceId: string,
  repoId: string,
  scriptName: string,
  paths?: WorkspaceScriptResolutionPaths,
): Promise<ScriptSourceLayer[]> {
  const { localConfig, repo, repoPath, workspaceManifestRepo } =
    await readWorkspaceRepoLayerContext(workspaceId, repoId, paths);

  const layers: ScriptSourceLayer[] = [];

  const localLayer = buildScriptSourceLayer(
    'local-override',
    `${BRAND.displayName} Local Override`,
    repo.scripts,
    scriptName,
  );
  if (localLayer) {
    layers.push(localLayer);
  }

  const workspaceRootPath =
    paths?.workspaceRootPath ??
    (localConfig.sourceRepoPath
      ? await getBaselineReadPath(localConfig.sourceRepoPath)
      : undefined);
  if (workspaceRootPath) {
    const workspaceConfigCandidates =
      await readConfigCandidateLayerSources(workspaceRootPath);
    layers.push(
      ...buildConfigScriptLayers({
        sourceKeyPrefix: 'workspace-manifest',
        sourceLabelSuffix: '(project manifest)',
        candidates: workspaceConfigCandidates,
        scriptName,
        getScripts: (manifest) =>
          getManifestRepoById(manifest, repoId)?.scripts,
      }),
    );
  } else {
    const manifestLayer = buildScriptSourceLayer(
      'workspace-manifest',
      'Project manifest',
      workspaceManifestRepo?.scripts,
      scriptName,
    );
    if (manifestLayer) {
      layers.push(manifestLayer);
    }
  }

  const repoConfigCandidates = await readConfigCandidateLayerSources(repoPath);
  layers.push(
    ...buildConfigScriptLayers({
      sourceKeyPrefix: 'repo-canopy',
      candidates: repoConfigCandidates,
      scriptName,
      getScripts: (manifest) => manifest.scripts,
    }),
  );

  if (isProjectLifecycleScriptName(scriptName)) {
    const conductorScripts = await readConductorJson(repoPath);
    const conductorLayer = buildConductorLayer(
      'repo-conductor',
      'conductor.json',
      conductorScripts,
      scriptName,
    );
    if (conductorLayer) {
      layers.push(conductorLayer);
    }
  }

  assignEffectiveSourceLayerStatus(layers);
  return layers;
}
