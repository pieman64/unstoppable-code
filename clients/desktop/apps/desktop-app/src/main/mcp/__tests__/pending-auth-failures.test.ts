import type { AuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import {
  claimPendingAuthFailures,
  clearPendingAuthFailures,
  PENDING_AUTH_FAILURE_TTL_MS,
  recordPendingInjectedToolAuthFailure,
  recordPendingMcpAuthFailure,
} from '../pending-auth-failures';

function failure(serverId: string): AuthDependencyFailure {
  return {
    dependencyClass: 'mcp',
    dependencyId: `${serverId}:cfg-1`,
    displayName: `Server ${serverId}`,
    failureClass: 'expired',
    recovery: { kind: 'mcp_oauth', serverId, configId: 'cfg-1' },
  };
}

const githubFailure: AuthDependencyFailure = {
  dependencyClass: 'integration',
  dependencyId: 'integration:github',
  displayName: 'GitHub',
  failureClass: 'unauthenticated',
  recovery: { kind: 'github_login' },
};

describe('pending auth failures', () => {
  afterEach(() => {
    clearPendingAuthFailures('owner-a');
    clearPendingAuthFailures('owner-b');
  });

  it('claims a recorded failure exactly once', () => {
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'));
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(0);
  });

  it('isolates owners from each other', () => {
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'));
    expect(claimPendingAuthFailures('owner-b')).toHaveLength(0);
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
  });

  it('dedupes repeated failures for the same dependency', () => {
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'));
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'));
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(1);
  });

  it('keeps distinct dependencies separate, though only one reaches the transcript today', () => {
    // The registry legitimately holds one entry per dependency, but the wire
    // shape carries a SINGULAR `authFailure` per block, so `pairPendingAuthFailures`
    // deliberately emits only the first (see its TODO(CAN-1814 PR2)). This test
    // documents the registry's capability, not a transcript guarantee.
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'));
    recordPendingMcpAuthFailure('owner-a', failure('srv-2'));
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(2);
  });

  it('drops an entry older than the claim window', () => {
    // The proxy serves initialize/tools/list/SSE reconnects too, so a 401 can
    // be recorded with no errored tool result to claim it. Without this bound a
    // session-init 401 could surface as turn 20's failure.
    const recordedAt = 1_000_000;
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'), recordedAt);
    expect(
      claimPendingAuthFailures('owner-a', {
        now: recordedAt + PENDING_AUTH_FAILURE_TTL_MS + 1,
      }),
    ).toEqual([]);
  });

  it('still claims an entry at the edge of the claim window', () => {
    const recordedAt = 1_000_000;
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'), recordedAt);
    expect(
      claimPendingAuthFailures('owner-a', {
        now: recordedAt + PENDING_AUTH_FAILURE_TTL_MS,
      }),
    ).toHaveLength(1);
  });

  it('removes a stale entry rather than leaving it claimable later', () => {
    const recordedAt = 1_000_000;
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'), recordedAt);
    claimPendingAuthFailures('owner-a', {
      now: recordedAt + PENDING_AUTH_FAILURE_TTL_MS + 1,
    });
    expect(claimPendingAuthFailures('owner-a', { now: recordedAt })).toEqual(
      [],
    );
  });

  it('clears without claiming', () => {
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'));
    clearPendingAuthFailures('owner-a');
    expect(claimPendingAuthFailures('owner-a')).toHaveLength(0);
  });

  it('tags an MCP entry with an mcp anchor', () => {
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'));
    expect(claimPendingAuthFailures('owner-a')).toEqual([
      { failure: failure('srv-1'), anchor: { kind: 'mcp' } },
    ]);
  });

  it('tags an injected-tool entry with the tool key that produced it', () => {
    recordPendingInjectedToolAuthFailure(
      'owner-a',
      'watch_github_items',
      githubFailure,
    );
    expect(claimPendingAuthFailures('owner-a')).toEqual([
      {
        failure: githubFailure,
        anchor: { kind: 'injected-tool', toolKey: 'watch_github_items' },
      },
    ]);
  });

  // The anchor filter is what keeps an integration failure from being claimed
  // by (and misattached to) an unrelated errored MCP tool result, and vice
  // versa. An entry the caller cannot anchor SURVIVES the claim, exactly as an
  // unclaimable entry does today.
  it('leaves an entry the caller cannot anchor in the registry', () => {
    recordPendingMcpAuthFailure('owner-a', failure('srv-1'));
    recordPendingInjectedToolAuthFailure(
      'owner-a',
      'watch_github_items',
      githubFailure,
    );

    const claimed = claimPendingAuthFailures('owner-a', {
      canClaim: (anchor) => anchor.kind === 'mcp',
    });
    expect(claimed).toEqual([
      { failure: failure('srv-1'), anchor: { kind: 'mcp' } },
    ]);

    expect(claimPendingAuthFailures('owner-a')).toEqual([
      {
        failure: githubFailure,
        anchor: { kind: 'injected-tool', toolKey: 'watch_github_items' },
      },
    ]);
  });

  it('drops a stale entry even when the caller could not anchor it', () => {
    const recordedAt = 1_000_000;
    recordPendingInjectedToolAuthFailure(
      'owner-a',
      'watch_github_items',
      githubFailure,
      recordedAt,
    );
    expect(
      claimPendingAuthFailures('owner-a', {
        now: recordedAt + PENDING_AUTH_FAILURE_TTL_MS + 1,
        canClaim: () => false,
      }),
    ).toEqual([]);
    expect(claimPendingAuthFailures('owner-a', { now: recordedAt })).toEqual(
      [],
    );
  });
});
