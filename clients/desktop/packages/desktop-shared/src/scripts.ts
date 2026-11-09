import { BRAND } from '@canopy/brand/current';
import { brandEnvCandidates } from '@canopy/execution-engine/brand/env';
import {
  compareScriptNames,
  isLifecycleScriptName,
  isScriptDefinition,
  type CommandShellDefinition,
  type ScriptDefinition,
  type ScriptDevServerPattern,
  type ScriptLifecyclePhase,
  type ScriptOverrides,
  type ScriptScope,
} from '@canopy/protocol/scripts';
import {
  parseWorkspaceRepoScopedValue,
  titleCaseIdentifier,
} from './lib/scoped-config-utils';

export * from '@canopy/protocol/scripts';

export interface ScriptEnvVarDefinition {
  name: string;
  description: string;
}

export interface RunnableScriptEntry {
  name: string;
  command: string;
  lifecycle: ScriptLifecyclePhase | 'custom';
  timeoutSeconds?: number | null;
  devServerPattern?: ScriptDevServerPattern;
  shell?: CommandShellDefinition;
  interactive?: boolean;
}

const SCRIPT_ENV_SUFFIX_DEFINITIONS: ScriptEnvVarDefinition[] = [
  {
    name: 'WORKSPACE_ID',
    description: 'Project id for the current script target.',
  },
  {
    name: 'WORKTREE_NAME',
    description: 'Animal-name id of the current worktree.',
  },
  {
    name: 'WORKTREE_DATA_DIR',
    description: `Path to ${BRAND.displayName} data for the current worktree.`,
  },
  {
    name: 'WORKSPACE_CHILD_REPO_ID',
    description: 'Child repo id for project child-repo scripts when available.',
  },
];

export const SCRIPT_ENV_VAR_DEFINITIONS: ScriptEnvVarDefinition[] =
  SCRIPT_ENV_SUFFIX_DEFINITIONS.flatMap((definition) =>
    brandEnvCandidates(definition.name).map((name, index) => ({
      name,
      description:
        index === 0
          ? definition.description
          : `${definition.description} Legacy compatibility alias.`,
    })),
  );

export const SCRIPT_ENV_VISIBLE_VAR_DEFINITIONS: ScriptEnvVarDefinition[] =
  SCRIPT_ENV_SUFFIX_DEFINITIONS.map((definition) => ({
    name: brandEnvCandidates(definition.name)[0] ?? definition.name,
    description: definition.description,
  }));

export function shouldRefreshDiscoveryAfterScriptLifecycle(
  lifecycle: ScriptLifecyclePhase | 'custom',
): boolean {
  return (
    lifecycle === 'before-setup' ||
    lifecycle === 'setup' ||
    lifecycle === 'after-setup'
  );
}

/**
 * Legacy helper that normalizes a plain string-or-null script value. Retained
 * for callers that only ever produce string commands (legacy `setupScript` /
 * `runScript` / `teardownScript` fields). New callers should prefer
 * {@link normalizeScriptDefinition}, which accepts the wider `ScriptValue`
 * shape.
 */
export function normalizeScriptValue(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the canonical script definition (command + optional timeout) for the
 * given script name. Returns `undefined` for missing entries and null
 * tombstones.
 */
export function getScriptDefinition(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): ScriptDefinition | undefined {
  const value = scripts?.[scriptName];
  if (typeof value === 'string') {
    return { command: value };
  }
  if (isScriptDefinition(value)) {
    return value;
  }
  return undefined;
}

export function getScriptCommand(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): string | undefined {
  const value = scripts?.[scriptName];
  if (typeof value === 'string') {
    return value;
  }
  if (isScriptDefinition(value)) {
    return value.command;
  }
  return undefined;
}

/**
 * Return the configured `timeoutSeconds` for a script as stored on the
 * overrides record. Plain string overrides return `undefined` (use the global
 * default); object overrides return whatever the user persisted (a positive
 * integer or `null` for "disabled"). Missing entries and null tombstones
 * return `undefined`.
 */
export function getScriptTimeoutSeconds(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): number | null | undefined {
  const value = scripts?.[scriptName];
  if (isScriptDefinition(value)) {
    return value.timeoutSeconds;
  }
  return undefined;
}

/**
 * Return the configured `devServerPattern` for a script as stored on the
 * overrides record. Plain string overrides have no pattern attached and
 * return `undefined`; object overrides return whatever the user persisted.
 * Missing entries and null tombstones return `undefined`.
 *
 * The renderer and main process both call this helper against the same
 * effective scripts map so optimistic-start descriptors agree with the
 * descriptor the main process emits over IPC.
 */
export function getScriptDevServerPattern(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): ScriptDevServerPattern | undefined {
  const value = scripts?.[scriptName];
  if (isScriptDefinition(value)) {
    return value.devServerPattern;
  }
  return undefined;
}

export function getScriptShellDefinition(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): CommandShellDefinition | undefined {
  const value = scripts?.[scriptName];
  if (isScriptDefinition(value)) {
    return value.shell;
  }
  return undefined;
}

export function getScriptInteractive(
  scripts: ScriptOverrides | undefined,
  scriptName: string,
): boolean {
  const value = scripts?.[scriptName];
  return isScriptDefinition(value) && value.interactive === true;
}

export function listRunnableScripts(
  scripts: ScriptOverrides | undefined,
): RunnableScriptEntry[] {
  if (!scripts) {
    return [];
  }

  const runnableEntries: RunnableScriptEntry[] = [];
  for (const [scriptName, scriptValue] of Object.entries(scripts)) {
    let command: string | undefined;
    let timeoutSeconds: number | null | undefined;
    let devServerPattern: ScriptDevServerPattern | undefined;
    let shell: CommandShellDefinition | undefined;
    let interactive: boolean | undefined;
    if (typeof scriptValue === 'string') {
      command = scriptValue;
    } else if (isScriptDefinition(scriptValue)) {
      command = scriptValue.command;
      timeoutSeconds = scriptValue.timeoutSeconds;
      devServerPattern = scriptValue.devServerPattern;
      shell = scriptValue.shell;
      interactive = scriptValue.interactive;
    } else {
      continue;
    }
    if (!command) {
      continue;
    }
    const entry: RunnableScriptEntry = {
      name: scriptName,
      command,
      lifecycle: isLifecycleScriptName(scriptName) ? scriptName : 'custom',
    };
    if (timeoutSeconds !== undefined) {
      entry.timeoutSeconds = timeoutSeconds;
    }
    if (devServerPattern !== undefined) {
      entry.devServerPattern = devServerPattern;
    }
    if (shell !== undefined) {
      entry.shell = shell;
    }
    if (interactive === true) {
      entry.interactive = true;
    }
    runnableEntries.push(entry);
  }

  runnableEntries.sort((left, right) =>
    compareScriptNames(left.name, right.name),
  );
  return runnableEntries;
}

export function getScriptDisplayName(scriptName: string): string {
  if (scriptName === 'setup') {
    return 'Setup';
  }
  if (scriptName === 'launch') {
    return 'Launch';
  }
  if (scriptName === 'teardown') {
    return 'Teardown';
  }

  return titleCaseIdentifier(scriptName);
}

export function createScriptEnvVarToken(name: string): string {
  return `$${name}`;
}

export function createScriptKey(
  scope: ScriptScope,
  scriptName: string,
  repoId?: string,
): string {
  if (scope === 'workspace-root') {
    return `workspace-root:${scriptName}`;
  }

  if (scope === 'workspace-repo') {
    if (!repoId) {
      throw new Error('repoId is required for workspace-repo script keys');
    }
    return `workspace-repo:${repoId}:${scriptName}`;
  }

  return `project:${scriptName}`;
}

export function parseScriptKey(
  scriptKey: string,
): { scope: ScriptScope; scriptName: string; repoId?: string } | null {
  if (scriptKey.startsWith('project:')) {
    const scriptName = scriptKey.slice('project:'.length);
    if (scriptName.length === 0) {
      return null;
    }
    return {
      scope: 'project',
      scriptName,
    };
  }

  if (scriptKey.startsWith('workspace-root:')) {
    const scriptName = scriptKey.slice('workspace-root:'.length);
    if (scriptName.length === 0) {
      return null;
    }
    return {
      scope: 'workspace-root',
      scriptName,
    };
  }

  if (scriptKey.startsWith('workspace-repo:')) {
    const parsed = parseWorkspaceRepoScopedValue(scriptKey, 'workspace-repo:');
    if (!parsed) {
      return null;
    }
    return {
      scope: 'workspace-repo',
      repoId: parsed.repoId,
      scriptName: parsed.scopedValue,
    };
  }

  return null;
}
