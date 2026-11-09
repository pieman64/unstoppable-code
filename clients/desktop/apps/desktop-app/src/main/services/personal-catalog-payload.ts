import { createHash } from 'node:crypto';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
export interface PersonalCatalogPayload {
  personalCatalogId: string;
  name: string;
  kind: 'CODE' | 'COWORK';
  topology: 'SINGLE_REPO' | 'MULTI_REPO';
  location: 'LOCAL';
  repositories: Array<{ host: string; ownerLogin: string; repoName: string }>;
  deviceId: string;
  installationGeneration: number;
  localWorkspaceId: string;
}
export interface PersonalCatalogSource {
  personalCatalogId: string;
  name: string;
  type: 'single-repo' | 'multi-repo' | 'cowork';
  remotes: string[];
  deviceId: string;
  installationGeneration: number;
  localWorkspaceId: string;
}
export function buildPersonalCatalogPayload(
  source: PersonalCatalogSource,
): PersonalCatalogPayload | null {
  const localWorkspaceId = boundedLocalWorkspaceId(source.localWorkspaceId);
  if (localWorkspaceId === null) return null;
  const repositories: PersonalCatalogPayload['repositories'] = [];
  for (const remote of source.remotes.slice(0, 100)) {
    try {
      const url = new URL(
        remote.startsWith('git@')
          ? remote.replace(/^git@([^:]+):/, 'ssh://$1/')
          : remote,
      );
      if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) continue;
      const parts = url.pathname
        .replace(/^\//, '')
        .replace(/\.git$/, '')
        .split('/');
      const ownerLogin = parts[0];
      const repoName = parts[1];
      if (
        parts.length !== 2 ||
        !ownerLogin ||
        !repoName ||
        ![url.hostname, ownerLogin, repoName].every(
          (value) =>
            /^[a-zA-Z0-9_.-]{1,255}$/.test(value) &&
            redactSecrets(value) === value,
        )
      )
        continue;
      repositories.push({ host: url.hostname, ownerLogin, repoName });
    } catch {
      /* Local paths and malformed remotes carry no repository identity. */
    }
  }
  return {
    personalCatalogId: source.personalCatalogId,
    name: scrubProjectName(source.name),
    kind: source.type === 'cowork' ? 'COWORK' : 'CODE',
    topology: source.type === 'multi-repo' ? 'MULTI_REPO' : 'SINGLE_REPO',
    location: 'LOCAL',
    repositories,
    deviceId: source.deviceId,
    installationGeneration: source.installationGeneration,
    localWorkspaceId,
  };
}

/**
 * A project name safe to send to the Cloud: paths removed before generic
 * home-directory redaction can split them (spaces, quotes, <, > and | are
 * valid POSIX path characters, so a path runs to the end of the line,
 * favoring privacy over ambiguous prose), then secrets redacted.
 */
export function scrubProjectName(name: string): string {
  return (
    redactSecrets(name.replace(/(?:[A-Za-z]:[\\/]|\\\\|\/)[^\r\n]*/g, '[path]'))
      .slice(0, 256)
      .trim() || 'Untitled project'
  );
}

/**
 * Workspace ids are slugs of user-chosen names with no upper bound, while the
 * registration contract caps `localWorkspaceId` at 128 characters. A longer id
 * maps to a stable, collision-resistant derivation instead of being dropped.
 */
export function boundedLocalWorkspaceId(id: string): string | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) return null;
  if (id.length <= 128) return id;
  return `${id.slice(0, 63)}-${createHash('sha256').update(id).digest('hex')}`;
}
