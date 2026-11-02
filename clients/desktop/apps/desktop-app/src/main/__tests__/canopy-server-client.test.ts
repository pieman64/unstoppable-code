import {
  listSharedPlugins,
  getSharedPlugin,
  createSharedPlugin,
  deleteSharedPlugin,
  publishPluginPublicShare,
  revokePluginPublicShare,
} from '../plugins/canopy-server-client';
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn().mockResolvedValue({ version: 1, items: [] }),
}));
import * as pipelineLanes from '../pipelines/resource-lanes';
import { createHash } from 'node:crypto';
import type {
  ResourceContextDecision,
  InstallReceipt,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import type {
  SharedAgentDocument,
  AgentModelDefinition,
} from '@canopy/desktop-shared/types/agent-models';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import { resolveShareablePluginRefs } from '../plugins/shareable-plugin-resolution';
jest.mock('../plugins/shareable-plugin-resolution', () => ({
  loadShareablePluginCatalog: jest.fn(() =>
    Promise.resolve({ skills: [], marketplaces: [] }),
  ),
  resolveShareablePluginRefs: jest.fn(() => []),
}));
const mockGetAgentModel = jest.fn<
  Promise<AgentModelDefinition | null>,
  [string]
>();
jest.mock('../agents/agent-model-store', () => ({
  getAgentModel: mockGetAgentModel,
}));
jest.mock('../feature-flags', () => ({
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: jest.fn(() => mockResourceLanesEnabled),
  })),
}));
const mockResourceContext = { kind: 'organization', organizationId: 'org-a' };
let mockResourceLanesEnabled = false;
let mockResourceRevision = 1;
let mockAccountEpoch = 1;
jest.mock('../lib/workspace-context-service', () => ({
  getWorkspaceContextService: jest.fn(() => ({
    initialize: jest.fn(() => Promise.resolve()),
    whenIdle: jest.fn(() => Promise.resolve()),
    accountEpoch: jest.fn((): number => mockAccountEpoch),
    getState: jest.fn(() => ({
      context: mockResourceContext,
      revision: mockResourceRevision,
    })),
  })),
}));
jest.mock('../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: jest.fn(() => ({
    decide: jest.fn(
      (input: {
        resource: {
          owner?: {
            type: string;
            id: string;
            organizationId?: string;
            organization?: { id: string };
          };
          provenance?: InstallReceipt;
        };
        target?: {
          workspaceOwner:
            | { kind: 'personal' }
            | { kind: 'organization'; organizationId: string };
        };
      }): Promise<ResourceContextDecision> =>
        Promise.resolve(
          ((): ResourceContextDecision => {
            const sourceOrganizationId =
              input.resource.owner?.type === 'team'
                ? (input.resource.owner.organization?.id ??
                  input.resource.owner.organizationId)
                : input.resource.owner?.type === 'organization'
                  ? input.resource.owner.id
                  : input.resource.owner?.type === 'system' &&
                      input.resource.provenance?.ownerContext.kind ===
                        'organization'
                    ? input.resource.provenance.ownerContext.organizationId
                    : undefined;
            if (
              sourceOrganizationId &&
              input.target?.workspaceOwner &&
              (input.target.workspaceOwner.kind !== 'organization' ||
                input.target.workspaceOwner.organizationId !==
                  sourceOrganizationId)
            ) {
              return { allow: false, reason: 'context-mismatch' };
            }
            return input.resource.owner?.type === 'user' ||
              (input.resource.owner?.type === 'team' &&
                (input.resource.owner.organization?.id ??
                  input.resource.owner.organizationId) ===
                  mockResourceContext.organizationId) ||
              (input.resource.owner?.type === 'system' &&
                input.resource.provenance?.ownerContext.kind ===
                  'organization' &&
                input.resource.provenance.ownerContext.organizationId ===
                  mockResourceContext.organizationId) ||
              (mockResourceContext.kind === 'organization' &&
                input.resource.owner?.id === mockResourceContext.organizationId)
              ? { allow: true }
              : { allow: false, reason: 'context-mismatch' };
          })(),
        ),
    ),
  })),
}));
let mockAccountId = 'user';
jest.mock('../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: jest.fn(() =>
    Promise.resolve({
      status: 'ok',
      entry: { apiKey: 'key', account: { id: mockAccountId } },
    }),
  ),
  getCanopyCloudCredentials: jest.fn(),
  mergeCanopyCloudAccountCapabilities: jest.fn(),
}));
const mockReceiptRows = jest.fn<Promise<InstallReceipt[]>, []>();
const mockSourceRows = jest.fn(() => ({
  success: true,
  data: [{ id: 'local-a', name: 'Release' }],
}));
const mockSourceText = jest.fn(() => ({
  success: true,
  data: 'stored source',
}));
const mockSourceBinding = jest.fn();
jest.mock('../lib/resource-install-receipts', () => ({
  createResourceInstallReceiptsStore: jest.fn(() => ({
    listForAccount: mockReceiptRows,
    listOrganizationContentOwners: async (
      family: string,
      hash: string,
    ): Promise<string[]> =>
      Array.from(
        new Set(
          (await mockReceiptRows()).flatMap((receipt) =>
            receipt.family === family &&
            receipt.hash === hash &&
            receipt.ownerContext.kind === 'organization'
              ? [receipt.ownerContext.organizationId]
              : [],
          ),
        ),
      ),
    findLocal: mockSourceBinding,
  })),
}));
jest.mock('../pipelines/pipeline-service', () => ({
  getPipelineText: mockSourceText,
  listPipelines: mockSourceRows,
}));
const mockStoredSkillContext = jest.fn<Promise<void>, [string]>();
const mockSkillShareOrigin = jest.fn<Promise<void>, [string, unknown]>();
jest.mock('../skills/skill-install-context', () => ({
  assertStoredSkillContext: mockStoredSkillContext,
  assertSkillShareOrigin: mockSkillShareOrigin,
}));
const mockReadRawSkill = jest.fn<Promise<string>, [string]>();
jest.mock('../skills/skill-service', () => ({
  readRawSkill: mockReadRawSkill,
}));
jest.mock('../canopy-cloud/config', () => ({
  CanopyCloudConfigError: class CanopyCloudConfigError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = 'CanopyCloudConfigError';
    }
  },
  getCanopyCloudBaseUrl: jest.fn(() => 'https://canopy.example.test'),
}));

import {
  getCanopyCloudCredentials,
  mergeCanopyCloudAccountCapabilities,
} from '../lib/canopy-cloud-account-store';
import {
  assertCanopyCloudCapability,
  requestCanopyCloudBinary,
  requestCanopyCloudJson,
  requestCanopyCloudMultipartJson,
  requestCanopyCloudNoContent,
  revokeCurrentOAuthDesktopKey,
} from '../canopy-cloud/client';
import type { CanopyCloudClientError } from '../canopy-cloud/client';
import { CanopyCloudConfigError } from '../canopy-cloud/config';
import {
  listSharedSkills,
  getSharedSkill,
  updateSharedSkill,
  deleteSharedSkill,
  createSharedSkill,
  publishSkillPublicShare,
  revokeSkillPublicShare,
} from '../skills/canopy-server-client';
import {
  createSharedCollection,
  updateSharedCollection,
  listSharedCollections,
  getSharedCollection,
  deleteSharedCollection,
} from '../collections/canopy-server-client';
import {
  createSharedAutomation,
  listSharedAutomations,
  getSharedAutomation,
  updateSharedAutomation,
  deleteSharedAutomation,
  publishAutomationPublicShare,
  revokeAutomationPublicShare,
} from '../automations/canopy-server-client';
import {
  getSharedPipeline,
  getSharedPipelineForExecutionContext,
  updateSharedPipeline,
  deleteSharedPipeline,
  getPipelinePackage,
  getPipelinePackageBlob,
  getAutomationPackage,
  getAutomationPackageBlob,
  createSharedPipeline,
  listSharedPipelines,
  preparePipelinePackageUpload,
  publishPipelinePublicShare,
  revokePipelinePublicShare,
} from '../pipelines/canopy-server-client';
import { createSharedPlan } from '../plans/canopy-server-client';
import { unshareSharedRunByClientLocalId } from '../runs/canopy-server-client';
import {
  createSharedAgent,
  updateSharedAgent,
  listSharedAgents,
  getSharedAgent,
  deleteSharedAgent,
  publishAgentPublicShare,
  revokeAgentPublicShare,
} from '../agents/canopy-server-client';

function requireBody(body: RequestInit['body']): string {
  if (typeof body !== 'string') throw new Error('Expected JSON body');
  return body;
}
import { PIPELINE_PACKAGE_CLIENT_VERSION } from '@canopy/protocol/pipelines';

const CLIENT_VERSION = String(PIPELINE_PACKAGE_CLIENT_VERSION);

describe('Canopy Cloud desktop REST client helpers', () => {
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();
  const mockedGetCanopyCloudCredentials = jest.mocked(
    getCanopyCloudCredentials,
  );
  const mockedMergeCanopyCloudAccountCapabilities = jest.mocked(
    mergeCanopyCloudAccountCapabilities,
  );

  beforeEach(() => {
    mockAccountId = 'user';
    jest.clearAllMocks();
    mockStoredSkillContext.mockReset().mockResolvedValue();
    mockSkillShareOrigin.mockReset().mockResolvedValue();
    mockReadRawSkill.mockReset().mockResolvedValue('stored skill');
    mockReceiptRows.mockResolvedValue([]);
    mockGetAgentModel.mockReset().mockResolvedValue(null);
    mockSourceBinding.mockResolvedValue(undefined);
    mockResourceLanesEnabled = false;
    mockResourceRevision += 1;
    mockResourceContext.organizationId = 'org-a';
    mockResourceContext.kind = 'organization';
    fetchMock.mockReset();
    mockedGetCanopyCloudCredentials.mockResolvedValue({
      baseUrl: 'https://canopy.example.test',
      apiKey: 'secret-key',
      capabilities: ['skills-crud-v1', 'collections-crud-v1'],
      memorySearchOrganizationExternalIds: [],
    });
    mockedMergeCanopyCloudAccountCapabilities.mockResolvedValue(null);
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: fetchMock,
    });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it.each([
    [
      'skill create',
      (): Promise<unknown> =>
        createSharedSkill({
          rawSkill: '# Skill',
          shareScope: 'organization',
        }),
    ],
    [
      'skill update',
      (): Promise<unknown> =>
        updateSharedSkill({
          skillId: 'skill-1',
          rawSkill: '# Skill',
          shareScope: 'organization',
        }),
    ],
    [
      'collection create',
      (): Promise<unknown> =>
        createSharedCollection({
          rawCollection: '{}',
          shareScope: 'organization',
        }),
    ],
    [
      'collection update',
      (): Promise<unknown> =>
        updateSharedCollection({
          collectionId: 'collection-1',
          rawCollection: '{}',
          shareScope: 'organization',
        }),
    ],
    [
      'pipeline create',
      (): Promise<unknown> =>
        createSharedPipeline({
          rawPipeline: 'name: Release',
          shareScope: 'organization',
        }),
    ],
    [
      'automation create',
      (): Promise<unknown> =>
        createSharedAutomation({
          shareScope: 'organization',
        } as Parameters<typeof createSharedAutomation>[0]),
    ],
    [
      'automation update',
      (): Promise<unknown> =>
        updateSharedAutomation({
          automationId: 'automation-1',
          shareScope: 'organization',
        } as Parameters<typeof updateSharedAutomation>[0]),
    ],
  ])(
    'rejects a missing organization target before a %s request',
    async (_name, request) => {
      await expect(request()).rejects.toThrow(/organizationId/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['personal', 'org-a', 'org-b'])(
    'partitions shared plugin inventory for %s',
    async (context) => {
      mockResourceLanesEnabled = true;
      mockResourceContext.kind =
        context === 'personal' ? 'personal' : 'organization';
      mockResourceContext.organizationId = context;
      const rows = [
        { externalId: 'personal-plugin', owner: { type: 'user', id: 'user' } },
        {
          externalId: 'org-a-plugin',
          owner: { type: 'organization', id: 'org-a' },
        },
        {
          externalId: 'org-b-plugin',
          owner: { type: 'organization', id: 'org-b' },
        },
      ];
      fetchMock.mockImplementation(() =>
        Promise.resolve(Response.json({ data: rows })),
      );
      const result = await listSharedPlugins();
      expect(result.map((row) => row.externalId)).toEqual(
        context === 'personal'
          ? ['personal-plugin']
          : ['personal-plugin', `${context}-plugin`],
      );
      expect(
        fetchMock.mock.calls.map(([url]) =>
          new URL(url).searchParams.get('shareScope'),
        ),
      ).toEqual(
        context === 'personal' ? ['private'] : ['private', 'organization'],
      );
    },
  );

  it('forwards author and search filters and partitions plugin ETags by ownership', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({ data: [] }, { headers: { ETag: 'everything' } }),
      ),
    );
    await listSharedPlugins();
    await listSharedPlugins({ createdBy: 'me', query: 'browser' });
    const filtered = fetchMock.mock.calls.slice(2);
    expect(filtered).toHaveLength(2);
    for (const [url, init] of filtered) {
      expect(new URL(url).searchParams.get('createdBy')).toBe('me');
      expect(new URL(url).searchParams.get('q')).toBe('browser');
      expect(new Headers(init.headers).has('If-None-Match')).toBe(false);
    }
  });

  it('forwards the selected plugin share destination', async () => {
    fetchMock.mockResolvedValue(Response.json({ externalId: 'shared-plugin' }));
    await createSharedPlugin({
      serverId: 'canopy-cloud',
      ref: {
        type: 'plugin',
        marketplace: { type: 'github', repo: 'acme/plugins' },
        plugin_name: 'review',
      },
      name: 'Review',
      shareScope: 'team',
      teamId: 'team-id',
    });

    const [, init] = fetchMock.mock.calls.at(-1) ?? [];
    if (typeof init?.body !== 'string') {
      throw new Error('Expected a JSON request body');
    }
    expect(JSON.parse(init.body)).toEqual(
      expect.objectContaining({ shareScope: 'team', teamId: 'team-id' }),
    );
  });

  it('sends a re-packaged upload with an in-place pipeline update', async (): Promise<void> => {
    fetchMock.mockResolvedValue(Response.json({ id: 'remote-a' }));

    await updateSharedPipeline('remote-a', 'name: changed', {
      distributionMode: 'package',
      committedPackageUploadId: 'upload-1',
    });

    const [url, init] =
      fetchMock.mock.calls[fetchMock.mock.calls.length - 1] ?? [];
    expect(url).toContain('/pipelines/remote-a');
    expect(init?.method).toBe('PUT');
    expect(typeof init?.body).toBe('string');
    expect(JSON.parse(init?.body as string)).toEqual({
      rawPipeline: 'name: changed',
      distributionMode: 'package',
      committedPackageUploadId: 'upload-1',
    });
  });

  it.each([
    getSharedPlugin,
    deleteSharedPlugin,
    publishPluginPublicShare,
    revokePluginPublicShare,
  ])(
    'denies a shared plugin direct operation outside its owning organization',
    async (operation) => {
      mockResourceLanesEnabled = true;
      fetchMock.mockResolvedValue(
        Response.json({
          externalId: 'org-b-plugin',
          owner: { type: 'organization', id: 'org-b' },
        }),
      );
      await expect(operation('org-b-plugin')).rejects.toThrow(
        'context-mismatch',
      );
      expect(
        fetchMock.mock.calls.every(
          ([, init]) => !init.method || init.method === 'GET',
        ),
      ).toBe(true);
    },
  );

  it('keeps shared-plugin ETags in their lane and invalidates on context change', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation((url, init) => {
      const headers = new Headers(init.headers);
      if (headers.has('If-None-Match'))
        return Promise.resolve(new Response(null, { status: 304 }));
      const lane = new URL(url).searchParams.get('shareScope');
      return Promise.resolve(
        Response.json({ data: [] }, { headers: { ETag: lane ?? 'none' } }),
      );
    });
    await listSharedPlugins();
    await listSharedPlugins();
    expect(fetchMock.mock.calls[2]?.[1].headers).toMatchObject({
      'If-None-Match': 'private',
    });
    expect(fetchMock.mock.calls[3]?.[1].headers).toMatchObject({
      'If-None-Match': 'organization',
    });
    mockResourceRevision += 1;
    mockResourceContext.organizationId = 'org-b';
    await listSharedPlugins();
    expect(
      new Headers(fetchMock.mock.calls[4]?.[1].headers).has('If-None-Match'),
    ).toBe(false);
    expect(
      new Headers(fetchMock.mock.calls[5]?.[1].headers).has('If-None-Match'),
    ).toBe(false);
  });

  it('discards a shared-plugin response crossing a context switch', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation(() => {
      mockResourceRevision += 1;
      return Promise.resolve(Response.json({ data: [] }));
    });
    await expect(listSharedPlugins()).rejects.toThrow('context-mismatch');
  });

  it('keeps the disabled shared-plugin list request unscoped', async () => {
    fetchMock.mockResolvedValue(Response.json({ data: [] }));
    await expect(listSharedPlugins()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0]?.[0] ?? '').search).toBe('');
  });

  it('publishes and revokes Agent public shares through the authenticated routes', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          publicShare: {
            externalId: '22222222-2222-4222-8222-222222222222',
            sharePath: '/share/agents/22222222-2222-4222-8222-222222222222',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const agentId = '11111111-1111-4111-8111-111111111111';
    await expect(publishAgentPublicShare(agentId)).resolves.toMatchObject({
      externalId: '22222222-2222-4222-8222-222222222222',
    });
    await expect(revokeAgentPublicShare(agentId)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      `/api/v1/desktop-app/agents/${agentId}/public-share`,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends bearer auth, JSON headers, and parses JSON responses', async () => {
    await expect(
      requestCanopyCloudJson('/api/v1/desktop-app/skills', {
        method: 'POST',
        body: JSON.stringify({ rawSkill: '# Skill' }),
      }),
    ).resolves.toEqual({ ok: true });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe(
      'https://canopy.example.test/api/v1/desktop-app/skills',
    );
    expect(firstCall?.[1].method).toBe('POST');
    expect(firstCall?.[1].headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer secret-key',
      'Content-Type': 'application/json',
    });
  });

  it('uses an explicit credential context for a multipart request', async () => {
    const formData = new FormData();
    formData.append('metadata', '{}');

    await expect(
      requestCanopyCloudMultipartJson('/api/v1/desktop-app/session-exports', {
        formData,
        credentials: {
          baseUrl: 'https://initiating-account.example.test',
          apiKey: 'initiating-account-key',
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(mockedGetCanopyCloudCredentials).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://initiating-account.example.test/api/v1/desktop-app/session-exports',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer initiating-account-key',
          'x-canopy-model-library-protocol': '1',
        },
      }),
    );
  });

  it('uses an explicit credential context for JSON and binary requests', async () => {
    const credentials = {
      baseUrl: 'https://initiating-account.example.test',
      apiKey: 'initiating-account-key',
    };
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'export-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(Buffer.from([0x1f, 0x8b, 0x08]), { status: 200 }),
      );

    await expect(
      requestCanopyCloudJson('/api/v1/desktop-app/session-exports/export-1', {
        credentialContext: credentials,
      }),
    ).resolves.toEqual({ id: 'export-1' });
    await expect(
      requestCanopyCloudBinary(
        '/api/v1/desktop-app/session-exports/export-1/bundle',
        { credentialContext: credentials },
      ),
    ).resolves.toEqual(Buffer.from([0x1f, 0x8b, 0x08]));

    expect(mockedGetCanopyCloudCredentials).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://initiating-account.example.test/api/v1/desktop-app/session-exports/export-1',
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://initiating-account.example.test/api/v1/desktop-app/session-exports/export-1/bundle',
    );
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: 'Bearer initiating-account-key',
    });
    expect(fetchMock.mock.calls[1]?.[1].headers).toMatchObject({
      Authorization: 'Bearer initiating-account-key',
    });
  });

  it('maps HTTP error bodies into IPC-friendly client errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      requestCanopyCloudJson('/api/v1/desktop-app/skills'),
    ).rejects.toMatchObject({
      code: 'http-error',
      message: 'HTTP 403: Forbidden',
      status: 403,
    } satisfies Partial<CanopyCloudClientError>);
  });

  it('maps missing Cloud base URL credentials into cloud-not-configured', async () => {
    mockedGetCanopyCloudCredentials.mockRejectedValue(
      new CanopyCloudConfigError(
        'base-url-not-configured',
        'Canopy Cloud base URL is not configured.',
      ),
    );

    await expect(
      requestCanopyCloudJson('/api/v1/desktop-app/skills'),
    ).rejects.toMatchObject({
      code: 'cloud-not-configured',
      message: 'Canopy Cloud base URL is not configured.',
    } satisfies Partial<CanopyCloudClientError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps missing Cloud API key credentials into missing-api-key', async () => {
    mockedGetCanopyCloudCredentials.mockRejectedValue(
      new CanopyCloudConfigError(
        'api-key-required',
        'Canopy Cloud API key is required.',
      ),
    );

    await expect(
      requestCanopyCloudNoContent('/api/v1/desktop-app/skills/skill-one', {
        method: 'DELETE',
      }),
    ).rejects.toMatchObject({
      code: 'missing-api-key',
      message: 'Canopy Cloud API key is required.',
    } satisfies Partial<CanopyCloudClientError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors a custom request timeout for long-poll Cloud requests', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    let rejected: unknown;
    const request = requestCanopyCloudJson('/api/v1/desktop-app/portal/poll', {
      method: 'POST',
      timeoutMs: 30_000,
    }).catch((error: unknown) => {
      rejected = error;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(rejected).toBeUndefined();

    await jest.advanceTimersByTimeAsync(15_000);
    await request;
    expect(rejected).toMatchObject({
      code: 'network-error',
      message: 'Canopy Cloud request timed out.',
    } satisfies Partial<CanopyCloudClientError>);
    jest.useRealTimers();
  });

  it('keeps the request timeout active while reading a binary response body', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => {
      const body = new ReadableStream({
        start(controller): void {
          init.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            controller.error(error);
          });
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/gzip' },
        }),
      );
    });

    let rejected: unknown;
    const request = requestCanopyCloudBinary('/api/v1/session-exports/one', {
      timeoutMs: 30_000,
    }).catch((error: unknown) => {
      rejected = error;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // An internal helper timeout is a retryable failure for an idempotent GET,
    // so drain the bounded retry budget: each attempt times out after 30s and
    // the loop waits 400ms then 1500ms before giving up.
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(400);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(30_000);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(30_000);

    await request;
    expect(rejected).toMatchObject({
      code: 'network-error',
      message: 'Canopy Cloud request timed out.',
    } satisfies Partial<CanopyCloudClientError>);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('includes HTTP status in the Error message for IPC propagation', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Skill is referenced' }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(
      requestCanopyCloudJson('/api/v1/desktop-app/skills'),
    ).rejects.toThrow('HTTP 409: Skill is referenced');
  });

  it('revokes the current OAuth desktop key with the supplied bearer token', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      revokeCurrentOAuthDesktopKey('csk_oauth'),
    ).resolves.toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://canopy.example.test/api/v1/desktop-app/desktop-auth/current-key',
    );
    expect(init.method).toBe('DELETE');
    expect(init.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer csk_oauth',
    });
  });

  it('builds shared skill list query parameters', async () => {
    await listSharedSkills({
      query: 'review',
      limit: 10,
      cursor: 'next',
      createdBy: 'me',
    });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe(
      'https://canopy.example.test/api/v1/desktop-app/skills?limit=10&cursor=next&q=review&createdBy=me',
    );
  });

  it('publishes a public skill share and unwraps the response', async () => {
    const publicShare = {
      externalId: 'public-1',
      pinnedContentHash: 'sha256:skill',
      upToDate: true,
      sharePath: '/skills/public-1',
      createdAt: '2026-07-30T10:00:00.000Z',
      updatedAt: '2026-07-30T10:00:00.000Z',
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ publicShare }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(publishSkillPublicShare('skill/one')).resolves.toEqual(
      publicShare,
    );
    const publishCall = fetchMock.mock.calls[0];
    expect(publishCall?.[0]).toBe(
      'https://canopy.example.test/api/v1/desktop-app/skills/skill%2Fone/public-share',
    );
    expect(publishCall?.[1].method).toBe('POST');
    expect(publishCall?.[1].headers).toMatchObject({
      Authorization: 'Bearer secret-key',
    });
  });

  it('revokes a public skill share', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    await expect(revokeSkillPublicShare('skill/one')).resolves.toBeUndefined();
    const revokeCall = fetchMock.mock.calls[0];
    expect(revokeCall?.[0]).toBe(
      'https://canopy.example.test/api/v1/desktop-app/skills/skill%2Fone/public-share',
    );
    expect(revokeCall?.[1].method).toBe('DELETE');
    expect(revokeCall?.[1].headers).toMatchObject({
      Authorization: 'Bearer secret-key',
    });
  });

  it('keeps pipeline sharing requests on the common REST helper path', async () => {
    const query: Parameters<typeof listSharedPipelines>[0] = {
      q: 'build',
      limit: 5,
      createdBy: 'me',
    };
    // Keep exercising the legacy wire value although it is no longer in the typed request union.
    Reflect.set(query, 'triggerType', 'manual');
    await listSharedPipelines(query);

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe(
      'https://canopy.example.test/api/v1/desktop-app/pipelines?limit=5&q=build&triggerType=manual&createdBy=me',
    );
    expect(firstCall?.[1].headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer secret-key',
    });
  });

  it('denies sharing a skill into another organization before issuing a write', async () => {
    mockResourceLanesEnabled = true;
    await expect(
      createSharedSkill({
        rawSkill: '# Skill',
        shareScope: 'organization',
        organizationId: 'org-b',
      }),
    ).rejects.toThrow('context-mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('coalesces in-flight agent requests per lane and never shares another account ETag', async () => {
    mockResourceLanesEnabled = true;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async (url) => {
      await gate;
      return Response.json(
        { agents: [], nextCursor: null },
        {
          headers: {
            ETag: url.includes('private') ? 'personal' : 'organization',
          },
        },
      );
    });
    const first = listSharedAgents({});
    const second = listSharedAgents({});
    release?.();
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 304 })),
    );
    await expect(listSharedAgents({})).resolves.toMatchObject({ agents: [] });
    expect(fetchMock.mock.calls[2]?.[1].headers).toMatchObject({
      'If-None-Match': 'personal',
    });
    expect(fetchMock.mock.calls[3]?.[1].headers).toMatchObject({
      'If-None-Match': 'organization',
    });
    mockAccountEpoch += 1;
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ agents: [], nextCursor: null })),
    );
    await listSharedAgents({});
    expect(fetchMock.mock.calls[4]?.[1].headers).not.toHaveProperty(
      'If-None-Match',
    );
    expect(fetchMock.mock.calls[5]?.[1].headers).not.toHaveProperty(
      'If-None-Match',
    );
  });

  it('keeps the flag-off agent request unscoped', async () => {
    await listSharedAgents({ query: 'release', cursor: 'legacy', limit: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://canopy.example.test/api/v1/desktop-app/agents?limit=7&cursor=legacy&q=release',
    );
  });
  it.each([true, false])(
    'requires a stored agent for private sharing only with lanes enabled (%s)',
    async (enabled): Promise<void> => {
      mockResourceLanesEnabled = enabled;
      const operation = createSharedAgent({
        agent: {
          version: 1,
          id: 'agent_model_unknown',
          name: 'Copied org content',
          baseModel: 'sonnet',
          instructions: 'Organization instructions',
          plugins: [],
        },
        shareScope: 'private',
      });
      if (enabled) {
        await expect(operation).rejects.toThrow('Agent not found');
        expect(mockGetAgentModel).toHaveBeenCalledWith('agent_model_unknown');
        expect(mockSourceBinding).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      } else {
        await expect(operation).resolves.toEqual({ ok: true });
        expect(mockGetAgentModel).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    },
  );
  const updateDocument: SharedAgentDocument = {
    version: 1,
    id: 'agent_model_local',
    name: 'Local',
    baseModel: 'sonnet',
    instructions: 'Local instructions',
    plugins: [],
  };
  it('serializes package preservation for skill and pipeline audience changes', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ ok: true })),
    );
    await updateSharedPipeline('remote-pipeline', 'name: Review', {
      preservePackage: true,
    });
    expect(
      JSON.parse(requireBody(fetchMock.mock.calls.at(-1)?.[1].body)),
    ).toEqual(expect.objectContaining({ preservePackage: true }));
    await updateSharedSkill({
      skillId: 'remote-skill',
      rawSkill: '# Review',
      preservePackage: true,
    });
    expect(
      JSON.parse(requireBody(fetchMock.mock.calls.at(-1)?.[1].body)),
    ).toEqual(expect.objectContaining({ preservePackage: true }));
  });

  it('serializes observed public-share versions on resource updates', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ ok: true })),
    );
    const revokePublicShare = {
      externalId: '22222222-2222-4222-8222-222222222222',
      updatedAt: '2026-09-25T12:00:00.000Z',
    };
    const bodies: unknown[] = [];

    await updateSharedAgent({
      agentId: 'remote-agent',
      agent: updateDocument,
      revokePublicShare,
    });
    bodies.push(JSON.parse(requireBody(fetchMock.mock.calls.at(-1)?.[1].body)));

    await updateSharedAutomation({
      automationId: 'remote-automation',
      automation: {
        version: 1,
        name: 'Review',
        description: '',
        trigger: {
          kind: 'cron',
          expression: '0 9 * * *',
          timezone: 'local',
        },
        action: {
          type: 'app_advisor_prompt',
          prompt: 'Review',
          plugins: [],
        },
        hasRunCondition: false,
      },
      revokePublicShare,
    });
    bodies.push(JSON.parse(requireBody(fetchMock.mock.calls.at(-1)?.[1].body)));

    await updateSharedPipeline('remote-pipeline', 'name: Review', {
      revokePublicShare,
    });
    bodies.push(JSON.parse(requireBody(fetchMock.mock.calls.at(-1)?.[1].body)));

    await updateSharedSkill({
      skillId: 'remote-skill',
      rawSkill: '# Review',
      revokePublicShare,
    });
    bodies.push(JSON.parse(requireBody(fetchMock.mock.calls.at(-1)?.[1].body)));

    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect(body).toEqual(expect.objectContaining({ revokePublicShare }));
    }
  });
  const storedAgent: AgentModelDefinition = {
    ...updateDocument,
    pluginSelections: { skillRefs: [], pluginRefs: [], collectionIds: [] },
    createdAt: '2026-09-24T00:00:00Z',
    updatedAt: '2026-09-24T00:00:00Z',
  };
  function mockAccessibleAgent(): void {
    fetchMock.mockImplementation(
      (url): Promise<Response> =>
        Promise.resolve(
          Response.json(
            url.endsWith('/agents/remote-a')
              ? { owner: { type: 'organization', id: 'org-a', name: 'A' } }
              : { ok: true },
          ),
        ),
    );
    mockGetAgentModel.mockResolvedValue(storedAgent);
  }
  it.each([true, false])(
    'binds create content to the stored source only with lanes enabled (%s)',
    async (enabled): Promise<void> => {
      mockResourceLanesEnabled = enabled;
      mockAccessibleAgent();
      const supplied = {
        ...updateDocument,
        name: 'Forged',
        baseModel: 'other',
        instructions: 'Other organization secret',
      };
      await createSharedAgent({ agent: supplied, shareScope: 'private' });
      expect(
        fetchMock.mock.calls.find(([, init]) => init.method === 'POST')?.[1]
          .body,
      ).toBe(
        JSON.stringify({
          agent: enabled ? updateDocument : supplied,
          shareScope: 'private',
        }),
      );
    },
  );
  it('rejects create plugin selections that do not match the stored source', async (): Promise<void> => {
    mockResourceLanesEnabled = true;
    mockAccessibleAgent();
    mockGetAgentModel.mockResolvedValue({
      ...storedAgent,
      pluginSelections: {
        skillRefs: [{ sourceId: 'org-a', skillName: 'review' }],
        pluginRefs: [],
        collectionIds: [],
      },
    });
    await expect(
      createSharedAgent({ agent: updateDocument, shareScope: 'private' }),
    ).rejects.toThrow('Agent plugins do not match stored source');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['missing', 'denied', 'origin'])(
    'authorizes the local update source without shareScope: %s',
    async (failure): Promise<void> => {
      mockResourceLanesEnabled = true;
      mockAccessibleAgent();
      if (failure === 'missing') mockGetAgentModel.mockResolvedValue(null);
      if (failure === 'denied')
        mockGetAgentModel.mockRejectedValueOnce(
          new Error('Agent unavailable (context-mismatch)'),
        );
      if (failure === 'origin')
        mockSourceBinding.mockResolvedValue({
          accountId: 'user',
          receipt: {
            family: 'agents',
            remoteId: 'org-b-source',
            ownerContext: { kind: 'organization', organizationId: 'org-b' },
          },
        });
      await expect(
        updateSharedAgent({ agentId: 'remote-a', agent: updateDocument }),
      ).rejects.toThrow(
        failure === 'missing' ? 'Agent not found' : 'context-mismatch',
      );
      expect(
        fetchMock.mock.calls.every(([, init]) => init.method !== 'PUT'),
      ).toBe(true);
    },
  );
  it.each([undefined, 'organization'])(
    'binds update content to the authorized stored source with scope %s',
    async (scope): Promise<void> => {
      mockResourceLanesEnabled = true;
      mockAccessibleAgent();
      await updateSharedAgent({
        agentId: 'remote-a',
        agent: { ...updateDocument, instructions: 'Other organization secret' },
        ...(scope
          ? { shareScope: 'organization', organizationId: 'org-a' }
          : {}),
      });
      const put = fetchMock.mock.calls.find(
        ([, init]) => init.method === 'PUT',
      );
      expect(put?.[1].body).toBe(
        JSON.stringify({
          agent: updateDocument,
          ...(scope
            ? { shareScope: 'organization', organizationId: 'org-a' }
            : {}),
        }),
      );
      expect(mockGetAgentModel).toHaveBeenCalledWith(updateDocument.id);
      expect(mockSourceBinding).toHaveBeenCalledWith(
        'agents',
        updateDocument.id,
      );
    },
  );
  it('rejects update plugin selections that do not match the stored source', async (): Promise<void> => {
    mockResourceLanesEnabled = true;
    mockAccessibleAgent();
    mockGetAgentModel.mockResolvedValue({
      ...storedAgent,
      pluginSelections: {
        skillRefs: [{ sourceId: 'org-a', skillName: 'review' }],
        pluginRefs: [],
        collectionIds: [],
      },
    });
    await expect(
      updateSharedAgent({ agentId: 'remote-a', agent: updateDocument }),
    ).rejects.toThrow('Agent plugins do not match stored source');
    expect(
      fetchMock.mock.calls.every(([, init]) => init.method !== 'PUT'),
    ).toBe(true);
  });
  it.each([
    ['create', 'sonnet'],
    ['update', 'sonnet'],
    ['create', 'default'],
  ])(
    'preserves portable plugins bound to the stored selections on %s with base %s',
    async (operation, baseModel): Promise<void> => {
      mockResourceLanesEnabled = true;
      mockAccessibleAgent();
      initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
      const ref: SharedAgentDocument['plugins'][number] = {
        type: 'plugin',
        marketplace: { type: 'github', repo: 'acme/plugins' },
        plugin_name: 'review',
      };
      const plugins = [ref];
      mockGetAgentModel.mockResolvedValue({
        ...storedAgent,
        baseModel,
        pluginSelections: {
          skillRefs: [],
          pluginRefs: [{ marketplaceId: 'acme', pluginName: 'review' }],
          collectionIds: [],
        },
      });
      jest.mocked(resolveShareablePluginRefs).mockReturnValueOnce([
        {
          matchState: 'matched',
          ref,
          catalogKey: 'acme/review',
          selection: {
            kind: 'plugin',
            marketplaceId: 'acme',
            pluginName: 'review',
          },
        },
      ]);
      const supplied = {
        ...updateDocument,
        baseModel,
        plugins: [{ ...ref, instructions: 'Other organization secret' }],
      };
      if (operation === 'create') {
        await createSharedAgent({ agent: supplied });
      } else {
        await updateSharedAgent({ agentId: 'remote-a', agent: supplied });
      }
      expect(
        fetchMock.mock.calls.find(
          ([, init]) =>
            init.method === (operation === 'create' ? 'POST' : 'PUT'),
        )?.[1].body,
      ).toBe(
        JSON.stringify({ agent: { ...updateDocument, baseModel, plugins } }),
      );
    },
  );
  it('preserves the exact flag-off update payload without reading a local source', async (): Promise<void> => {
    const request = {
      agentId: 'remote-a',
      agent: updateDocument,
      expectedContentHash: 'old',
    };
    await updateSharedAgent(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1].body).toBe(
      JSON.stringify({ agent: updateDocument, expectedContentHash: 'old' }),
    );
    expect(mockGetAgentModel).not.toHaveBeenCalled();
    expect(mockSourceBinding).not.toHaveBeenCalled();
  });
  it('looks up a destination team beyond the first page by ID', async (): Promise<void> => {
    mockResourceLanesEnabled = true;
    mockGetAgentModel.mockResolvedValue(storedAgent);
    fetchMock.mockImplementation(
      (url): Promise<Response> =>
        Promise.resolve(
          Response.json(
            url.includes('/teams')
              ? {
                  data: url.includes('id=team-51')
                    ? [
                        {
                          id: 'team-51',
                          organizationId: 'org-a',
                          name: 'Team 51',
                        },
                      ]
                    : Array.from({ length: 50 }, (_, index) => ({
                        id: `team-${index}`,
                        organizationId: 'org-a',
                        name: `Team ${index}`,
                      })),
                }
              : { ok: true },
          ),
        ),
    );
    await expect(
      createSharedAgent({
        agent: updateDocument,
        shareScope: 'team',
        teamId: 'team-51',
      }),
    ).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/teams?id=team-51');
  });
  it('refuses sharing an agent into a different organization before POST', async () => {
    mockResourceLanesEnabled = true;
    await expect(
      createSharedAgent({
        agent: {
          version: 1,
          id: 'agent_model_review',
          name: 'Review',
          baseModel: 'sonnet',
          instructions: '',
          plugins: [],
        },
        shareScope: 'organization',
        organizationId: 'org-b',
      }),
    ).rejects.toThrow('context-mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('fetches Personal and exact organization lanes independently', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ agents: [], nextCursor: null })),
    );
    await listSharedAgents({ query: 'release' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://canopy.example.test/api/v1/desktop-app/agents?q=release&shareScope=private',
      'https://canopy.example.test/api/v1/desktop-app/agents?q=release&shareScope=organization&organizationId=org-a',
    ]);
  });

  it('blocks a direct id belonging to another organization', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockResolvedValue(
      Response.json({
        id: 'org-b-agent',
        owner: { type: 'organization', id: 'org-b', name: 'B' },
      }),
    );
    await expect(getSharedAgent('org-b-agent')).rejects.toThrow(
      'Agent unavailable',
    );
  });

  it.each(['personal', 'org-a', 'org-b'])(
    'composes authorized rows in %s',
    async (context) => {
      mockResourceLanesEnabled = true;
      mockResourceContext.kind =
        context === 'personal' ? 'personal' : 'organization';
      mockResourceContext.organizationId = context;
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          Response.json({
            agents: [
              {
                id: 'private',
                owner: { type: 'user', id: 'user', name: 'User' },
              },
              {
                id: 'a',
                owner: { type: 'organization', id: 'org-a', name: 'A' },
              },
              {
                id: 'b',
                owner: { type: 'organization', id: 'org-b', name: 'B' },
              },
            ],
            nextCursor: null,
          }),
        ),
      );
      const result = await listSharedAgents({});
      expect(result.agents.map((row) => row.id)).toEqual(
        context === 'personal'
          ? ['private']
          : ['private', context === 'org-a' ? 'a' : 'b'],
      );
    },
  );

  it('keeps page cursors and ETags independent for each lane', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation((url) => {
      const personal = url.includes('shareScope=private');
      return Promise.resolve(
        Response.json(
          {
            agents: [],
            nextCursor: url.includes('cursor=')
              ? null
              : personal
                ? 'personal-next'
                : 'org-next',
          },
          { headers: { ETag: personal ? 'personal-etag' : 'org-etag' } },
        ),
      );
    });
    const first = await listSharedAgents({});
    await listSharedAgents({});
    expect(fetchMock.mock.calls[2]?.[1].headers).toMatchObject({
      'If-None-Match': 'personal-etag',
    });
    expect(fetchMock.mock.calls[3]?.[1].headers).toMatchObject({
      'If-None-Match': 'org-etag',
    });
    await listSharedAgents({ cursor: first.nextCursor ?? undefined });
    expect(fetchMock.mock.calls[4]?.[0]).toContain('cursor=personal-next');
    expect(fetchMock.mock.calls[5]?.[0]).toContain('cursor=org-next');
    mockResourceRevision += 1;
    mockResourceContext.organizationId = 'org-b';
    await expect(
      listSharedAgents({ cursor: first.nextCursor ?? undefined }),
    ).rejects.toThrow('context-mismatch');
  });

  it('discards an in-flight response after a context switch', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation(() => {
      mockResourceRevision += 1;
      return Promise.resolve(Response.json({ agents: [], nextCursor: null }));
    });
    await expect(listSharedAgents({})).rejects.toThrow('context-mismatch');
  });

  it.each([
    [
      'update',
      (): Promise<unknown> =>
        updateSharedAgent({
          agentId: 'remote-b',
          agent: {
            version: 1,
            id: 'agent_model_review',
            name: 'Review',
            baseModel: 'sonnet',
            instructions: '',
            plugins: [],
          },
        }),
    ],
    [
      'delete',
      (): Promise<unknown> => deleteSharedAgent({ agentId: 'remote-b' }),
    ],
    ['publish', (): Promise<unknown> => publishAgentPublicShare('remote-b')],
    ['revoke', (): Promise<unknown> => revokeAgentPublicShare('remote-b')],
  ])(
    'rechecks %s before remote mutation or download',
    async (_name, invoke) => {
      mockResourceLanesEnabled = true;
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          Response.json({
            id: 'remote-b',
            owner: { type: 'organization', id: 'org-b', name: 'B' },
          }),
        ),
      );
      await expect(invoke()).rejects.toThrow('context-mismatch');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain('/agents/remote-b');
    },
  );

  it('fetches Personal and exact organization lanes independently', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ skills: [], nextCursor: null })),
    );
    await listSharedSkills({ query: 'release' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://canopy.example.test/api/v1/desktop-app/skills?q=release&shareScope=private',
      'https://canopy.example.test/api/v1/desktop-app/skills?q=release&shareScope=organization&organizationId=org-a',
    ]);
  });

  it('blocks a direct id belonging to another organization', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockResolvedValue(
      Response.json({
        id: 'org-b-skill',
        owner: { type: 'organization', id: 'org-b', name: 'B' },
      }),
    );
    await expect(getSharedSkill('org-b-skill')).rejects.toThrow(
      'Skill unavailable',
    );
  });

  it.each(['personal', 'org-a', 'org-b'])(
    'composes authorized rows in %s',
    async (context) => {
      mockResourceLanesEnabled = true;
      mockResourceContext.kind =
        context === 'personal' ? 'personal' : 'organization';
      mockResourceContext.organizationId = context;
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          Response.json({
            skills: [
              {
                id: 'private',
                owner: { type: 'user', id: 'user', name: 'User' },
              },
              {
                id: 'a',
                owner: { type: 'organization', id: 'org-a', name: 'A' },
              },
              {
                id: 'b',
                owner: { type: 'organization', id: 'org-b', name: 'B' },
              },
            ],
            nextCursor: null,
          }),
        ),
      );
      const result = await listSharedSkills({});
      expect(result.skills.map((row) => row.id)).toEqual(
        context === 'personal'
          ? ['private']
          : ['private', context === 'org-a' ? 'a' : 'b'],
      );
    },
  );

  it('keeps page cursors and ETags independent for each lane', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation((url) => {
      const personal = url.includes('shareScope=private');
      return Promise.resolve(
        Response.json(
          {
            skills: [],
            nextCursor: url.includes('cursor=')
              ? null
              : personal
                ? 'personal-next'
                : 'org-next',
          },
          { headers: { ETag: personal ? 'personal-etag' : 'org-etag' } },
        ),
      );
    });
    const first = await listSharedSkills({});
    await listSharedSkills({});
    expect(fetchMock.mock.calls[2]?.[1].headers).toMatchObject({
      'If-None-Match': 'personal-etag',
    });
    expect(fetchMock.mock.calls[3]?.[1].headers).toMatchObject({
      'If-None-Match': 'org-etag',
    });
    await listSharedSkills({ cursor: first.nextCursor ?? undefined });
    expect(fetchMock.mock.calls[4]?.[0]).toContain('cursor=personal-next');
    expect(fetchMock.mock.calls[5]?.[0]).toContain('cursor=org-next');
    mockResourceRevision += 1;
    mockResourceContext.organizationId = 'org-b';
    await expect(
      listSharedSkills({ cursor: first.nextCursor ?? undefined }),
    ).rejects.toThrow('context-mismatch');
  });

  it('discards an in-flight response after a context switch', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation(() => {
      mockResourceRevision += 1;
      return Promise.resolve(Response.json({ skills: [], nextCursor: null }));
    });
    await expect(listSharedSkills({})).rejects.toThrow('context-mismatch');
  });

  it.each([
    ['rejects', 'an account switch', true],
    ['keeps', 'a sidebar selection change', false],
  ] as const)(
    '%s a caller-context automation fetch across %s',
    async (_outcome, _change, switchAccount) => {
      mockResourceLanesEnabled = true;
      let release: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const detail = { id: 'a', owner: { type: 'user', id: 'user-1' } };
      fetchMock.mockImplementation(async () => {
        markStarted?.();
        await gate;
        return Response.json(detail);
      });
      const fetched = getSharedAutomation('a', { kind: 'personal' });
      await started;
      if (switchAccount) mockAccountEpoch += 1;
      else mockResourceRevision += 1;
      release?.();
      if (switchAccount)
        await expect(fetched).rejects.toThrow('context-mismatch');
      else await expect(fetched).resolves.toEqual(detail);
    },
  );

  describe.each([
    [
      'automations',
      async (): Promise<Array<{ id: string }>> =>
        (await listSharedAutomations({})).automations,
      getSharedAutomation,
    ],
    [
      'collections',
      async (): Promise<Array<{ id: string }>> =>
        (await listSharedCollections({})).collections,
      getSharedCollection,
    ],
  ] as const)('%s resource contexts', (family, list, get) => {
    it('preserves the unscoped single-fetch path with the flag disabled', async () => {
      mockResourceLanesEnabled = false;
      const foreign = {
        id: 'b',
        owner: { type: 'organization', id: 'org-b', name: 'B' },
      };
      fetchMock.mockResolvedValueOnce(Response.json({ [family]: [foreign] }));
      expect(await list()).toEqual([foreign]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `https://canopy.example.test/api/v1/desktop-app/${family}`,
      );
      fetchMock.mockResolvedValueOnce(Response.json(foreign));
      await expect(get('b')).resolves.toEqual(foreign);
    });
    it.each(['personal', 'org-a', 'org-b'])(
      'isolates inventory in %s',
      async (context) => {
        mockResourceLanesEnabled = true;
        mockResourceContext.kind =
          context === 'personal' ? 'personal' : 'organization';
        mockResourceContext.organizationId = context;
        fetchMock.mockImplementation(() =>
          Promise.resolve(
            Response.json({
              [family]: [
                {
                  id: 'private',
                  owner: { type: 'user', id: 'user', name: 'User' },
                },
                {
                  id: 'a',
                  owner: { type: 'organization', id: 'org-a', name: 'A' },
                },
                {
                  id: 'b',
                  owner: { type: 'organization', id: 'org-b', name: 'B' },
                },
              ],
            }),
          ),
        );
        expect((await list()).map((row) => row.id)).toEqual(
          context === 'personal'
            ? ['private']
            : ['private', context === 'org-a' ? 'a' : 'b'],
        );
        expect(fetchMock.mock.calls[0]?.[0]).toContain('shareScope=private');
      },
    );
    it('keeps cursors per lane and rejects cursors from the previous context', async () => {
      mockResourceLanesEnabled = true;
      const page = (cursor?: string): Promise<{ nextCursor?: string }> =>
        family === 'automations'
          ? listSharedAutomations({ cursor })
          : listSharedCollections({ cursor });
      fetchMock.mockImplementation((url) =>
        Promise.resolve(
          Response.json({
            [family]: [],
            nextCursor: url.includes('cursor=')
              ? undefined
              : url.includes('shareScope=private')
                ? 'personal-next'
                : 'org-next',
          }),
        ),
      );
      const first = await page();
      await page(first.nextCursor);
      expect(fetchMock.mock.calls[2]?.[0]).toContain('cursor=personal-next');
      expect(fetchMock.mock.calls[3]?.[0]).toContain('cursor=org-next');
      mockResourceRevision += 1;
      mockResourceContext.organizationId = 'org-b';
      await expect(page(first.nextCursor)).rejects.toThrow('context-mismatch');
    });
    it('fences pending inventory when context changes', async () => {
      mockResourceLanesEnabled = true;
      fetchMock.mockImplementation(() => {
        mockResourceRevision += 1;
        return Promise.resolve(Response.json({ [family]: [] }));
      });
      await expect(list()).rejects.toThrow('context-mismatch');
    });
    it('keeps conditional inventory caches in their own lanes', async () => {
      mockResourceLanesEnabled = true;
      fetchMock.mockImplementation((url) =>
        Promise.resolve(
          Response.json(
            { [family]: [] },
            {
              headers: {
                ETag: url.includes('shareScope=private')
                  ? 'personal'
                  : 'organization',
              },
            },
          ),
        ),
      );
      await list();
      await list();
      expect(fetchMock.mock.calls[2]?.[1].headers).toMatchObject({
        'If-None-Match': 'personal',
      });
      expect(fetchMock.mock.calls[3]?.[1].headers).toMatchObject({
        'If-None-Match': 'organization',
      });
      mockResourceRevision += 1;
      mockResourceContext.organizationId = 'org-b';
      await list();
      expect(fetchMock.mock.calls[4]?.[1].headers).not.toHaveProperty(
        'If-None-Match',
      );
      expect(fetchMock.mock.calls[5]?.[0]).toContain('organizationId=org-b');
    });
    it('denies a direct foreign id', async () => {
      mockResourceLanesEnabled = true;
      fetchMock.mockResolvedValue(
        Response.json({
          id: 'b',
          owner: { type: 'organization', id: 'org-b', name: 'B' },
        }),
      );
      await expect(get('b')).rejects.toThrow('context-mismatch');
    });
  });

  describe('enabled skill upload sources', () => {
    const owner = { type: 'user', id: 'user', name: null };
    beforeEach(() => {
      mockResourceLanesEnabled = true;
      fetchMock.mockImplementation(() =>
        Promise.resolve(Response.json({ id: 'remote', owner })),
      );
    });
    it.each(['create', 'update'])(
      'rejects %s without a local source before writing',
      async (operation): Promise<void> => {
        const request = { skillId: 'remote', rawSkill: 'untrusted' };
        await expect(
          operation === 'create'
            ? createSharedSkill(request)
            : updateSharedSkill(request),
        ).rejects.toThrow('source');
        expect(
          fetchMock.mock.calls.some(
            ([, init]) => init.method === 'POST' || init.method === 'PUT',
          ),
        ).toBe(false);
      },
    );
    it.each(['create', 'update'])(
      'binds %s bytes to the authorized local source',
      async (operation): Promise<void> => {
        const request = {
          skillId: 'remote',
          sourceSkillId: 'custom:app/source',
          rawSkill: 'forged',
        };
        await (operation === 'create'
          ? createSharedSkill(request)
          : updateSharedSkill(request));
        expect(mockStoredSkillContext).toHaveBeenCalledWith(
          request.sourceSkillId,
        );
        expect(mockSkillShareOrigin).toHaveBeenCalledWith(
          request.sourceSkillId,
          expect.objectContaining({ type: 'user' }),
        );
        expect(mockReadRawSkill).toHaveBeenCalledWith(request.sourceSkillId);
        expect(fetchMock.mock.calls.at(-1)?.[1].body).toBe(
          JSON.stringify({ rawSkill: 'stored skill' }),
        );
      },
    );
    it.each(['create', 'update'])(
      'rejects %s with an unknown local source',
      async (operation): Promise<void> => {
        mockReadRawSkill.mockRejectedValueOnce(new Error('Skill not found'));
        const request = {
          skillId: 'remote',
          sourceSkillId: 'custom:app/missing',
          rawSkill: 'forged',
        };
        await expect(
          operation === 'create'
            ? createSharedSkill(request)
            : updateSharedSkill(request),
        ).rejects.toThrow('not found');
        expect(
          fetchMock.mock.calls.some(
            ([, init]) => init.method === 'POST' || init.method === 'PUT',
          ),
        ).toBe(false);
      },
    );
    it.each(['create', 'update'])(
      'rejects %s when the installed source origin cannot be shared',
      async (operation): Promise<void> => {
        mockSkillShareOrigin.mockRejectedValueOnce(
          new Error('unsupported-target'),
        );
        const request = {
          skillId: 'remote',
          sourceSkillId: 'custom:app/org-source',
          rawSkill: 'forged',
        };
        await expect(
          operation === 'create'
            ? createSharedSkill(request)
            : updateSharedSkill(request),
        ).rejects.toThrow('unsupported-target');
        expect(
          fetchMock.mock.calls.some(
            ([, init]) => init.method === 'POST' || init.method === 'PUT',
          ),
        ).toBe(false);
      },
    );
    it.each(['create', 'update'])(
      'rejects an unqualified %s source that would miss its receipt binding',
      async (operation): Promise<void> => {
        const request = {
          skillId: 'remote',
          sourceSkillId: 'source',
          rawSkill: 'forged',
        };
        await expect(
          operation === 'create'
            ? createSharedSkill(request)
            : updateSharedSkill(request),
        ).rejects.toThrow('source');
        expect(
          fetchMock.mock.calls.some(
            ([, init]) => init.method === 'POST' || init.method === 'PUT',
          ),
        ).toBe(false);
      },
    );
    it('looks up the requested team by id beyond the default page', async (): Promise<void> => {
      fetchMock.mockImplementation((url) =>
        Promise.resolve(
          Response.json(
            url.includes('/teams')
              ? {
                  data: url.includes('id=team-late')
                    ? [
                        {
                          id: 'team-late',
                          name: 'Late',
                          organization: { id: 'org-a', name: 'A' },
                        },
                      ]
                    : [],
                }
              : { id: 'remote', owner },
          ),
        ),
      );
      await createSharedSkill({
        sourceSkillId: 'custom:app/source',
        rawSkill: 'forged',
        shareScope: 'team',
        teamId: 'team-late',
      });
      expect(fetchMock.mock.calls[0]?.[0]).toContain('id=team-late');
    });
    it.each(['create', 'update'])(
      'preserves the exact flag-off %s payload without a source',
      async (operation): Promise<void> => {
        mockResourceLanesEnabled = false;
        const request = { skillId: 'remote', rawSkill: 'legacy bytes' };
        await (operation === 'create'
          ? createSharedSkill(request)
          : updateSharedSkill(request));
        expect(mockReadRawSkill).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[1].body).toBe(
          JSON.stringify({ rawSkill: 'legacy bytes' }),
        );
      },
    );
  });

  it.each([
    [
      'update',
      (): Promise<unknown> =>
        updateSharedSkill({ skillId: 'remote-b', rawSkill: 'name: changed' }),
    ],
    [
      'delete',
      (): Promise<unknown> => deleteSharedSkill({ skillId: 'remote-b' }),
    ],
    ['publish', (): Promise<unknown> => publishSkillPublicShare('remote-b')],
    ['revoke', (): Promise<unknown> => revokeSkillPublicShare('remote-b')],
  ])(
    'rechecks %s before remote mutation or download',
    async (_name, invoke) => {
      mockResourceLanesEnabled = true;
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          Response.json({
            id: 'remote-b',
            owner: { type: 'organization', id: 'org-b', name: 'B' },
          }),
        ),
      );
      await expect(invoke()).rejects.toThrow('context-mismatch');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain('/skills/remote-b');
    },
  );

  it.each([
    [
      'automation package',
      (): Promise<unknown> => getAutomationPackage('b', 'digest'),
    ],
    [
      'automation package blob',
      (): Promise<unknown> => getAutomationPackageBlob('b', 'digest', 'hash'),
    ],
    [
      'collection update',
      (): Promise<unknown> =>
        updateSharedCollection({
          collectionId: 'b',
          rawCollection: '{}',
        }),
    ],
    [
      'collection delete',
      (): Promise<unknown> => deleteSharedCollection({ collectionId: 'b' }),
    ],
    [
      'automation update',
      (): Promise<unknown> =>
        updateSharedAutomation({
          automationId: 'b',
          automation: {
            version: 1,
            name: 'Denied automation',
            description: '',
            trigger: {
              kind: 'cron',
              expression: '0 9 * * *',
              timezone: 'local',
            },
            action: {
              type: 'app_advisor_prompt',
              prompt: 'Review',
              plugins: [],
            },
            hasRunCondition: false,
          },
        }),
    ],
    [
      'automation delete',
      (): Promise<unknown> => deleteSharedAutomation({ automationId: 'b' }),
    ],
    [
      'automation publish',
      (): Promise<unknown> => publishAutomationPublicShare('b'),
    ],
    [
      'automation revoke',
      (): Promise<unknown> => revokeAutomationPublicShare('b'),
    ],
  ] as const)('blocks %s before a remote write', async (_label, mutate) => {
    mockResourceLanesEnabled = true;
    fetchMock.mockResolvedValue(
      Response.json({
        id: 'b',
        owner: { type: 'organization', id: 'org-b', name: 'B' },
      }),
    );
    await expect(mutate()).rejects.toThrow('context-mismatch');
    expect(
      fetchMock.mock.calls.every(
        ([, options]) => !options.method || options.method === 'GET',
      ),
    ).toBe(true);
  });

  it('shares a selected team beyond the first unfiltered page by exact id', async (): Promise<void> => {
    mockResourceLanesEnabled = true;
    const teamId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    mockResourceContext.organizationId = teamId;
    fetchMock.mockImplementation((url): Promise<Response> => {
      const requested = new URL(String(url));
      const data =
        requested.searchParams.get('id') === teamId
          ? [
              {
                id: teamId,
                name: 'Late team',
                organization: { id: teamId, name: 'Org' },
              },
            ]
          : [];
      return Promise.resolve(
        new Response(
          JSON.stringify(
            requested.pathname.endsWith('/teams') ? { data } : { id: 'shared' },
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    });
    await expect(
      createSharedPipeline({
        rawPipeline: 'pipeline:\n  name: New\n  on: dispatch\n  jobs: {}',
        shareScope: 'team',
        teamId,
      }),
    ).resolves.toEqual({ id: 'shared' });
    expect(fetchMock.mock.calls[0]?.[0]).toContain(`/teams?id=${teamId}`);
  });

  it('refuses organization-origin YAML without a source id', async () => {
    mockResourceLanesEnabled = true;
    mockReceiptRows.mockResolvedValue([
      {
        family: 'pipelines',
        remoteId: 'remote-a',
        shareScope: 'organization',
        ownerContext: { kind: 'organization', organizationId: 'org-a' },
        hash: createHash('sha256').update('installed yaml').digest('hex'),
        authorizedAt: '2026-09-23T00:00:00Z',
      },
    ]);
    await expect(
      createSharedPipeline({ rawPipeline: 'installed yaml' }),
    ).rejects.toThrow('Workflow unavailable (context-mismatch)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows organization-origin YAML only when sharing back to the same organization', async () => {
    mockResourceLanesEnabled = true;
    mockResourceContext.organizationId = 'org-a';
    const rawPipeline = 'name: Same org\non: dispatch\njobs: {}';
    mockReceiptRows.mockResolvedValue([
      {
        family: 'pipelines',
        remoteId: 'remote-a',
        shareScope: 'organization',
        ownerContext: { kind: 'organization', organizationId: 'org-a' },
        hash: createHash('sha256').update(rawPipeline).digest('hex'),
        authorizedAt: '2026-09-23T00:00:00Z',
      },
    ]);

    await expect(
      createSharedPipeline({
        rawPipeline,
        shareScope: 'organization',
        organizationId: 'org-a',
      }),
    ).resolves.toBeDefined();
    await expect(
      createSharedPipeline({
        rawPipeline,
        shareScope: 'private',
      }),
    ).rejects.toThrow('context-mismatch');
  });

  it('refuses reformatted Advisor content without its stored source locator', async () => {
    mockResourceLanesEnabled = true;
    await expect(
      createSharedPipeline({
        rawPipeline: 'pipeline:\n  name: Release\n  on: dispatch\n  jobs: {}',
      }),
    ).rejects.toThrow('context-mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares authorized stored YAML instead of caller content', async () => {
    mockResourceLanesEnabled = true;
    mockResourceContext.organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    mockSourceBinding.mockResolvedValue({
      accountId: 'user',
      receipt: {
        family: 'pipelines',
        remoteId: 'remote-a',
        shareScope: 'organization',
        ownerContext: {
          kind: 'organization',
          organizationId: mockResourceContext.organizationId,
        },
        hash: 'old',
        authorizedAt: '2026-09-23T00:00:00Z',
        localResourceIds: ['local-a'],
      },
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        Response.json({
          id: 'remote-a',
          owner: {
            type: 'organization',
            id: mockResourceContext.organizationId,
            name: 'A',
          },
        }),
      ),
    );
    await createSharedPipeline({
      sourcePipelineId: 'local-a',
      rawPipeline: 'pipeline:\n  name: Release\n  on: dispatch\n  jobs: {}',
      shareScope: 'organization',
      organizationId: mockResourceContext.organizationId,
    });
    expect(
      JSON.parse(requireBody(fetchMock.mock.calls.at(-1)?.[1].body)),
    ).toMatchObject({ rawPipeline: 'stored source' });
  });

  it.each(['context', 'revision'])(
    'refuses publication when %s changes while loading source',
    async (change): Promise<void> => {
      mockResourceLanesEnabled = true;
      await expect(
        createSharedPipeline(
          {
            sourcePipelineId: 'local-a',
            rawPipeline: 'caller yaml',
          },
          (): Promise<string> => {
            if (change === 'context')
              mockResourceContext.organizationId = 'org-b';
            else mockResourceRevision += 1;
            return Promise.resolve('stored source');
          },
        ),
      ).rejects.toThrow('Workflow unavailable (context-mismatch)');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('reauthorizes the stored source after loading before publishing', async (): Promise<void> => {
    mockResourceLanesEnabled = true;
    await expect(
      createSharedPipeline(
        { sourcePipelineId: 'local-a', rawPipeline: 'name: Edited' },
        (): Promise<string> => {
          mockSourceBinding.mockResolvedValue({
            accountId: 'revoked-account',
            receipt: {
              ownerContext: { kind: 'organization', organizationId: 'org-a' },
            },
          });
          return Promise.resolve('name: Renamed');
        },
      ),
    ).rejects.toThrow('Workflow unavailable (access-removed)');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses renamed stored bytes when the receipt hash and catalog name are stale', async (): Promise<void> => {
    mockResourceLanesEnabled = true;
    const rawPipeline = 'name: Renamed pipeline\non: dispatch\njobs: {}';
    mockSourceText.mockReturnValueOnce({ success: true, data: rawPipeline });
    await expect(createSharedPipeline({ rawPipeline })).rejects.toThrow(
      'context-mismatch',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows genuinely new YAML without a receipt', async () => {
    mockResourceLanesEnabled = true;
    await createSharedPipeline({
      rawPipeline: 'name: New pipeline\non: dispatch\njobs: {}',
    });
    expect(JSON.parse(requireBody(fetchMock.mock.calls[0]?.[1].body))).toEqual({
      rawPipeline: 'name: New pipeline\non: dispatch\njobs: {}',
    });
  });

  it('keeps flag-off share bytes unchanged even when a source id is supplied', async () => {
    await createSharedPipeline({
      sourcePipelineId: 'local-a',
      rawPipeline: 'caller yaml',
      shareScope: 'private',
    });
    expect(fetchMock.mock.calls[0]?.[1].body).toBe(
      JSON.stringify({ rawPipeline: 'caller yaml', shareScope: 'private' }),
    );
    expect(mockSourceText).not.toHaveBeenCalled();
    expect(mockReceiptRows).not.toHaveBeenCalled();
  });

  it('uses one page budget across pipeline lanes', async () => {
    mockResourceLanesEnabled = true;
    mockResourceContext.organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        Response.json({
          data: Array.from({ length: 4 }, (_, i) => ({
            id: `${url.includes('shareScope=private') ? 'p' : 'o'}${i}`,
            owner: url.includes('shareScope=private')
              ? { type: 'user', id: 'user' }
              : {
                  type: 'organization',
                  id: mockResourceContext.organizationId,
                  name: null,
                },
          })),
          nextCursor: null,
        }),
      ),
    );
    const first = await listSharedPipelines({ limit: 5 });
    expect(first.data.map((row) => row.id)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'o0',
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listSharedPipelines({
      limit: 5,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.data.map((row) => row.id)).toEqual(['o1', 'o2', 'o3']);
    expect(second.nextCursor).toBeNull();
  });

  it('uses one page budget across agent lanes', async () => {
    mockResourceLanesEnabled = true;
    mockResourceContext.organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        Response.json({
          agents: Array.from({ length: 4 }, (_, i) => ({
            id: `${url.includes('shareScope=private') ? 'p' : 'o'}${i}`,
            owner: url.includes('shareScope=private')
              ? { type: 'user', id: 'user' }
              : {
                  type: 'organization',
                  id: mockResourceContext.organizationId,
                  name: null,
                },
          })),
          nextCursor: null,
        }),
      ),
    );
    const first = await listSharedAgents({ limit: 5 });
    expect(first.agents.map((row) => row.id)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'o0',
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listSharedAgents({
      limit: 5,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.agents.map((row) => row.id)).toEqual(['o1', 'o2', 'o3']);
    expect(second.nextCursor ?? null).toBeNull();
  });

  it('uses one page budget across skill lanes', async () => {
    mockResourceLanesEnabled = true;
    mockResourceContext.organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        Response.json({
          skills: Array.from({ length: 4 }, (_, i) => ({
            id: `${url.includes('shareScope=private') ? 'p' : 'o'}${i}`,
            owner: url.includes('shareScope=private')
              ? { type: 'user', id: 'user' }
              : {
                  type: 'organization',
                  id: mockResourceContext.organizationId,
                  name: null,
                },
          })),
          nextCursor: null,
        }),
      ),
    );
    const first = await listSharedSkills({ limit: 5 });
    expect(first.skills.map((row) => row.id)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
      'o0',
    ]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listSharedSkills({
      limit: 5,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.skills.map((row) => row.id)).toEqual(['o1', 'o2', 'o3']);
    expect(second.nextCursor ?? null).toBeNull();
  });

  it('fetches Personal and exact organization lanes independently', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json({ data: [], nextCursor: null })),
    );
    await listSharedPipelines({ q: 'release' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://canopy.example.test/api/v1/desktop-app/pipelines?q=release&shareScope=private',
      'https://canopy.example.test/api/v1/desktop-app/pipelines?q=release&shareScope=organization&organizationId=org-a',
    ]);
  });

  it('blocks a direct id belonging to another organization', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockResolvedValue(
      Response.json({
        id: 'org-b-pipeline',
        owner: { type: 'organization', id: 'org-b', name: 'B' },
      }),
    );
    await expect(getSharedPipeline('org-b-pipeline')).rejects.toThrow(
      'Workflow unavailable',
    );
  });

  it.each(['personal', 'org-a', 'org-b'])(
    'composes authorized rows in %s',
    async (context) => {
      mockResourceLanesEnabled = true;
      mockResourceContext.kind =
        context === 'personal' ? 'personal' : 'organization';
      mockResourceContext.organizationId = context;
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          Response.json({
            data: [
              {
                id: 'private',
                owner: { type: 'user', id: 'user', name: 'User' },
              },
              {
                id: 'a',
                owner: { type: 'organization', id: 'org-a', name: 'A' },
              },
              {
                id: 'b',
                owner: { type: 'organization', id: 'org-b', name: 'B' },
              },
            ],
            nextCursor: null,
          }),
        ),
      );
      const result = await listSharedPipelines({});
      expect(result.data.map((row) => row.id)).toEqual(
        context === 'personal'
          ? ['private']
          : ['private', context === 'org-a' ? 'a' : 'b'],
      );
    },
  );

  it('keeps page cursors and ETags independent for each lane', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation((url) => {
      const personal = url.includes('shareScope=private');
      return Promise.resolve(
        Response.json(
          {
            data: [],
            nextCursor: url.includes('cursor=')
              ? null
              : personal
                ? 'personal-next'
                : 'org-next',
          },
          { headers: { ETag: personal ? 'personal-etag' : 'org-etag' } },
        ),
      );
    });
    const first = await listSharedPipelines({});
    await listSharedPipelines({});
    expect(fetchMock.mock.calls[2]?.[1].headers).toMatchObject({
      'If-None-Match': 'personal-etag',
    });
    expect(fetchMock.mock.calls[3]?.[1].headers).toMatchObject({
      'If-None-Match': 'org-etag',
    });
    await listSharedPipelines({ cursor: first.nextCursor ?? undefined });
    expect(fetchMock.mock.calls[4]?.[0]).toContain('cursor=personal-next');
    expect(fetchMock.mock.calls[5]?.[0]).toContain('cursor=org-next');
    mockResourceRevision += 1;
    mockResourceContext.organizationId = 'org-b';
    await expect(
      listSharedPipelines({ cursor: first.nextCursor ?? undefined }),
    ).rejects.toThrow('context-mismatch');
  });

  it('discards an in-flight response after a context switch', async () => {
    mockResourceLanesEnabled = true;
    fetchMock.mockImplementation(() => {
      mockResourceRevision += 1;
      return Promise.resolve(Response.json({ data: [], nextCursor: null }));
    });
    await expect(listSharedPipelines({})).rejects.toThrow('context-mismatch');
  });

  it.each([
    [
      'update',
      (): Promise<unknown> => updateSharedPipeline('remote-b', 'name: changed'),
    ],
    ['delete', (): Promise<unknown> => deleteSharedPipeline('remote-b')],
    ['publish', (): Promise<unknown> => publishPipelinePublicShare('remote-b')],
    ['revoke', (): Promise<unknown> => revokePipelinePublicShare('remote-b')],
    [
      'package',
      (): Promise<unknown> => getPipelinePackage('remote-b', 'digest'),
    ],
    [
      'blob',
      (): Promise<unknown> =>
        getPipelinePackageBlob('remote-b', 'digest', 'hash'),
    ],
  ])(
    'rechecks %s before remote mutation or download',
    async (_name, invoke) => {
      mockResourceLanesEnabled = true;
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          Response.json({
            id: 'remote-b',
            owner: { type: 'organization', id: 'org-b', name: 'B' },
          }),
        ),
      );
      await expect(invoke()).rejects.toThrow('context-mismatch');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toContain('/pipelines/remote-b');
    },
  );

  it.each([
    [
      'update',
      (): Promise<unknown> => updateSharedPipeline('remote-a', 'name: changed'),
    ],
    ['delete', (): Promise<unknown> => deleteSharedPipeline('remote-a')],
    ['publish', (): Promise<unknown> => publishPipelinePublicShare('remote-a')],
    ['revoke', (): Promise<unknown> => revokePipelinePublicShare('remote-a')],
    [
      'package',
      (): Promise<unknown> => getPipelinePackage('remote-a', 'digest'),
    ],
    [
      'blob',
      (): Promise<unknown> =>
        getPipelinePackageBlob('remote-a', 'digest', 'hash'),
    ],
  ])(
    'fences %s after authorization completes',
    async (_name, invoke): Promise<void> => {
      mockResourceLanesEnabled = true;
      fetchMock.mockResolvedValue(
        Response.json({
          id: 'remote-a',
          owner: { type: 'user', id: 'user', name: null },
        }),
      );
      const originalFence = pipelineLanes.assertPipelineContextSnapshot;
      const fence = jest
        .spyOn(pipelineLanes, 'assertPipelineContextSnapshot')
        .mockImplementation(async (snapshot): Promise<void> => {
          await originalFence(snapshot);
          mockResourceRevision += 1;
        });
      try {
        await expect(invoke()).rejects.toThrow(
          'Workflow unavailable (context-mismatch)',
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        fence.mockRestore();
      }
    },
  );

  describe.each(['package', 'blob'])('%s response fence', (kind): void => {
    it.each(['context', 'revision', 'account', 'unchanged', 'flag-off'])(
      'handles %s while the download is in flight',
      async (change): Promise<void> => {
        mockResourceLanesEnabled = change !== 'flag-off';
        if (mockResourceLanesEnabled) {
          fetchMock.mockResolvedValueOnce(
            Response.json({
              id: 'remote-a',
              owner: { type: 'organization', id: 'org-a', name: 'A' },
            }),
          );
        }
        fetchMock.mockImplementationOnce((): Promise<Response> => {
          if (change === 'context' || change === 'flag-off')
            mockResourceContext.organizationId = 'org-b';
          if (change === 'revision') mockResourceRevision += 1;
          if (change === 'account') mockAccountEpoch += 1;
          return Promise.resolve(
            kind === 'package'
              ? Response.json({ digest: 'digest' })
              : new Response(new Uint8Array([1, 2, 3])),
          );
        });
        const result =
          kind === 'package'
            ? getPipelinePackage('remote-a', 'digest')
            : getPipelinePackageBlob('remote-a', 'digest', 'hash');
        if (change === 'unchanged' || change === 'flag-off') {
          await expect(result).resolves.toEqual(
            kind === 'package'
              ? { digest: 'digest' }
              : new Uint8Array([1, 2, 3]),
          );
        } else {
          await expect(result).rejects.toThrow('context-mismatch');
        }
        expect(fetchMock).toHaveBeenCalledTimes(change === 'flag-off' ? 1 : 2);
      },
    );
  });

  it('denies sharing into a different organization before issuing a write', async () => {
    mockResourceLanesEnabled = true;
    await expect(
      createSharedPipeline({
        rawPipeline: 'name: Release',
        shareScope: 'organization',
        organizationId: 'org-b',
      }),
    ).rejects.toThrow('context-mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      'skill',
      (): Promise<unknown> =>
        updateSharedSkill({
          sourceSkillId: 'custom:app/source',
          skillId: 'remote-a',
          rawSkill: 'forged',
          shareScope: 'private',
        }),
    ],
    [
      'collection',
      (): Promise<unknown> =>
        updateSharedCollection({
          collectionId: 'remote-a',
          rawCollection: '{}',
          shareScope: 'private',
        }),
    ],
    [
      'pipeline',
      (): Promise<unknown> =>
        updateSharedPipeline('remote-a', 'name: changed', {
          shareScope: 'private',
        }),
    ],
  ])(
    'refuses moving an organization-owned %s share into personal scope',
    async (_family, update): Promise<void> => {
      mockResourceLanesEnabled = true;
      fetchMock.mockResolvedValue(
        Response.json({
          id: 'remote-a',
          owner: { type: 'organization', id: 'org-a', name: 'A' },
        }),
      );

      await expect(update()).rejects.toThrow('context-mismatch');
      expect(
        fetchMock.mock.calls.some(([, init]) => init.method === 'PUT'),
      ).toBe(false);
    },
  );

  it('advertises package capability when loading shared pipeline detail', async () => {
    await getSharedPipeline('pipeline/one');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://canopy.example.test/api/v1/desktop-app/pipelines/pipeline%2Fone',
    );
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
      'X-Pipeline-Package-Version': CLIENT_VERSION,
    });
  });

  it('reads a shared pipeline for a bound execution without consulting selection', async () => {
    mockResourceLanesEnabled = true;
    const snapshot = jest.spyOn(pipelineLanes, 'pipelineContextSnapshot');
    const assert = jest.spyOn(pipelineLanes, 'assertPipelineContext');
    fetchMock.mockResolvedValue(
      Response.json({
        id: 'remote-1',
        owner: { type: 'organization', id: 'org-a' },
      }),
    );
    await expect(
      getSharedPipelineForExecutionContext('remote-1'),
    ).resolves.toMatchObject({ id: 'remote-1' });
    expect(snapshot).not.toHaveBeenCalled();
    expect(assert).not.toHaveBeenCalled();
    fetchMock.mockImplementationOnce(() => {
      mockAccountId = 'another-account';
      return Promise.resolve(Response.json({ id: 'remote-1' }));
    });
    await expect(
      getSharedPipelineForExecutionContext('remote-1'),
    ).rejects.toThrow('access-removed');
    snapshot.mockRestore();
    assert.mockRestore();
  });

  // A server that predates this client's version reports its own maximum,
  // which is not necessarily 1. Retrying only on `=== 1` means a 2->3 bump
  // hard-fails every existing package download until web deploys.
  // A server older than this client reports its OWN maximum, not necessarily
  // 1. Retrying only on `=== 1` makes a 2->3 client bump hard-fail every
  // existing package download until web deploys.
  it('retries at whatever older version the server reports', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            error: 'Update the desktop app to install this pipeline package.',
            code: 'pipeline_package_client_upgrade_required',
            requiredPackageVersion: 2,
          },
          { status: 426 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ id: 'pipeline-one' }));

    await expect(getSharedPipeline('pipeline-one')).resolves.toEqual({
      id: 'pipeline-one',
    });
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        new Headers(init.headers).get('X-Pipeline-Package-Version'),
      ),
    ).toEqual([CLIENT_VERSION, '2']);
  });

  it('negotiates an older package version for a policy-checked skill', async () => {
    mockResourceLanesEnabled = true;
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            error: 'Update the desktop app to install this pipeline package.',
            code: 'pipeline_package_client_upgrade_required',
            requiredPackageVersion: 2,
          },
          { status: 426 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: 'skill-one',
          owner: { type: 'organization', id: 'org-a', name: 'A' },
          distributionMode: 'package',
          package: { digest: 'pp:v1:abc' },
        }),
      );

    await expect(getSharedSkill('skill-one')).resolves.toMatchObject({
      id: 'skill-one',
      distributionMode: 'package',
      package: { digest: 'pp:v1:abc' },
    });
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        new Headers(init.headers).get('X-Pipeline-Package-Version'),
      ),
    ).toEqual([CLIENT_VERSION, '2']);
  });

  it('retries package reads with version 1 when an older server requires it', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            error: 'Update the desktop app to install this pipeline package.',
            code: 'pipeline_package_client_upgrade_required',
            requiredPackageVersion: 1,
          },
          { status: 426 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ id: 'pipeline-one' }));

    await expect(getSharedPipeline('pipeline-one')).resolves.toEqual({
      id: 'pipeline-one',
    });
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        new Headers(init.headers).get('X-Pipeline-Package-Version'),
      ),
    ).toEqual([CLIENT_VERSION, '1']);
  });

  it('does not downgrade package uploads that contain publisher notes', async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: 'Update the desktop app to install this pipeline package.',
          code: 'pipeline_package_client_upgrade_required',
          requiredPackageVersion: 1,
        },
        { status: 426 },
      ),
    );

    await expect(
      preparePipelinePackageUpload({
        manifest: {
          version: 1,
          pipelineContentHash: 'a'.repeat(64),
          resources: [],
          bindings: [],
          environmentRequirements: [],
          publisherNotes: [],
          totalFiles: 0,
          totalBytes: 0,
        },
        expectedDigest: `pp:v1:${'a'.repeat(43)}`,
      }),
    ).rejects.toMatchObject({ status: 426 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1].headers).get(
        'X-Pipeline-Package-Version',
      ),
    ).toBe(CLIENT_VERSION);
  });

  it('retries baseline package uploads with version 1', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            error: 'Update the desktop app to install this pipeline package.',
            code: 'pipeline_package_client_upgrade_required',
            requiredPackageVersion: 1,
          },
          { status: 426 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          uploadId: 'upload-one',
          expiresAt: '2026-09-18T12:00:00.000Z',
          missingBlobs: [],
        }),
      );

    await expect(
      preparePipelinePackageUpload({
        manifest: {
          version: 1,
          pipelineContentHash: 'a'.repeat(64),
          resources: [],
          bindings: [],
          environmentRequirements: [],
          totalFiles: 0,
          totalBytes: 0,
        },
        expectedDigest: `pp:v1:${'a'.repeat(43)}`,
      }),
    ).resolves.toMatchObject({ uploadId: 'upload-one' });
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        new Headers(init.headers).get('X-Pipeline-Package-Version'),
      ),
    ).toEqual([CLIENT_VERSION, '1']);
  });

  it('publishes and revokes a public pipeline share', async () => {
    const publicShare = { sharePath: '/share/pipelines/public-1' };
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ publicShare }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await publishPipelinePublicShare('pipeline/one');
    await revokePipelinePublicShare('pipeline/one');
    const shareUrl =
      'https://canopy.example.test/api/v1/desktop-app/pipelines/pipeline%2Fone/public-share';
    expect(
      fetchMock.mock.calls.map(([url, init]) => [url, init.method]),
    ).toEqual([
      [shareUrl, 'POST'],
      [shareUrl, 'DELETE'],
    ]);
  });

  it('refreshes stale optional Cloud capabilities before sharing a plan', async () => {
    mockedGetCanopyCloudCredentials.mockResolvedValue({
      baseUrl: 'https://canopy.example.test',
      apiKey: 'secret-key',
      capabilities: ['account-v1'],
      memorySearchOrganizationExternalIds: [],
    });
    const capabilities = ['account-v1', 'plans-crud-v1'];
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ capabilities }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'shared-plan-1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
      );

    await createSharedPlan({
      clientLocalPlanId: 'plan-1',
      workspaceLocalId: 'workspace-1',
      worktreeLocalId: 'worktree-1',
      title: 'Plan',
      content: '# Plan',
      source: 'claude',
      reviewStatus: 'pending',
      localRevisionNumber: 1,
      localCreatedAt: '2026-06-11T12:00:00.000Z',
      localUpdatedAt: '2026-06-11T12:00:00.000Z',
      repositories: [],
      snapshotHash: 'snapshot-hash',
    });

    const wellKnownCall = fetchMock.mock.calls[0];
    expect(wellKnownCall?.[0]).toBe(
      'https://canopy.example.test/.well-known/canopy',
    );
    expect(wellKnownCall?.[1].headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer secret-key',
    });
    expect(mockedMergeCanopyCloudAccountCapabilities).toHaveBeenCalledWith(
      capabilities,
      'secret-key',
    );
    const createPlanCall = fetchMock.mock.calls[1];
    expect(createPlanCall?.[0]).toBe(
      'https://canopy.example.test/api/v1/desktop-app/plans',
    );
    expect(createPlanCall?.[1].method).toBe('POST');
  });

  it('checks live capabilities with captured credentials without updating another account', async () => {
    const credentials = {
      baseUrl: 'https://initiating-account.example.test',
      apiKey: 'initiating-account-key',
      capabilities: ['account-v1'],
    };
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ capabilities: ['account-v1', 'session-exports-v1'] }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    await expect(
      assertCanopyCloudCapability('session-exports-v1', credentials),
    ).resolves.toBeUndefined();

    expect(mockedGetCanopyCloudCredentials).not.toHaveBeenCalled();
    const capabilityCall = fetchMock.mock.calls[0];
    expect(capabilityCall?.[0]).toBe(
      'https://initiating-account.example.test/.well-known/canopy',
    );
    expect(capabilityCall?.[1].headers).toMatchObject({
      Authorization: 'Bearer initiating-account-key',
    });
    expect(mockedMergeCanopyCloudAccountCapabilities).not.toHaveBeenCalled();
  });

  describe('unshareSharedRunByClientLocalId', () => {
    const runsCredentials = {
      baseUrl: 'https://canopy.example.test',
      apiKey: 'secret-key',
      capabilities: ['runs-crud-v1'],
      memorySearchOrganizationExternalIds: [],
    };

    it('DELETEs the run and returns the server unshare result', async () => {
      mockedGetCanopyCloudCredentials.mockResolvedValue(runsCredentials);
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ unshared: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(
        unshareSharedRunByClientLocalId('run-key-1'),
      ).resolves.toEqual({ unshared: true });

      const call = fetchMock.mock.calls[0];
      expect(call?.[0]).toBe(
        'https://canopy.example.test/api/v1/desktop-app/runs/run-key-1',
      );
      expect(call?.[1].method).toBe('DELETE');
    });

    it('treats a Cloud 404 as an idempotent already-unshared success', async () => {
      mockedGetCanopyCloudCredentials.mockResolvedValue(runsCredentials);
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Run not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );

      // The run row can already be gone (unshared elsewhere, admin-deleted, or a
      // double-click race). The uniform 404 must resolve, not throw, so local
      // "Shared" state can converge.
      await expect(
        unshareSharedRunByClientLocalId('run-key-2'),
      ).resolves.toEqual({ unshared: false });
    });

    it('rethrows non-404 Cloud errors', async () => {
      mockedGetCanopyCloudCredentials.mockResolvedValue(runsCredentials);
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: 'Server error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(
        unshareSharedRunByClientLocalId('run-key-3'),
      ).rejects.toMatchObject({ code: 'http-error', status: 500 });
    });
  });

  it('maps shared Collection update requests to the REST endpoint', async () => {
    await updateSharedCollection({
      collectionId: 'collection/one',
      rawCollection: '{"version":1,"name":"Review","items":[]}',
      customSkills: [{ clientKey: 'draft-1', name: 'helper', rawSkill: '#' }],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://canopy.example.test/api/v1/desktop-app/collections/collection%2Fone',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          rawCollection: '{"version":1,"name":"Review","items":[]}',
          customSkills: [
            { clientKey: 'draft-1', name: 'helper', rawSkill: '#' },
          ],
        }),
      }),
    );
  });
});
