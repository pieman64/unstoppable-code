import {
  assertPipelineContext,
  pipelineContextAllowed,
} from '../pipelines/resource-lanes';
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import { getResourceContextPolicyService } from '../services/resource-context-policy-service';
const mockRead = jest.fn();
const mockDiagnostic = jest.fn();
const mockWorkspaceConfigRead = jest.fn();
const mockResolveWorkspaceTarget = jest.fn();
const org: WorkspaceContext = {
  kind: 'organization',
  organizationId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
};
let mockContext: WorkspaceContext = { kind: 'personal' };
const mockState = {
  initialize: jest.fn(async (): Promise<void> => {}),
  whenIdle: jest.fn(async (): Promise<void> => {}),
  getState: (): { context: WorkspaceContext } => ({ context: mockContext }),
  accountEpoch: (): number => 1,
};
let mockRolloutEnabled = true;
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: (): object => ({
    isEnabled: (): boolean => mockRolloutEnabled,
  }),
}));
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): typeof mockState => mockState,
}));
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): unknown => mockRead(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfigDetailed: (...args: unknown[]): unknown =>
    mockWorkspaceConfigRead(...args),
}));
jest.mock('../services/workspace-target', () => ({
  resolveWorkspaceTarget: (...args: unknown[]): unknown =>
    mockResolveWorkspaceTarget(...args),
  WorkspaceTargetResolutionError: class extends Error {},
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordSessionDiagnostic: typeof mockDiagnostic;
  } => ({ recordSessionDiagnostic: mockDiagnostic }),
}));
beforeEach((): void => {
  mockRolloutEnabled = true;
  mockContext = { kind: 'personal' };
  mockDiagnostic.mockReset();
  mockWorkspaceConfigRead.mockReset();
  mockResolveWorkspaceTarget.mockReset();
  mockRead.mockResolvedValue({
    status: 'ok',
    entry: {
      capabilities: ['resource-context-v1'],
      organizations: [{ id: org.organizationId }],
    },
  });
});
it('uses main context, rejects forged foreground context, and logs only reason', async (): Promise<void> => {
  const result = await getResourceContextPolicyService().decide({
    resource: {
      owner: { type: 'organization', id: org.organizationId, name: 'SECRET' },
    },
    invocation: { mode: 'foreground', context: org },
  });
  expect(result).toEqual({ allow: false, reason: 'context-mismatch' });
  expect(mockDiagnostic).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(mockDiagnostic.mock.calls)).not.toContain('SECRET');
  expect(mockDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'resource_context_denied',
      reason: 'context-mismatch',
    }),
  );
});
it('names an unclassifiable plugin in the denial diagnostic', async (): Promise<void> => {
  const resourceName = 'Mystery plugin'.repeat(20);
  const boundedResourceName = resourceName.slice(0, 200);
  const result = await getResourceContextPolicyService().decide({
    resource: {
      owner: undefined,
      subject: { kind: 'plugin', name: resourceName },
    },
    invocation: { mode: 'foreground', context: mockContext },
  });
  expect(result).toEqual({
    allow: false,
    reason: 'unknown-provenance',
    subject: { kind: 'plugin', name: boundedResourceName },
  });
  expect(mockDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'resource_context_denied',
      reason: 'unknown-provenance',
      resourceKind: 'plugin',
      resourceName: boundedResourceName,
    }),
  );
});
it.each([true, false])(
  'honors advertised strict capability=%s',
  async (strict): Promise<void> => {
    mockRead.mockResolvedValue({
      status: 'ok',
      entry: {
        capabilities: strict ? ['resource-context-v1'] : [],
        organizations: [],
      },
    });
    expect(
      await getResourceContextPolicyService().decide({
        resource: { owner: {} },
        invocation: { mode: 'foreground', context: mockContext },
      }),
    ).toEqual(
      strict ? { allow: false, reason: 'unknown-provenance' } : { allow: true },
    );
  },
);
it('denies removed organization membership', async (): Promise<void> => {
  mockContext = org;
  mockRead.mockResolvedValue({
    status: 'ok',
    entry: { capabilities: ['resource-context-v1'], organizations: [] },
  });
  expect(
    await getResourceContextPolicyService().decide({
      resource: {
        owner: { type: 'organization', id: org.organizationId, name: null },
      },
      invocation: { mode: 'foreground', context: org },
    }),
  ).toEqual({ allow: false, reason: 'access-removed' });
});
it('allows portable resources without emitting diagnostics', async (): Promise<void> => {
  expect(
    await getResourceContextPolicyService().decide({
      resource: { owner: { type: 'system' } },
      invocation: { mode: 'foreground', context: org },
    }),
  ).toEqual({ allow: true });
  expect(mockDiagnostic).not.toHaveBeenCalled();
});
it('rejects opaque IDs without a verified serialized background binding', async (): Promise<void> => {
  expect(
    await getResourceContextPolicyService().decide({
      resource: { owner: { type: 'system' } },
      invocation: {
        mode: 'background',
        context: org,
        boundBindingId: 'unverified',
      },
    }),
  ).toEqual({ allow: false, reason: 'unsupported-target' });
});

it.each([{ status: 'unavailable' }, { status: 'ok', entry: null }])(
  'does not enable legacy compatibility on missing account data %j',
  async (account): Promise<void> => {
    mockRead.mockResolvedValue(account);
    expect(
      await getResourceContextPolicyService().decide({
        resource: { owner: {} },
        invocation: { mode: 'foreground', context: mockContext },
      }),
    ).toEqual({ allow: false, reason: 'unknown-provenance' });
  },
);
it('allows the exact organization and checks the target using main context', async (): Promise<void> => {
  mockContext = org;
  const input = {
    resource: {
      owner: { type: 'organization', id: org.organizationId, name: null },
    },
    invocation: { mode: 'foreground' as const, context: org },
  };
  expect(await getResourceContextPolicyService().decide(input)).toEqual({
    allow: true,
  });
  expect(
    await getResourceContextPolicyService().decide({
      ...input,
      target: { workspaceOwner: { kind: 'personal' } },
    }),
  ).toEqual({ allow: false, reason: 'unsupported-target' });
});

it('allows a Personal target explicitly linked to the current organization', async (): Promise<void> => {
  mockContext = org;
  expect(
    await getResourceContextPolicyService().decide({
      resource: { owner: { type: 'system' } },
      invocation: { mode: 'foreground', context: org },
      target: {
        workspaceOwner: { kind: 'personal' },
        linkedOrganizationIds: [org.organizationId],
      },
    }),
  ).toEqual({ allow: true });
});

it('uses the persisted background context after navigation changes', async (): Promise<void> => {
  expect(
    await getResourceContextPolicyService().decide({
      resource: {
        owner: { type: 'organization', id: org.organizationId, name: null },
      },
      invocation: {
        mode: 'background',
        context: org,
        executionContext: `org:${org.organizationId}`,
      },
    }),
  ).toEqual({ allow: true });
});

it('rejects malformed workspace ownership before resolving a persisted-context target', async (): Promise<void> => {
  mockWorkspaceConfigRead.mockResolvedValue({
    authority: 'ok',
    ownerMalformed: true,
    config: {
      version: 1,
      type: 'single-repo',
      repos: [],
    },
  });
  mockResolveWorkspaceTarget.mockResolvedValue({
    workspaceOwner: { kind: 'personal' },
    linkedOrganizationIds: [org.organizationId],
  });

  await expect(
    assertPipelineContext(
      { owner: { type: 'system' } },
      'project-a',
      `org:${org.organizationId}`,
    ),
  ).rejects.toThrow('Workflow unavailable (unknown-provenance)');
  expect(mockWorkspaceConfigRead).toHaveBeenCalledWith('project-a');
  expect(mockResolveWorkspaceTarget).not.toHaveBeenCalled();
});
it('allows an unbound legacy personal background resource', async (): Promise<void> => {
  expect(
    await getResourceContextPolicyService().decide({
      resource: { owner: { type: 'system' } },
      invocation: { mode: 'background', context: org },
    }),
  ).toEqual({ allow: true });
});
it('rejects an unbound organization background graph', async (): Promise<void> => {
  expect(
    await getResourceContextPolicyService().decide({
      resource: {
        owner: { type: 'organization', id: org.organizationId, name: null },
      },
      invocation: { mode: 'background', context: org },
    }),
  ).toEqual({ allow: false, reason: 'context-mismatch' });
});
it('revalidates membership even for a portable resource bound to an organization', async (): Promise<void> => {
  mockRead.mockResolvedValue({
    status: 'ok',
    entry: { capabilities: [], organizations: [] },
  });
  expect(
    await getResourceContextPolicyService().decide({
      resource: { owner: { type: 'system' } },
      invocation: {
        mode: 'background',
        context: org,
        executionContext: `org:${org.organizationId}`,
      },
    }),
  ).toEqual({ allow: false, reason: 'access-removed' });
});

it.each([true, false])(
  'classifies unbound unknown background dependencies under strict=%s',
  async (strict): Promise<void> => {
    mockRead.mockResolvedValue({
      status: 'ok',
      entry: {
        capabilities: strict ? ['resource-context-v1'] : [],
        organizations: [],
      },
    });
    expect(
      await getResourceContextPolicyService().decide({
        resource: { owner: undefined },
        invocation: { mode: 'background', context: org },
      }),
    ).toEqual(
      strict ? { allow: false, reason: 'unknown-provenance' } : { allow: true },
    );
  },
);
it('rejects malformed persisted context without falling back to navigation', async (): Promise<void> => {
  expect(
    await getResourceContextPolicyService().decide({
      resource: { owner: { type: 'system' } },
      invocation: {
        mode: 'background',
        context: org,
        executionContext: 'org:invalid',
      },
    }),
  ).toEqual({ allow: false, reason: 'unsupported-target' });
});
it.each(['foreground', 'background'] as const)(
  'allows %s decisions without reading the account or recording a denial while the flag is off',
  async (mode): Promise<void> => {
    mockRolloutEnabled = false;
    mockRead.mockClear();
    mockContext = org;
    const result = await getResourceContextPolicyService().decide({
      resource: {
        owner: { type: 'organization', id: org.organizationId, name: 'X' },
      },
      invocation: { mode, context: { kind: 'personal' } },
    });
    expect(result).toEqual({ allow: true });
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockDiagnostic).not.toHaveBeenCalled();
  },
);

it('denies ambiguous pipeline ownership with the flag on and resource-context-v1 absent', async () => {
  mockRead.mockResolvedValue({
    status: 'ok',
    entry: { capabilities: [], organizations: [] },
  });
  expect(
    await getResourceContextPolicyService().decide({
      resource: { owner: {} },
      invocation: { mode: 'foreground', context: mockContext },
    }),
  ).toEqual({ allow: true });
  await expect(assertPipelineContext({ owner: {} })).rejects.toThrow(
    'Workflow unavailable (unknown-provenance)',
  );
  await expect(pipelineContextAllowed({ owner: {} })).resolves.toBe(false);
});

it('authorizes Personal ownership from the current account mapping and denies stale promoted mapping', async () => {
  const entry = {
    capabilities: ['resource-context-v1'],
    organizations: [],
    personalOrganizationId: org.organizationId,
  };
  mockRead.mockResolvedValue({ status: 'ok', entry });
  const input = {
    resource: {
      owner: { type: 'organization', id: org.organizationId, name: null },
    },
    invocation: { mode: 'foreground' as const, context: mockContext },
  };
  await expect(
    getResourceContextPolicyService().decide(input),
  ).resolves.toEqual({ allow: true });
  mockContext = org;
  await expect(
    getResourceContextPolicyService().decide(input),
  ).resolves.toEqual({ allow: false, reason: 'context-mismatch' });
  mockContext = { kind: 'personal' };
  mockRead.mockResolvedValue({
    status: 'ok',
    entry: {
      ...entry,
      personalOrganizationId: undefined,
      organizations: [{ id: org.organizationId }],
    },
  });
  await expect(
    getResourceContextPolicyService().decide(input),
  ).resolves.toEqual({ allow: false, reason: 'context-mismatch' });
});
