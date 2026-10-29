import {
  mcpCapabilityIdentityKey,
  mcpCapabilityIdentitySchema,
  mcpSessionStatusSchema,
  readMcpActivationRecord,
  type McpActivationRecord,
} from '../availability';

const identity = {
  kind: 'standalone',
  serverId: 'server',
  configId: 'config',
} as const;
const status = {
  identity,
  sessionId: 'session',
  generation: 1,
  selected: true,
  enabled: true,
  permitted: true,
  authRequirement: 'unknown',
  availability: 'connecting',
};
const record: McpActivationRecord = {
  version: 1,
  ownerId: 'owner',
  activationId: 'activation',
  attemptId: 'attempt',
  originatingMessageId: 'message',
  providerSessionId: 'session',
  provider: 'claude',
  trigger: 'load',
  requiredTargets: [identity],
  desiredGeneration: 1,
  phase: 'preparing',
  retryEligible: false,
  cancelled: false,
  admission: 'not_sent',
};

describe('MCP availability contracts', () => {
  it('uses collision-safe keys for all identity variants', () => {
    expect(
      mcpCapabilityIdentityKey({
        ...identity,
        serverId: 'a\0b',
        configId: 'c',
      }),
    ).not.toBe(
      mcpCapabilityIdentityKey({
        ...identity,
        serverId: 'a',
        configId: 'b\0c',
      }),
    );
    expect(mcpCapabilityIdentityKey(identity)).not.toBe(
      mcpCapabilityIdentityKey({
        kind: 'account',
        connectionId: 'server',
        configId: 'config',
      }),
    );
    expect(
      mcpCapabilityIdentitySchema.safeParse({
        ...identity,
        credential: 'secret',
      }).success,
    ).toBe(false);
  });

  it('requires affirmative complete evidence and tools for ready', () => {
    expect(
      mcpSessionStatusSchema.safeParse({ ...status, availability: 'ready' })
        .success,
    ).toBe(false);
    expect(
      mcpSessionStatusSchema.safeParse({
        ...status,
        availability: 'ready',
        toolCount: 1,
        evidence: { initialized: true, toolsDiscovered: true },
      }).success,
    ).toBe(true);
    expect(
      mcpSessionStatusSchema.safeParse({
        ...status,
        availability: 'ready',
        toolCount: 0,
        evidence: { initialized: true, toolsDiscovered: true },
      }).success,
    ).toBe(false);
  });

  it.each([{ selected: false }, { enabled: false }, { permitted: false }])(
    'rejects ready with inconsistent selection facts %p',
    (facts) => {
      expect(
        mcpSessionStatusSchema.safeParse({
          ...status,
          ...facts,
          availability: 'ready',
          toolCount: 1,
          evidence: { initialized: true, toolsDiscovered: true },
        }).success,
      ).toBe(false);
    },
  );

  it('preserves provider-managed auth independently of readiness', () => {
    const parsed = mcpSessionStatusSchema.parse({
      ...status,
      availability: 'auth_required',
      authRequirement: 'provider_managed',
    });
    expect(parsed.authRequirement).toBe('provider_managed');
    expect(
      mcpSessionStatusSchema.safeParse({ ...parsed, authRequirement: 'none' })
        .success,
    ).toBe(false);
  });

  it('tolerates old and malformed recovery metadata without permitting replay', () => {
    expect(readMcpActivationRecord(undefined)).toBeUndefined();
    expect(readMcpActivationRecord({ ...record, version: 2 })).toBeUndefined();
    expect(
      readMcpActivationRecord({ ...record, phase: 'completed' }),
    ).toBeUndefined();
    expect(
      readMcpActivationRecord({
        ...record,
        requiredTargets: [identity, identity],
      }),
    ).toBeUndefined();
    expect(
      readMcpActivationRecord({ ...record, credentials: 'secret' }),
    ).toBeUndefined();
    expect(readMcpActivationRecord(record)).toEqual(record);
  });

  it('forbids retrying uncertain or accepted admission', () => {
    expect(
      readMcpActivationRecord({
        ...record,
        phase: 'failed',
        failureCode: 'resume_failed',
        retryEligible: true,
      }),
    ).toBeDefined();
    expect(
      readMcpActivationRecord({
        ...record,
        phase: 'failed',
        failureCode: 'admission_uncertain',
        admission: 'uncertain',
        retryEligible: true,
      }),
    ).toBeUndefined();
  });
});
