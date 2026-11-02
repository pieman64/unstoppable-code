import {
  compareScriptNames,
  isLifecycleScriptName,
  isProjectLifecycleScriptName,
  isScriptDefinition,
  isScriptInteractiveSupported,
  normalizeScriptDefinition,
  normalizeScriptName,
  PROJECT_LIFECYCLE_SCRIPT_NAMES,
  type ProjectLifecycleScriptName,
  type ScriptDefinition,
  type ScriptValue,
} from '@canopy/protocol/scripts';
import type {
  CoreScriptDefinition,
  CoreScriptSourceKind,
  CoreScriptSourceLayer,
} from '@canopy/protocol/canopy-core';
import { assignEffectiveSourceLayerStatus } from '../initiated-work/hook-sources';

/*
 * Script source precedence. Hosts read the sources (local settings, the
 * workspace manifest, source-controlled `canopy.json` candidates and
 * `conductor.json`) and core decides which layer supplies each script. Core
 * never writes a source: local settings change only through the W5 command
 * `core.workspace.scripts.update`, and source-controlled files are read-only.
 */

export interface ResolvedScriptField {
  definition?: ScriptDefinition;
  value?: string;
  source: CoreScriptSourceKind;
}

export type ResolvedScriptMap = Record<string, ResolvedScriptField>;

/** A script map as a source stores it; `null` disables an inherited script. */
export type ScriptSourceMap = Readonly<Record<string, ScriptValue | undefined>>;

/** Lifecycle scripts mapped from `conductor.json` (`run` is `launch`). */
export type ConductorScripts = Partial<
  Record<ProjectLifecycleScriptName, string>
>;

/** Reads `conductor.json` only when a lifecycle script is still missing. */
export type ConductorScriptsReader = () => Promise<
  ConductorScripts | null | undefined
>;

/**
 * One source-controlled configuration file candidate, in priority order.
 * `present` is false when the file does not exist; `scripts` is the map the
 * layer reads from it.
 */
export interface ScriptConfigFile {
  fileName: string;
  present: boolean;
  scripts: ScriptSourceMap | undefined;
}

export interface ProjectScriptSources {
  /** The first configuration file that exists, as resolution reads it. */
  repoScripts: ScriptSourceMap | undefined;
  localScripts: ScriptSourceMap | undefined;
  readConductor: ConductorScriptsReader;
}

export interface WorkspaceRepoScriptSources extends ProjectScriptSources {
  /** The repository's entry in the workspace manifest. */
  workspaceManifestScripts: ScriptSourceMap | undefined;
}

export interface WorkspaceRootScriptSources {
  workspaceManifestScripts: ScriptSourceMap | undefined;
  localScripts: ScriptSourceMap | undefined;
  /** Absent when the workspace has no root checkout to read. */
  readConductor: ConductorScriptsReader | undefined;
}

export async function resolveProjectScriptMap(
  sources: ProjectScriptSources,
): Promise<ResolvedScriptMap> {
  const resolved: ResolvedScriptMap = {};
  applyScriptDefinitions(resolved, sources.repoScripts, 'repo-canopy');
  applyOverrideScripts(
    resolved,
    sources.localScripts,
    'local-override',
    'local-disabled',
  );
  await applyConductorFallbackScripts(
    resolved,
    sources.readConductor,
    'repo-conductor',
  );
  return resolved;
}

export async function resolveWorkspaceRepoScriptMap(
  sources: WorkspaceRepoScriptSources,
): Promise<ResolvedScriptMap> {
  const resolved: ResolvedScriptMap = {};
  applyScriptDefinitions(resolved, sources.repoScripts, 'repo-canopy');
  applyOverrideScripts(
    resolved,
    sources.workspaceManifestScripts,
    'workspace-manifest',
    'workspace-manifest-disabled',
  );
  applyOverrideScripts(
    resolved,
    sources.localScripts,
    'local-override',
    'local-disabled',
  );
  await applyConductorFallbackScripts(
    resolved,
    sources.readConductor,
    'repo-conductor',
  );
  return resolved;
}

export async function resolveWorkspaceRootScriptMap(
  sources: WorkspaceRootScriptSources,
): Promise<ResolvedScriptMap> {
  const resolved: ResolvedScriptMap = {};
  applyScriptDefinitions(
    resolved,
    sources.workspaceManifestScripts,
    'workspace-hook',
  );
  applyOverrideScripts(
    resolved,
    sources.localScripts,
    'local-override',
    'local-disabled',
  );
  if (sources.readConductor) {
    await applyConductorFallbackScripts(
      resolved,
      sources.readConductor,
      'workspace-conductor',
    );
  }
  return resolved;
}

function applyScriptDefinitions(
  resolved: ResolvedScriptMap,
  scripts: ScriptSourceMap | undefined,
  source: CoreScriptSourceKind,
): void {
  if (!scripts) {
    return;
  }
  for (const [scriptName, value] of Object.entries(scripts)) {
    const definition = normalizeScriptDefinition(value);
    if (!definition) {
      continue;
    }
    resolved[scriptName] = { definition, value: definition.command, source };
  }
}

function applyOverrideScripts(
  resolved: ResolvedScriptMap,
  scripts: ScriptSourceMap | undefined,
  enabledSource: CoreScriptSourceKind,
  disabledSource: CoreScriptSourceKind,
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
  readConductor: ConductorScriptsReader,
  source: CoreScriptSourceKind,
): Promise<void> {
  if (
    !PROJECT_LIFECYCLE_SCRIPT_NAMES.some(
      (scriptName) => resolved[scriptName] === undefined,
    )
  ) {
    return;
  }
  const scripts = await readConductor();
  if (!scripts) {
    return;
  }
  for (const [scriptName, value] of Object.entries(scripts)) {
    if (typeof value !== 'string' || resolved[scriptName] !== undefined) {
      continue;
    }
    resolved[scriptName] = { definition: { command: value }, value, source };
  }
}

// ---------------------------------------------------------------------------
// Source layers: every layer that defines one script, without collapsing.
// ---------------------------------------------------------------------------

type LayerSource = CoreScriptSourceLayer['source'];

function scriptLayer(
  sourceKey: string,
  source: LayerSource,
  scripts: ScriptSourceMap | undefined,
  scriptName: string,
  file?: string,
): CoreScriptSourceLayer | null {
  if (!scripts || !(scriptName in scripts)) {
    return null;
  }
  const value = scripts[scriptName];
  const base = file ? { sourceKey, source, file } : { sourceKey, source };
  if (value === null) {
    return { ...base, command: null, status: 'disabled' };
  }
  if (typeof value === 'string') {
    return { ...base, command: value, status: 'active' };
  }
  // Layers stay command-only; timeouts and shells are reported on the
  // resolved definition.
  if (isScriptDefinition(value)) {
    return { ...base, command: value.command, status: 'active' };
  }
  return null;
}

async function conductorLayer(
  sourceKey: 'repo-conductor' | 'workspace-conductor',
  readConductor: ConductorScriptsReader,
  scriptName: string,
): Promise<CoreScriptSourceLayer | null> {
  if (!isProjectLifecycleScriptName(scriptName)) {
    return null;
  }
  const value = (await readConductor())?.[scriptName];
  return typeof value === 'string'
    ? {
        sourceKey,
        source: sourceKey,
        file: 'conductor.json',
        command: value,
        status: 'active',
      }
    : null;
}

/**
 * The layers of the configuration file candidates. Resolution reads only the
 * first file that exists, so a script found only in a lower-priority file is
 * an overridden fallback once a higher-priority file exists, and a missing
 * higher-priority file and the file in use are listed for context.
 */
function configFileLayers(
  source: 'repo-canopy' | 'workspace-hook' | 'workspace-manifest',
  files: readonly ScriptConfigFile[],
  scriptName: string,
): CoreScriptSourceLayer[] {
  const selectedIndex = files.findIndex((file) => file.present);
  const fileLayers = files.map((file, index) => {
    if (!file.present) {
      return null;
    }
    const layer = scriptLayer(
      `${source}:${file.fileName}`,
      source,
      file.scripts,
      scriptName,
      file.fileName,
    );
    if (layer && selectedIndex >= 0 && index > selectedIndex) {
      layer.status = 'overridden';
      layer.note = 'overridden-fallback';
    }
    return layer;
  });
  const hasAnyLayer = fileLayers.some((layer) => layer !== null);
  const layers: CoreScriptSourceLayer[] = [];
  files.forEach((file, index) => {
    const layer = fileLayers[index];
    if (layer) {
      layers.push(layer);
      return;
    }
    if (!hasAnyLayer) {
      return;
    }
    if (selectedIndex > index && !file.present) {
      layers.push(contextLayer(source, file.fileName, 'not-found'));
    } else if (selectedIndex === index && file.present) {
      layers.push(contextLayer(source, file.fileName, 'used-config'));
    }
  });
  return layers;
}

function contextLayer(
  source: LayerSource,
  fileName: string,
  note: 'not-found' | 'used-config',
): CoreScriptSourceLayer {
  return {
    sourceKey: `${source}:${fileName}`,
    source,
    file: fileName,
    note,
    command: null,
    status: 'absent',
  };
}

function pushLayer(
  layers: CoreScriptSourceLayer[],
  layer: CoreScriptSourceLayer | null,
): void {
  if (layer) {
    layers.push(layer);
  }
}

export async function collectProjectScriptLayers(input: {
  scriptName: string;
  localScripts: ScriptSourceMap | undefined;
  repoConfigFiles: readonly ScriptConfigFile[];
  readConductor: ConductorScriptsReader;
}): Promise<CoreScriptSourceLayer[]> {
  const { scriptName } = input;
  const layers: CoreScriptSourceLayer[] = [];
  pushLayer(
    layers,
    scriptLayer(
      'local-override',
      'local-override',
      input.localScripts,
      scriptName,
    ),
  );
  layers.push(
    ...configFileLayers('repo-canopy', input.repoConfigFiles, scriptName),
  );
  pushLayer(
    layers,
    await conductorLayer('repo-conductor', input.readConductor, scriptName),
  );
  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

export async function collectWorkspaceRootScriptLayers(input: {
  scriptName: string;
  localScripts: ScriptSourceMap | undefined;
  /** The root checkout's configuration files; absent without a root checkout. */
  workspaceConfigFiles: readonly ScriptConfigFile[] | undefined;
  workspaceManifestScripts: ScriptSourceMap | undefined;
  readConductor: ConductorScriptsReader | undefined;
}): Promise<CoreScriptSourceLayer[]> {
  const { scriptName } = input;
  const layers: CoreScriptSourceLayer[] = [];
  pushLayer(
    layers,
    scriptLayer(
      'local-override',
      'local-override',
      input.localScripts,
      scriptName,
    ),
  );
  if (input.workspaceConfigFiles) {
    layers.push(
      ...configFileLayers(
        'workspace-hook',
        input.workspaceConfigFiles,
        scriptName,
      ),
    );
  } else {
    pushLayer(
      layers,
      scriptLayer(
        'workspace-hook',
        'workspace-hook',
        input.workspaceManifestScripts,
        scriptName,
      ),
    );
  }
  if (input.readConductor) {
    pushLayer(
      layers,
      await conductorLayer(
        'workspace-conductor',
        input.readConductor,
        scriptName,
      ),
    );
  }
  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

export async function collectWorkspaceRepoScriptLayers(input: {
  scriptName: string;
  localScripts: ScriptSourceMap | undefined;
  /** The repository's entries in the root checkout's configuration files. */
  workspaceConfigFiles: readonly ScriptConfigFile[] | undefined;
  workspaceManifestScripts: ScriptSourceMap | undefined;
  repoConfigFiles: readonly ScriptConfigFile[];
  readConductor: ConductorScriptsReader;
}): Promise<CoreScriptSourceLayer[]> {
  const { scriptName } = input;
  const layers: CoreScriptSourceLayer[] = [];
  pushLayer(
    layers,
    scriptLayer(
      'local-override',
      'local-override',
      input.localScripts,
      scriptName,
    ),
  );
  if (input.workspaceConfigFiles) {
    layers.push(
      ...configFileLayers(
        'workspace-manifest',
        input.workspaceConfigFiles,
        scriptName,
      ),
    );
  } else {
    pushLayer(
      layers,
      scriptLayer(
        'workspace-manifest',
        'workspace-manifest',
        input.workspaceManifestScripts,
        scriptName,
      ),
    );
  }
  layers.push(
    ...configFileLayers('repo-canopy', input.repoConfigFiles, scriptName),
  );
  pushLayer(
    layers,
    await conductorLayer('repo-conductor', input.readConductor, scriptName),
  );
  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

// ---------------------------------------------------------------------------
// Portable projection: what a run would select, without starting one.
// ---------------------------------------------------------------------------

function lifecycleRole(scriptName: string): CoreScriptDefinition['lifecycle'] {
  return isLifecycleScriptName(scriptName) ? scriptName : 'custom';
}

/**
 * The resolved script as a run would see it: the effective interactive mode,
 * the timeout rule and the shell chosen on each operating system. Mirrors the
 * scripts service and runner, which stay the execution owners (CAN-4143).
 */
export function toCoreScriptDefinition(
  name: string,
  field: ResolvedScriptField,
): CoreScriptDefinition {
  const lifecycle = lifecycleRole(name);
  const { definition } = field;
  if (!definition) {
    return { state: 'disabled', name, lifecycle, source: field.source };
  }
  const interactive =
    definition.interactive === true && isScriptInteractiveSupported(name);
  return {
    state: 'enabled',
    name,
    lifecycle,
    source: field.source,
    command: definition.command,
    interactive,
    timeout:
      name === 'launch'
        ? { kind: 'none', reason: 'launch' }
        : interactive
          ? { kind: 'none', reason: 'interactive' }
          : definition.timeoutSeconds === null
            ? { kind: 'none', reason: 'disabled' }
            : definition.timeoutSeconds === undefined
              ? { kind: 'default' }
              : { kind: 'custom', seconds: definition.timeoutSeconds },
    shell: {
      windows: definition.shell?.windows ?? 'default',
      mac: definition.shell?.mac ?? 'default',
      linux: definition.shell?.linux ?? 'bash',
    },
    ...(definition.devServerPattern === undefined
      ? {}
      : { devServerPattern: definition.devServerPattern }),
  };
}

/** Resolved scripts in lifecycle order, then by name. */
export function listCoreScriptDefinitions(
  resolved: ResolvedScriptMap,
): CoreScriptDefinition[] {
  return Object.keys(resolved)
    .sort(compareScriptNames)
    .flatMap((name) => {
      const field = resolved[name];
      return field ? [toCoreScriptDefinition(name, field)] : [];
    });
}

/**
 * A target's own settings as a resolved map: the layer `upsert` and `delete`
 * change. Names and values are normalized as the settings writer stores them.
 */
export function resolveLocalScriptMap(
  scripts: ScriptSourceMap | undefined,
): ResolvedScriptMap {
  const resolved: ResolvedScriptMap = {};
  for (const [rawName, value] of Object.entries(scripts ?? {})) {
    const name = normalizeScriptName(rawName);
    if (!name) {
      continue;
    }
    if (value === null) {
      resolved[name] = { source: 'local-disabled' };
      continue;
    }
    const definition = normalizeScriptDefinition(value);
    if (definition) {
      resolved[name] = {
        definition,
        value: definition.command,
        source: 'local-override',
      };
    }
  }
  return resolved;
}
