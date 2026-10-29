import { isAbsolute } from 'node:path';
import type { OrgProjectRepository } from '@canopy/protocol/org-projects';

export function buildOrgProjectCloneUrl(
  repository: OrgProjectRepository,
  protocol: 'https' | 'ssh',
  e2eBase?: string,
): string {
  if (
    !/^[a-zA-Z0-9.-]+$/.test(repository.host) ||
    !/^[a-zA-Z0-9_-]+$/.test(repository.owner) ||
    !/^[a-zA-Z0-9_.-]+$/.test(repository.name) ||
    repository.name === '.' ||
    repository.name === '..'
  ) {
    throw new Error('Invalid repository identity');
  }
  if (e2eBase !== undefined) {
    if (!isAbsolute(e2eBase) && !e2eBase.startsWith('file://'))
      throw new Error('Invalid local clone base');
    return `${e2eBase.replace(/\/$/, '')}/${repository.owner}/${repository.name}.git`;
  }
  return protocol === 'ssh'
    ? `git@${repository.host}:${repository.owner}/${repository.name}.git`
    : `https://${repository.host}/${repository.owner}/${repository.name}.git`;
}
