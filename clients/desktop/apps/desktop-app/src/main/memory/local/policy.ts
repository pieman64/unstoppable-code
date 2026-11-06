import {
  APP_ADVISOR_PROJECT_ID,
  CODE_REVIEW_CHAT_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
} from '@canopy/desktop-shared/types';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { readWorkspaceConfigDetailed } from '../../lib/workspace-persistence';
import { resolveMemoryWorkspaceId } from './workspace-scope';

export type LocalMemoryPolicy =
  | { kind: 'unscoped' }
  | { kind: 'blocked'; workspaceId: string }
  | {
      kind: 'scoped';
      workspaceId: string;
      privateMemory: boolean;
      /** The organization project the workspace belongs to, when it has one. */
      owner?: { organizationId: string; projectId: string };
    };

/** Read at the operation boundary: a long-lived chat must see toggle changes. */
export async function resolveLocalMemoryPolicy(options: {
  projectId: string;
  worktreeId: string;
}): Promise<LocalMemoryPolicy> {
  if (options.projectId === APP_ADVISOR_PROJECT_ID) {
    return { kind: 'unscoped' };
  }
  let workspaceId: string | null;
  try {
    workspaceId = await resolveMemoryWorkspaceId(options);
  } catch (error) {
    logMainProcessWarn(
      '[local-memory] project resolution failed; memory blocked',
      error,
    );
    return { kind: 'blocked', workspaceId: options.projectId };
  }
  if (workspaceId === null) {
    if (
      options.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
      options.projectId === CODE_REVIEW_CHAT_PROJECT_ID
    ) {
      return { kind: 'blocked', workspaceId: options.projectId };
    }
    return { kind: 'unscoped' };
  }
  try {
    const read = await readWorkspaceConfigDetailed(workspaceId);
    if (
      read.authority !== 'ok' ||
      read.ownerMalformed ||
      read.memoryMalformed
    ) {
      logMainProcessWarn(
        '[local-memory] project config unavailable; memory blocked',
        {
          workspaceId,
          authority: read.authority,
          ownerMalformed: read.ownerMalformed,
          memoryMalformed: read.memoryMalformed,
        },
      );
      return { kind: 'blocked', workspaceId };
    }
    const owner = read.config.owner;
    return {
      kind: 'scoped',
      workspaceId,
      privateMemory: read.config.privateMemory === true,
      ...(owner === undefined
        ? {}
        : {
            owner: {
              organizationId: owner.organizationId,
              projectId: owner.projectId,
            },
          }),
    };
  } catch (error) {
    logMainProcessWarn(
      '[local-memory] project config read failed; memory blocked',
      {
        workspaceId,
        error,
      },
    );
    return { kind: 'blocked', workspaceId };
  }
}
