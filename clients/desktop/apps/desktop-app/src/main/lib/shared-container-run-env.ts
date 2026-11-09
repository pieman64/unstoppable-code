import { brandEnvCandidates } from '@canopy/execution-engine/brand/env';
import { getLoginShellPath } from '../pipelines/config-paths';
import { isBlockedManagedEnvName } from '@canopy/core-runtime/node/terminal';

const BASE_ENV_NAMES = [
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'COLORTERM',
  'TMPDIR',
  'SystemRoot',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'TEMP',
  'ComSpec',
  'PATHEXT',
] as const;
const FORBIDDEN_DECLARED_NAMES = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'GIT_SSH_COMMAND',
  'SSH_AUTH_SOCK',
  'WORKSPACE_ID',
  'WORKTREE_DATA_DIR',
  'CONDUCTOR_WORKSPACE_NAME',
  ...brandEnvCandidates('WORKSPACE_ID'),
  ...brandEnvCandidates('WORKTREE_DATA_DIR'),
  ...brandEnvCandidates('CONDUCTOR_WORKSPACE_NAME'),
]);

function isForbiddenDeclaredName(name: string): boolean {
  const normalized = name.toUpperCase();
  return (
    FORBIDDEN_DECLARED_NAMES.has(normalized) ||
    normalized.startsWith('GIT_CONFIG_')
  );
}

export function isAllowedSharedContainerRunEnvName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !isBlockedManagedEnvName(name) &&
    !isForbiddenDeclaredName(name) &&
    name.toUpperCase() !== 'PATH'
  );
}

/**
 * Builds the deliberately narrow environment for publisher-authored code.
 * Keeping HOME makes this an accidental-secret reduction, not a sandbox: the
 * child still runs as the recipient and can read and write their home folder.
 */
export function buildSharedContainerRunEnv(
  _containerId: string,
  values: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { PATH: getLoginShellPath() };
  for (const name of BASE_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(values)) {
    if (isAllowedSharedContainerRunEnvName(name)) result[name] = value;
  }
  return result;
}
