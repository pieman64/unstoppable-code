import type { SharedContainerPublishTarget } from './scheduler';
import { publishCodeSharedContainerRevision } from './code';
import { publishCoworkSharedContainerRevision } from './cowork';
import type { SharedContainerPublicationRecord } from '../publication-state';

export async function publishSharedContainerRevisionForTarget(
  target: SharedContainerPublishTarget,
): Promise<SharedContainerPublicationRecord> {
  switch (target.containerType) {
    case 'CODE_WORKTREE':
      return publishCodeSharedContainerRevision(target);
    case 'COWORK_WORK_ENTRY':
      return publishCoworkSharedContainerRevision(target);
    case 'CLOUD_CHAT':
      throw new Error('Cloud chat containers cannot be published by desktop');
    default: {
      const _exhaustive: never = target.containerType;
      void _exhaustive;
      throw new Error('Unsupported shared-container type');
    }
  }
}
