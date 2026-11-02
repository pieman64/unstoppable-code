import type {
  CanopyClient,
  CommandMap,
  DomainEventMap,
  QueryMap,
} from '@canopy/app-core';
import type {
  ManagedDelegationExtendLifetimeLimitResult,
  ManagedDelegationLifetimeStatus,
} from '@canopy/protocol/delegation';

declare const client: CanopyClient;

const lifetimeStatus: Promise<ManagedDelegationLifetimeStatus> = client.query(
  'delegation.lifetimeStatus',
  { projectId: 'project-1', worktreeId: 'worktree-1' },
);
const lifetimeExtension: Promise<ManagedDelegationExtendLifetimeLimitResult> =
  client.command('delegation.extendLifetimeLimit', {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
  });
const statusArgs: QueryMap['delegation.lifetimeStatus']['args'] = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};
const extensionArgs: CommandMap['delegation.extendLifetimeLimit']['args'] = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};
const changedEvent: DomainEventMap['delegation.lifetimeChanged'] = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  occurredAt: '2026-10-22T00:00:00.000Z',
};

void lifetimeStatus;
void lifetimeExtension;
void statusArgs;
void extensionArgs;
void changedEvent;
