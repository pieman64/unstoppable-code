jest.mock('../canopy-cloud/client', () => {
  const actual = jest.requireActual<object>('../canopy-cloud/client');
  return {
    ...actual,
    assertCanopyCloudCapability: jest.fn(),
    openCanopyCloudStream: jest.fn(),
    requestCanopyCloudJson: jest.fn(),
    requestCanopyCloudNoContent: jest.fn(),
    resolveCanopyCloudCredentialContext: jest.fn(),
  };
});

import {
  CanopyCloudClientError,
  assertCanopyCloudCapability,
  requestCanopyCloudJson,
  requestCanopyCloudNoContent,
  resolveCanopyCloudCredentialContext,
} from '../canopy-cloud/client';
import {
  createSharedContainerGrant,
  dismissSharedContainer,
  fetchLatestSharedContainerRevision,
  fetchSharedContainerRevision,
  listSharedContainerRecipients,
  listSharedContainersByMe,
  listSharedContainersWithMe,
  requestSharedContainerArtifactDownloadUrls,
  revokeSharedContainerGrant,
  searchSharedContainerMembers,
  stageSharedContainerRevision,
  commitSharedContainerRevision,
  uploadSharedContainerArtifact,
  supportsSharedContainers,
  getSharedContainerLink,
  createSharedContainerLink,
  setSharedContainerLink,
  resetSharedContainerLink,
  resolveSharedContainerLink,
  claimSharedContainerLink,
} from '../shared-containers/canopy-server-client';

const mockedAssert = jest.mocked(assertCanopyCloudCapability);
const mockedJson = jest.mocked(requestCanopyCloudJson);
const mockedNoContent = jest.mocked(requestCanopyCloudNoContent);
const mockedResolveCredentials = jest.mocked(
  resolveCanopyCloudCredentialContext,
);

const credentialContext = {
  baseUrl: 'https://cloud.example.test',
  apiKey: 'account-a-key',
  capabilities: ['shared-containers-v1'],
};

describe('shared containers Canopy Server client', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAssert.mockResolvedValue(undefined);
    mockedResolveCredentials.mockResolvedValue(credentialContext);
  });

  it('uses the owner and recipient capability-link routes', async () => {
    mockedJson.mockResolvedValue({});
    mockedNoContent.mockResolvedValue(undefined);

    await getSharedContainerLink('container/1');
    await createSharedContainerLink({
      worktreeId: 'worktree-1',
      organizationId: 'org-1',
      audience: 'ANYONE',
    });
    await setSharedContainerLink('container/1', 'ANYONE');
    await setSharedContainerLink('container/1', null);
    await resetSharedContainerLink('container/1');
    await resolveSharedContainerLink('A'.repeat(43));
    await claimSharedContainerLink('A'.repeat(43));

    expect(mockedJson.mock.calls.map(([path]) => path)).toEqual([
      '/api/v1/shared-containers/container%2F1/link',
      '/api/v1/shared-containers/link',
      '/api/v1/shared-containers/container%2F1/link',
      '/api/v1/shared-containers/container%2F1/link/reset',
      `/api/v1/shared-container-links/${'A'.repeat(43)}`,
      `/api/v1/shared-container-links/${'A'.repeat(43)}/claim`,
    ]);
    expect(mockedJson.mock.calls[1]?.[1]).toEqual({
      method: 'PUT',
      body: JSON.stringify({
        worktreeId: 'worktree-1',
        organizationId: 'org-1',
        audience: 'ANYONE',
      }),
    });
    expect(mockedJson.mock.calls[2]?.[1]).toEqual({
      method: 'PUT',
      body: JSON.stringify({ audience: 'ANYONE' }),
    });
    expect(mockedNoContent).toHaveBeenCalledWith(
      '/api/v1/shared-containers/container%2F1/link',
      { method: 'DELETE' },
    );
    expect(mockedAssert).toHaveBeenCalledTimes(7);
  });

  it('omits worktreeId for an org-wide owner listing', async () => {
    // The route treats `worktreeId` as optional; sending an empty value would
    // scope the listing to a worktree named '' instead of the whole org.
    mockedJson.mockResolvedValue({ containers: [], nextCursor: null });

    await listSharedContainersByMe({ organizationId: 'org-1', limit: 100 });

    expect(mockedJson).toHaveBeenCalledWith(
      '/api/v1/shared-containers/shared-by-me?organizationId=org-1&limit=100',
    );
  });

  it('asserts the optional capability before every Cloud call', async () => {
    mockedJson.mockResolvedValue({});
    mockedNoContent.mockResolvedValue(undefined);

    await createSharedContainerGrant({
      organizationId: 'org-1',
      worktreeId: 'server-worktree-1',
      recipient: { kind: 'member', userId: 'user-1' },
      capabilities: ['VIEW'],
    });
    await listSharedContainersByMe({
      organizationId: 'org-1',
      worktreeId: 'server-worktree-1',
    });
    await searchSharedContainerMembers({
      organizationId: 'org-1',
      teamId: 'team-1',
      query: 'Ada Lovelace',
      limit: 10,
    });
    await listSharedContainerRecipients({
      containerId: 'container-1',
      organizationId: 'org-1',
      cursor: 'next',
      limit: 20,
    });
    await revokeSharedContainerGrant('container-1', 'grant-1', 'org-1');

    expect(mockedAssert).toHaveBeenCalledTimes(5);
    expect(mockedAssert).toHaveBeenCalledWith('shared-containers-v1');
    // Unbranded `api/v1` root: CAN-2544 mounted these routes at
    // `apps/web/src/app/api/v1/shared-containers/**`, not under the legacy
    // `api/v1/[brandNamespace]/**` segment.
    const prefix = '/api/v1/shared-containers';
    expect(mockedJson.mock.calls.map(([path]) => path)).toEqual([
      prefix,
      `${prefix}/shared-by-me?organizationId=org-1&worktreeId=server-worktree-1`,
      `${prefix}/members?organizationId=org-1&teamId=team-1&q=Ada+Lovelace&limit=10`,
      `${prefix}/container-1/recipients?organizationId=org-1&cursor=next&limit=20`,
    ]);
    expect(mockedNoContent).toHaveBeenNthCalledWith(
      1,
      `${prefix}/container-1/grants/grant-1?organizationId=org-1`,
      { method: 'DELETE' },
    );
    const organizationBody = mockedJson.mock.calls[0]?.[1]?.body;
    expect(typeof organizationBody).toBe('string');
    if (typeof organizationBody !== 'string') {
      throw new Error('Expected a serialized shared-container request');
    }
    expect(JSON.parse(organizationBody)).toEqual({
      organizationId: 'org-1',
      worktreeId: 'server-worktree-1',
      recipient: { kind: 'member', userId: 'user-1' },
      capabilities: ['VIEW'],
    });
  });

  it('omits the organization hint for personal containers and direct shares', async () => {
    mockedJson.mockResolvedValue({ containers: [], nextCursor: null });
    mockedNoContent.mockResolvedValue(undefined);

    await createSharedContainerGrant({
      worktreeId: 'server-worktree-1',
      recipient: { kind: 'email', email: 'ada@example.com' },
      capabilities: ['VIEW'],
    });
    await listSharedContainersWithMe({});
    await listSharedContainersByMe({ limit: 100 });
    await listSharedContainerRecipients({ containerId: 'container-1' });
    await revokeSharedContainerGrant('container-1', 'grant-1', undefined);
    await dismissSharedContainer('container-1', undefined);
    await fetchLatestSharedContainerRevision('container-1', undefined);
    await fetchSharedContainerRevision('container-1', 'revision-1', undefined);
    await requestSharedContainerArtifactDownloadUrls(
      'container-1',
      'revision-1',
      undefined,
      ['artifact-1'],
    );
    await commitSharedContainerRevision('container-1', undefined, 'stage-1');

    const prefix = '/api/v1/shared-containers';
    expect(mockedJson.mock.calls.map(([path]) => path)).toEqual([
      prefix,
      `${prefix}/shared-with-me`,
      `${prefix}/shared-by-me?limit=100`,
      `${prefix}/container-1/recipients`,
      `${prefix}/container-1/revisions/latest`,
      `${prefix}/container-1/revisions/revision-1`,
      `${prefix}/container-1/revisions/revision-1/artifacts/download-urls`,
      `${prefix}/container-1/revisions/commit`,
    ]);
    const personalBody = mockedJson.mock.calls[0]?.[1]?.body;
    expect(typeof personalBody).toBe('string');
    if (typeof personalBody !== 'string') {
      throw new Error('Expected a serialized shared-container request');
    }
    expect(JSON.parse(personalBody)).toEqual({
      worktreeId: 'server-worktree-1',
      recipient: { kind: 'email', email: 'ada@example.com' },
      capabilities: ['VIEW'],
    });
    expect(mockedNoContent.mock.calls.map(([path]) => path)).toEqual([
      `${prefix}/container-1/grants/grant-1`,
      `${prefix}/container-1/dismiss`,
    ]);
  });

  it('returns false only for a conclusively unsupported capability', async () => {
    mockedAssert.mockRejectedValueOnce(
      new CanopyCloudClientError(
        'unsupported-capability',
        'shared containers are unsupported',
      ),
    );
    await expect(supportsSharedContainers()).resolves.toBe(false);

    const offline = new CanopyCloudClientError('network-error', 'offline');
    mockedAssert.mockRejectedValueOnce(offline);
    await expect(supportsSharedContainers()).rejects.toBe(offline);

    mockedAssert.mockResolvedValueOnce(undefined);
    await expect(supportsSharedContainers()).resolves.toBe(true);
  });

  it('calls every recipient route through the capability-gated unbranded API', async () => {
    mockedJson.mockResolvedValue({});
    mockedNoContent.mockResolvedValue(undefined);

    await listSharedContainersWithMe({
      organizationId: 'org-1',
      cursor: 'next',
      limit: 10,
    });
    await dismissSharedContainer('container/1', 'org-1');
    await fetchLatestSharedContainerRevision('container/1', 'org-1');
    await fetchSharedContainerRevision('container/1', 'revision/1', 'org-1');
    await requestSharedContainerArtifactDownloadUrls(
      'container/1',
      'revision/1',
      'org-1',
      ['artifact-1'],
    );

    const prefix = '/api/v1/shared-containers';
    expect(mockedJson.mock.calls.map(([path]) => path)).toEqual([
      `${prefix}/shared-with-me?organizationId=org-1&cursor=next&limit=10`,
      `${prefix}/container%2F1/revisions/latest?organizationId=org-1`,
      `${prefix}/container%2F1/revisions/revision%2F1?organizationId=org-1`,
      `${prefix}/container%2F1/revisions/revision%2F1/artifacts/download-urls?organizationId=org-1`,
    ]);
    expect(mockedNoContent).toHaveBeenCalledWith(
      `${prefix}/container%2F1/dismiss?organizationId=org-1`,
      { method: 'DELETE', credentialContext },
    );
    expect(mockedJson).toHaveBeenLastCalledWith(
      `${prefix}/container%2F1/revisions/revision%2F1/artifacts/download-urls?organizationId=org-1`,
      { method: 'POST', body: JSON.stringify({ artifactIds: ['artifact-1'] }) },
    );
    expect(mockedAssert).toHaveBeenCalledTimes(5);
    expect(mockedAssert).toHaveBeenNthCalledWith(
      2,
      'shared-containers-v1',
      credentialContext,
      undefined,
    );
  });

  it('threads replica cancellation through capability discovery and JSON body reads', async () => {
    mockedJson.mockResolvedValue({});
    const signal = new AbortController().signal;

    await fetchLatestSharedContainerRevision('container-1', 'org-1', signal);
    await fetchSharedContainerRevision(
      'container-1',
      'revision-1',
      'org-1',
      signal,
    );
    await requestSharedContainerArtifactDownloadUrls(
      'container-1',
      'revision-1',
      'org-1',
      ['artifact-1'],
      signal,
    );

    expect(mockedAssert).toHaveBeenCalledTimes(3);
    for (const call of mockedAssert.mock.calls) {
      expect(call).toEqual(['shared-containers-v1', undefined, signal]);
    }
    for (const call of mockedJson.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ signal }));
    }
  });

  it('stages, uploads, and commits publisher artifacts through the exact route contracts', async () => {
    mockedJson.mockResolvedValue({});
    const request = {
      organizationId: 'org-1',
      idempotencyKey: 'key-1',
      sourceDeviceId: 'device-1',
      schemaVersion: 1,
      artifacts: [],
    };
    await stageSharedContainerRevision('container/1', request);
    await commitSharedContainerRevision('container/1', 'org-1', 'stage-1');
    expect(mockedJson).toHaveBeenNthCalledWith(
      1,
      '/api/v1/shared-containers/container%2F1/revisions/stage',
      { method: 'POST', body: JSON.stringify(request), signal: undefined },
    );
    expect(mockedJson).toHaveBeenNthCalledWith(
      2,
      '/api/v1/shared-containers/container%2F1/revisions/commit?organizationId=org-1',
      {
        method: 'POST',
        body: JSON.stringify({ stagingSessionId: 'stage-1' }),
        signal: undefined,
      },
    );

    const originalFetch = global.fetch;
    const fetchMock = jest.fn(() =>
      Promise.resolve(new Response(null, { status: 200 })),
    );
    global.fetch = fetchMock as typeof fetch;
    // Every header the stage response returns takes part in the V4 signature,
    // so the PUT has to replay exactly this two-header contract.
    const signedHeaders = {
      'Content-Length': '52',
      'x-goog-meta-plaintext-sha256': 'sha256:abc',
    };
    const uploadTarget = (
      headers: Record<string, string>,
    ): Parameters<typeof uploadSharedContainerArtifact>[0]['target'] => ({
      artifactId: 'artifact-1',
      target: {
        url: 'https://storage.example.test/upload',
        method: 'PUT',
        headers,
        expiresAt: 'later',
      },
      key: { scheme: 'AES_256_GCM_CHUNKED_V1', dataKey: 'key', aad: 'aad' },
    });
    try {
      await uploadSharedContainerArtifact({
        target: uploadTarget(signedHeaders),
        body: Buffer.from('abc'),
        plaintextSizeBytes: 3,
        plaintextHash: 'sha256:abc',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://storage.example.test/upload',
        expect.objectContaining({ method: 'PUT', headers: signedHeaders }),
      );

      // A target whose signed length or digest disagrees with what this
      // publisher staged is refused locally rather than uploaded.
      await expect(
        uploadSharedContainerArtifact({
          target: uploadTarget({ ...signedHeaders, 'Content-Length': '51' }),
          body: Buffer.from('abc'),
          plaintextSizeBytes: 3,
          plaintextHash: 'sha256:abc',
        }),
      ).rejects.toThrow('Signed upload target disagrees');
      await expect(
        uploadSharedContainerArtifact({
          target: uploadTarget({
            ...signedHeaders,
            'x-goog-meta-plaintext-sha256': 'sha256:other',
          }),
          body: Buffer.from('abc'),
          plaintextSizeBytes: 3,
          plaintextHash: 'sha256:abc',
        }),
      ).rejects.toThrow('Signed upload target disagrees');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('classifies signed-upload network and retryable HTTP failures for the scheduler', async () => {
    const originalFetch = global.fetch;
    const target = {
      artifactId: 'artifact-1',
      target: {
        url: 'https://storage.example.test/upload',
        method: 'PUT' as const,
        headers: {
          'Content-Length': '52',
          'x-goog-meta-plaintext-sha256': 'sha256:abc',
        },
        expiresAt: 'later',
      },
      key: {
        scheme: 'AES_256_GCM_CHUNKED_V1' as const,
        dataKey: 'key',
        aad: 'aad',
      },
    };
    try {
      global.fetch = jest
        .fn()
        .mockRejectedValueOnce(new TypeError('offline')) as typeof fetch;
      await expect(
        uploadSharedContainerArtifact({
          target,
          body: Buffer.from('abc'),
          plaintextSizeBytes: 3,
          plaintextHash: 'sha256:abc',
        }),
      ).rejects.toMatchObject({ code: 'network-error' });

      global.fetch = jest.fn(() =>
        Promise.resolve(
          new Response(null, {
            status: 503,
            headers: { 'Retry-After': '7' },
          }),
        ),
      ) as typeof fetch;
      await expect(
        uploadSharedContainerArtifact({
          target,
          body: Buffer.from('abc'),
          plaintextSizeBytes: 3,
          plaintextHash: 'sha256:abc',
        }),
      ).rejects.toMatchObject({
        code: 'http-error',
        status: 503,
        retryAfterMs: 7_000,
      });

      global.fetch = jest.fn(() =>
        Promise.resolve(new Response(null, { status: 403 })),
      ) as typeof fetch;
      await expect(
        uploadSharedContainerArtifact({
          target,
          body: Buffer.from('abc'),
          plaintextSizeBytes: 3,
          plaintextHash: 'sha256:abc',
        }),
      ).rejects.toMatchObject({
        code: 'http-error',
        status: 403,
        isValidatedServerError: false,
      });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
