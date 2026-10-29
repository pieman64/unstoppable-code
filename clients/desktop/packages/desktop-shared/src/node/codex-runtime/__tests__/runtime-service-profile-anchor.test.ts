import type { CodexCapabilityStore } from '../capability-store';
import type { CodexMcpSecretBroker } from '../mcp-secret-broker';
import { resolveCodexSpawnProfile } from '../profile';
import {
  createCodexRuntimeService,
  type CodexInteractiveOwner,
} from '../runtime-service';

describe('Codex runtime profile anchors', () => {
  it('permits handoff only for a recently released idle owner and clears it when resumed', async () => {
    let active = false;
    const owner: CodexInteractiveOwner = {
      hasActiveTurn: () => active,
      getActiveTurnInterruptTarget: () => null,
      cancelPendingTurnStart: () => {},
      rejectActiveTurn: () => {},
      markProcessSuspended: () => {},
      markProcessFailed: () => {},
      handleConnectionNotification: () => {},
      handleRequestUserInput: async () => {},
      handleDynamicToolCall: async () => {},
      handleApprovalRequest: async () => {},
      handleMcpElicitation: async () => {},
    };
    const service = createCodexRuntimeService();
    const original = service.attachInteractiveClient({ owner });
    const replacement = service.attachInteractiveClient({
      owner: { ...owner },
      profile: { environment: { PROFILE_MARKER: 'new' } },
    });
    try {
      expect(replacement.requiresThreadMaterialization('unknown')).toBe(false);
      active = true;
      original.rememberIdleThread('active');
      expect(replacement.requiresThreadMaterialization('active')).toBe(false);
      active = false;
      original.rememberIdleThread('idle');
      expect(original.requiresThreadMaterialization('idle')).toBe(false);
      expect(replacement.requiresThreadMaterialization('idle')).toBe(true);
      original.markThreadReady('idle');
      expect(replacement.requiresThreadMaterialization('idle')).toBe(false);
      original.rememberIdleThread('expired');
      const clock = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + 31 * 60_000);
      try {
        expect(replacement.requiresThreadMaterialization('expired')).toBe(
          false,
        );
      } finally {
        clock.mockRestore();
      }
    } finally {
      original.release();
      replacement.release();
      await service.shutdown();
    }
  });

  it('does not evict an anchor with an active account subscription', async () => {
    const service = createCodexRuntimeService();
    const firstProfile = { environment: { PROFILE_MARKER: 'first' } };
    const firstProfileId = resolveCodexSpawnProfile(firstProfile).id;
    const unsubscribe = service
      .admin()
      .onAccountUpdated(() => {}, firstProfile);

    for (const marker of ['second', 'third', 'fourth', 'fifth']) {
      service.admin().onRateLimitsUpdated(() => {}, {
        environment: { PROFILE_MARKER: marker },
      });
    }

    expect(
      service
        .admin()
        .getResourceSnapshots()
        .map((snapshot) => snapshot.poolKey),
    ).toContain(`profile:${firstProfileId}`);

    unsubscribe();
    await service.shutdown();
  });

  it('does not evict an anchor while thread creation publishes capabilities', async () => {
    let rejectPublication: ((error: Error) => void) | undefined;
    const publication = new Promise<never>((_resolve, reject) => {
      rejectPublication = reject;
    });
    const capabilityStore = {
      publishSelectedRoots: jest.fn(() => publication),
    } as unknown as CodexCapabilityStore;
    const service = createCodexRuntimeService({ capabilityStore });
    const firstProfile = { environment: { PROFILE_MARKER: 'first' } };
    const firstProfileId = resolveCodexSpawnProfile(firstProfile).id;

    const startPromise = service.startThread({
      profile: firstProfile,
      params: {
        cwd: '/tmp/repo',
        selectedCapabilityRoots: [],
        experimentalRawEvents: false,
      },
      capabilitySnapshotId: 'snapshot',
    });
    await Promise.resolve();

    for (const marker of ['second', 'third', 'fourth', 'fifth']) {
      service.admin().onAccountUpdated(() => {}, {
        environment: { PROFILE_MARKER: marker },
      });
    }

    expect(
      service
        .admin()
        .getResourceSnapshots()
        .map((snapshot) => snapshot.poolKey),
    ).toContain(`profile:${firstProfileId}`);

    rejectPublication?.(new Error('stop pending publication'));
    await expect(startPromise).rejects.toThrow('stop pending publication');
    await service.shutdown();
  });

  it('always drains the pool when MCP broker shutdown fails', async () => {
    const brokerError = new Error('broker shutdown failed');
    const mcpSecretBroker = {
      shutdown: jest.fn().mockRejectedValue(brokerError),
    } as unknown as CodexMcpSecretBroker;
    const service = createCodexRuntimeService({ mcpSecretBroker });
    service.admin().onAccountUpdated(() => {});

    expect(service.admin().getResourceSnapshots()).toHaveLength(1);
    await expect(service.shutdown()).rejects.toBe(brokerError);
    expect(service.admin().getResourceSnapshots()).toHaveLength(0);
  });

  it('preserves owner revocation before the MCP broker is created', async () => {
    const service = createCodexRuntimeService();
    await service.revokeStdioMcpRoutes('disposed-before-broker-start');

    await expect(
      service.registerStdioMcpRoute({
        ownerId: 'disposed-before-broker-start',
        routeKey: 'server',
        command: '/usr/bin/server',
      }),
    ).rejects.toThrow('was revoked');

    await service.shutdown();
  });
});
