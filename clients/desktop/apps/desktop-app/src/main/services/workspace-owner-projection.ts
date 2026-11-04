import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import { backgroundExecutionDeniedMessage } from '@canopy/desktop-shared/node/background-execution-context';
import type { readWorkspaceConfigDetailed } from '../lib/workspace-persistence';

export type WorkspaceOwnerManifestRead = Awaited<
  ReturnType<typeof readWorkspaceConfigDetailed>
>;

export interface BackgroundWorkspaceTarget {
  workspaceOwner: WorkspaceContext;
  linkedPersonalCandidate: boolean;
  ownershipTransferred: boolean;
  /** Absent for App Advisor, which has no workspace. */
  workspaceType?: WorkspaceType;
  privateMemory: boolean;
  /** Private-memory callers fail closed when its fields failed validation. */
  memoryMalformed: boolean;
}

/** Owner provenance is identical for fresh execution reads and snapshot evidence. */
export function projectBackgroundWorkspaceTarget(
  read: WorkspaceOwnerManifestRead | undefined,
): BackgroundWorkspaceTarget {
  if (!read || read.authority !== 'ok' || read.ownerMalformed)
    throw new Error(backgroundExecutionDeniedMessage('unknown-provenance'));
  return {
    workspaceOwner: read.config.owner
      ? {
          kind: 'organization',
          organizationId: read.config.owner.organizationId,
        }
      : { kind: 'personal' },
    linkedPersonalCandidate: read.config.type === 'single-repo',
    ownershipTransferred: read.config.ownershipTransfer !== undefined,
    workspaceType: read.config.type,
    privateMemory: read.config.privateMemory === true,
    memoryMalformed: read.memoryMalformed,
  };
}
