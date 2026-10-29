import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { LocalMemoryPolicy } from '../../memory/local/policy';
import {
  isPrivatePartition,
  isPrivatePartitionOfWorkspace,
  parsePartitionKey,
  partitionKeyFor,
  resolveTurnPartition,
  type PartitionResolverDeps,
} from '../partition';

jest.mock('../../agents/work-owner', () => ({
  peekSessionWorkOwner: jest.fn(),
  resolveBackgroundWorkOwner: jest.fn(),
}));
jest.mock('../../memory/local/policy', () => ({
  resolveLocalMemoryPolicy: jest.fn(),
}));

const ids = { projectId: 'ws-1', worktreeId: 'wt-1', chatId: 'chat-1' };
const org: WorkOwner = { kind: 'organization', organizationId: 'org-1' };

function deps(
  policy: LocalMemoryPolicy,
  sessionOwner: WorkOwner | undefined,
  persistedOwner: WorkOwner | undefined = undefined,
): PartitionResolverDeps {
  return {
    resolvePolicy: jest.fn(() => Promise.resolve(policy)),
    peekSessionOwner: jest.fn(() => Promise.resolve(sessionOwner)),
    resolvePersistedOwner: jest.fn(() => Promise.resolve(persistedOwner)),
  };
}

describe('skill suggestion partitions', () => {
  it('builds and parses partition keys', () => {
    expect(partitionKeyFor({ kind: 'personal' }, null)).toBe('personal');
    expect(partitionKeyFor(org, null)).toBe('org:org-1');
    expect(partitionKeyFor(org, 'ws-9')).toBe('org:org-1/private:ws-9');
    expect(parsePartitionKey('org:org-1/private:ws-9')).toEqual({
      key: 'org:org-1/private:ws-9',
      owner: org,
      privateWorkspaceId: 'ws-9',
    });
    expect(parsePartitionKey('personal')?.owner).toEqual({ kind: 'personal' });
    expect(parsePartitionKey('bogus')).toBeNull();
    expect(parsePartitionKey('personal/private:')).toBeNull();
    expect(isPrivatePartition('personal/private:ws-9')).toBe(true);
    expect(isPrivatePartition('org:org-1')).toBe(false);
    expect(isPrivatePartitionOfWorkspace('personal/private:ws-9', 'ws-9')).toBe(
      true,
    );
    expect(isPrivatePartitionOfWorkspace('personal/private:ws-9', 'ws-1')).toBe(
      false,
    );
  });

  it('uses the session owner for org and personal work', async () => {
    const scoped: LocalMemoryPolicy = {
      kind: 'scoped',
      workspaceId: 'ws-1',
      privateMemory: false,
    };
    expect((await resolveTurnPartition(ids, deps(scoped, org)))?.key).toBe(
      'org:org-1',
    );
    expect(
      (await resolveTurnPartition(ids, deps(scoped, { kind: 'personal' })))
        ?.key,
    ).toBe('personal');
  });

  it('falls back to the persisted workspace owner', async () => {
    const d = deps(
      { kind: 'scoped', workspaceId: 'ws-1', privateMemory: false },
      undefined,
      org,
    );
    expect((await resolveTurnPartition(ids, d))?.key).toBe('org:org-1');
    expect(d.resolvePersistedOwner).toHaveBeenCalledWith('ws-1');
  });

  it('keeps private workspaces in their own partition', async () => {
    const partition = await resolveTurnPartition(
      ids,
      deps({ kind: 'scoped', workspaceId: 'ws-1', privateMemory: true }, org),
    );
    expect(partition).toEqual({
      key: 'org:org-1/private:ws-1',
      owner: org,
      privateWorkspaceId: 'ws-1',
    });
  });

  it('records nothing for blocked, unscoped or ownerless turns', async () => {
    expect(
      await resolveTurnPartition(
        ids,
        deps({ kind: 'blocked', workspaceId: 'ws-1' }, org),
      ),
    ).toBeNull();
    expect(
      await resolveTurnPartition(ids, deps({ kind: 'unscoped' }, org)),
    ).toBeNull();
    expect(
      await resolveTurnPartition(
        ids,
        deps(
          { kind: 'scoped', workspaceId: 'ws-1', privateMemory: false },
          undefined,
          undefined,
        ),
      ),
    ).toBeNull();
  });
});
