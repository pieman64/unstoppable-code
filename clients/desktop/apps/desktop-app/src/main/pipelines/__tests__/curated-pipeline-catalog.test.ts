import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import type { CuratedPipelineDetail } from '@canopy/protocol/pipeline-catalog';
import {
  computePipelinePackageDigest,
  type PipelinePackageManifestV1,
} from '@canopy/protocol/pipelines';
import { hashPipelinePackageYaml } from '@canopy/desktop-shared/node';

let mockCachePath = '';
let mockDirectory = '';
let mockCredentials = {
  baseUrl: 'https://cloud.example.test',
  apiKey: 'account-one-key',
};
const mockRequest = jest.fn<Promise<unknown>, unknown[]>();
const mockSave = jest.fn<unknown, unknown[]>();
const mockDelete = jest.fn<unknown, unknown[]>();
const mockUpsertPackageInstall = jest.fn<Promise<void>, unknown[]>();
jest.mock('../../lib/paths', () => ({
  getCuratedPipelinesCatalogFilePath: (): string => mockCachePath,
  getPipelinePackagesDir: (): string =>
    join(mockDirectory, 'pipeline-packages'),
  getPipelinePackageInstallStorePath: (): string =>
    join(mockDirectory, 'pipeline-package-installs.json'),
}));
jest.mock('../../canopy-cloud/client', () => ({
  requestCanopyCloudJson: (...args: unknown[]): Promise<unknown> =>
    mockRequest(...args),
  requestCanopyCloudBinary: (...args: unknown[]): Promise<ArrayBuffer> =>
    mockRequest(...args) as Promise<ArrayBuffer>,
  resolveCanopyCloudCredentialContext: (): Promise<typeof mockCredentials> =>
    Promise.resolve({ ...mockCredentials }),
}));
jest.mock('../pipeline-service', () => ({
  savePipeline: (...args: unknown[]): unknown => mockSave(...args),
  deletePipeline: (...args: unknown[]): unknown => mockDelete(...args),
}));
jest.mock('../pipeline-package-install-store', () => ({
  upsertPipelinePackageInstall: (...args: unknown[]): Promise<void> =>
    mockUpsertPackageInstall(...args),
}));
const mockRecordOwner = jest.fn<void, [string, string]>();
jest.mock('../pipeline-local-metadata-store', () => ({
  recordUserPipelineOwner: (pipelineId: string, owner: string): void =>
    mockRecordOwner(pipelineId, owner),
}));
const mockSelectedOwner = jest.fn<Promise<string>, []>(() =>
  Promise.resolve('personal'),
);
jest.mock('../pipeline-owner-policy', () => ({
  selectedOwnerContext: (): Promise<string> => mockSelectedOwner(),
}));
import {
  getCuratedPipeline,
  importCuratedPipeline,
  listCuratedPipelines,
  listManagedCuratedPipelines,
  getManagedCuratedPipeline,
  syncManagedCuratedPipelines,
  startManagedCuratedPipelineSync,
  stopManagedCuratedPipelineSync,
} from '../curated-pipeline-catalog';

function fixture(
  rawPipeline = 'name: Reviewed workflow\non: dispatch\nscope: [directory]\njobs:\n  check:\n    steps:\n      - run: echo reviewed\n',
): CuratedPipelineDetail {
  return {
    key: 'reviewed-workflow',
    name: 'Reviewed workflow',
    shortDescription: 'A reviewed workflow',
    icon: '',
    version: '1.0',
    triggerTypes: ['dispatch'],
    scopes: ['directory'],
    jobCount: 1,
    stepCount: 1,
    contentHash: createHash('sha256').update(rawPipeline).digest('hex'),
    contentSizeBytes: Buffer.byteLength(rawPipeline),
    categories: ['development'],
    popular: true,
    sortOrder: 1,
    revision: 2,
    authorName: null,
    authorUrl: null,
    docsUrl: null,
    createdAt: '2026-09-10T00:00:00.000Z',
    updatedAt: '2026-09-10T00:00:00.000Z',
    rawPipeline,
  };
}

let directory: string;
beforeEach(async () => {
  jest.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), 'curated-pipeline-test-'));
  mockDirectory = directory;
  mockCachePath = join(directory, 'catalog.json');
  mockCredentials = {
    baseUrl: 'https://cloud.example.test',
    apiKey: 'account-one-key',
  };
  mockSave.mockReturnValue({
    success: true,
    data: { id: 'local-copy', source: 'user', readonly: false },
  });
});
afterEach(async () => {
  stopManagedCuratedPipelineSync();
  jest.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('lists bounded metadata without carrying unexpected YAML or jobs through IPC/cache', async () => {
  mockRequest.mockResolvedValue({
    version: 1,
    data: [{ ...fixture(), jobs: { giant: 'x'.repeat(100000) } }],
    nextCursor: 'next',
  });
  const result = await listCuratedPipelines({ q: 'review', limit: 25 });
  expect(result.data).toHaveLength(1);
  expect(result.data[0]).not.toHaveProperty('rawPipeline');
  expect(result.data[0]).not.toHaveProperty('jobs');
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest).toHaveBeenCalledWith(
    expect.stringMatching(/pipelines\/curated\?limit=25&q=review$/),
    { credentialContext: mockCredentials },
  );
  const cached = await readFile(mockCachePath, 'utf8');
  expect(cached).not.toContain('rawPipeline');
  expect(cached).not.toContain(mockCredentials.apiKey);
  await listCuratedPipelines({ q: 'review', limit: 25 });
  expect(mockRequest).toHaveBeenCalledTimes(1);
});

it('uses only matching query cache offline and marks stale', async () => {
  mockRequest.mockResolvedValueOnce({
    version: 1,
    data: [fixture()],
    nextCursor: null,
  });
  await listCuratedPipelines({ q: 'review' });
  mockRequest.mockRejectedValue(new Error('offline'));
  expect(
    await listCuratedPipelines({ q: 'review', forceRefresh: true }),
  ).toMatchObject({ stale: true, data: [{ key: 'reviewed-workflow' }] });
  await expect(listCuratedPipelines({ q: 'another' })).rejects.toThrow(
    'offline',
  );
});

it('does not expose a previous account cache after switching or signing out', async () => {
  mockRequest.mockResolvedValueOnce({
    version: 1,
    data: [fixture()],
    nextCursor: null,
  });
  await listCuratedPipelines();
  mockCredentials.apiKey = 'account-two-key';
  mockRequest.mockRejectedValue(new Error('offline'));
  await expect(listCuratedPipelines()).rejects.toThrow('offline');
});

it('rejects invalid queries before making requests', async () => {
  await expect(listCuratedPipelines({ limit: 1000 })).rejects.toThrow(
    'page size',
  );
  await expect(listCuratedPipelines({ q: 'x'.repeat(257) })).rejects.toThrow(
    'Invalid q',
  );
  expect(mockRequest).not.toHaveBeenCalled();
});

it('loads content only for the selected key and checks its exact bytes', async () => {
  mockRequest.mockResolvedValue(fixture());
  const detail = await getCuratedPipeline('reviewed-workflow');
  expect(detail.rawPipeline).toContain('echo reviewed');
  expect(mockRequest).toHaveBeenCalledWith(
    expect.stringMatching(/reviewed-workflow\/content$/),
    { credentialContext: mockCredentials },
  );
  mockRequest.mockResolvedValue({ ...fixture(), rawPipeline: 'tampered' });
  await expect(getCuratedPipeline('reviewed-workflow')).rejects.toThrow(
    'Curated workflow content failed verification. Refresh the catalog and try again.',
  );
  expect(mockSave).not.toHaveBeenCalled();
});

it('rejects stale reviewed hashes before writing anything', async () => {
  mockRequest.mockResolvedValue(fixture());
  await expect(
    importCuratedPipeline({
      key: 'reviewed-workflow',
      expectedContentHash: 'a'.repeat(64),
    }),
  ).rejects.toThrow(
    'This curated workflow changed. Refresh its preview before adding it.',
  );
  expect(mockSave).not.toHaveBeenCalled();
});

it('validates semantics before saving even if the bytes are correctly hashed', async () => {
  const malformed = fixture('name: Invalid\njobs: {}\n');
  mockRequest.mockResolvedValue(malformed);
  await expect(
    importCuratedPipeline({
      key: malformed.key,
      expectedContentHash: malformed.contentHash,
    }),
  ).rejects.toThrow();
  expect(mockSave).not.toHaveBeenCalled();
});

it('adds a new editable copy with revision/hash provenance and never sends a local overwrite id', async () => {
  const detail = fixture();
  mockRequest.mockResolvedValue(detail);
  const request = { key: detail.key, expectedContentHash: detail.contentHash };
  await Promise.all([
    importCuratedPipeline(request),
    importCuratedPipeline(request),
  ]);
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(mockSave.mock.calls[0]?.[0]).toMatchObject({
    name: detail.name,
    curatedOrigin: {
      key: detail.key,
      contentHash: detail.contentHash,
      revision: 2,
    },
  });
  expect(mockSave.mock.calls[0][0]).not.toHaveProperty('id');
  expect(mockRecordOwner).toHaveBeenCalledWith('local-copy', 'personal');
  await importCuratedPipeline(request);
  expect(mockSave).toHaveBeenCalledTimes(2);
});

it('keeps a saved import when its owner cannot be recorded', async () => {
  const detail = fixture();
  mockRequest.mockResolvedValue(detail);
  mockSelectedOwner.mockRejectedValueOnce(new Error('context unavailable'));

  await expect(
    importCuratedPipeline({
      key: detail.key,
      expectedContentHash: detail.contentHash,
    }),
  ).resolves.toMatchObject({ id: 'local-copy' });
  expect(mockSave).toHaveBeenCalledTimes(1);
  expect(mockRecordOwner).not.toHaveBeenCalled();
});

it('adds a package-backed curated pipeline with its verified execution package', async () => {
  const detail = fixture(
    'name: Reviewed workflow\non: dispatch\nscope: [directory]\njobs:\n  check:\n    steps:\n      - uses: project/review\n',
  );
  const manifest: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: hashPipelinePackageYaml(detail.rawPipeline),
    resources: [
      {
        id: 'project-review',
        kind: 'pipeline_action',
        displayName: 'project/review',
        sourceLabel: 'project/review',
        sourceVisibility: 'local',
        invocationKeys: ['project/review'],
        dependencyResourceIds: [],
        trees: [],
      },
    ],
    bindings: [
      {
        jobId: 'check',
        stepId: '__auto_step_0',
        resourceIds: ['project-review'],
      },
    ],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  };
  const digest = await computePipelinePackageDigest(manifest);
  const packagedDetail: CuratedPipelineDetail = {
    ...detail,
    key: 'packaged-action-workflow',
    package: {
      version: 1,
      digest,
      resources: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
  };
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).includes('/package?') ? { digest, manifest } : packagedDetail,
    ),
  );

  await expect(
    importCuratedPipeline({
      key: packagedDetail.key,
      expectedContentHash: packagedDetail.contentHash,
    }),
  ).resolves.toMatchObject({ id: 'local-copy' });

  expect(mockSave).toHaveBeenCalledWith(
    expect.objectContaining({ rawContent: packagedDetail.rawPipeline }),
  );
  expect(mockUpsertPackageInstall).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({
      localPipelineId: 'local-copy',
      originExternalId: `curated:${packagedDetail.key}`,
      pipelineContentHash: manifest.pipelineContentHash,
      packageDigest: digest,
    }),
  );
});

it('rejects an account change while fetching detail, before any import', async () => {
  const detail = fixture();
  mockRequest.mockImplementation(() => {
    mockCredentials.apiKey = 'new-account';
    return Promise.resolve(detail);
  });
  await expect(
    importCuratedPipeline({
      key: detail.key,
      expectedContentHash: detail.contentHash,
    }),
  ).rejects.toThrow(
    `Your ${BRAND.displayName} Cloud account changed. Refresh the catalog and try again.`,
  );
  expect(mockSave).not.toHaveBeenCalled();
});

it('does not turn an explicit authorization failure into a cached success', async () => {
  mockRequest.mockResolvedValueOnce({
    version: 1,
    data: [fixture()],
    nextCursor: null,
  });
  await listCuratedPipelines();
  mockRequest.mockRejectedValue(
    Object.assign(new Error('revoked'), { status: 403 }),
  );
  await expect(listCuratedPipelines({ forceRefresh: true })).rejects.toThrow(
    'revoked',
  );
});

it('discovers an undownloaded curated pipeline as metadata-only runtime inventory', async () => {
  mockRequest.mockResolvedValue({
    version: 1,
    data: [fixture()],
    nextCursor: null,
  });
  expect(await listManagedCuratedPipelines()).toEqual([
    expect.objectContaining({
      id: 'curated:reviewed-workflow',
      source: 'curated',
      readonly: true,
      triggerTypes: ['dispatch'],
      scopes: ['directory'],
    }),
  ]);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  expect(mockRequest.mock.calls[0][0]).not.toContain('/content');
});

it('materializes immutable verified revisions on demand and keeps the running revision intact', async () => {
  const old = fixture();
  let current = old;
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? current
        : { version: 1, data: [current], nextCursor: null },
    ),
  );
  const [first, concurrent] = await Promise.all([
    getManagedCuratedPipeline('curated:reviewed-workflow'),
    getManagedCuratedPipeline('curated:reviewed-workflow'),
  ]);
  expect(first.info.filePath).toEqual(concurrent.info.filePath);
  expect(first.info.filePath).toContain(old.contentHash);
  expect(await readFile(first.info.filePath ?? '', 'utf8')).toEqual(
    old.rawPipeline,
  );
  expect(
    mockRequest.mock.calls.filter(([url]) => String(url).endsWith('/content')),
  ).toHaveLength(1);
  current = fixture(old.rawPipeline.replace('echo reviewed', 'echo updated'));
  const next = await getManagedCuratedPipeline('curated:reviewed-workflow');
  expect(next.info.filePath).not.toEqual(first.info.filePath);
  expect(await readFile(first.info.filePath ?? '', 'utf8')).toEqual(
    old.rawPipeline,
  );
  expect(await readFile(next.info.filePath ?? '', 'utf8')).toEqual(
    current.rawPipeline,
  );
  expect(mockSave).not.toHaveBeenCalled();
});

it('installs the package pinned to a managed revision and exposes it for execution', async () => {
  const detail = fixture();
  const manifest: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: hashPipelinePackageYaml(detail.rawPipeline),
    resources: [],
    bindings: [],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  };
  const digest = await computePipelinePackageDigest(manifest);
  const packagedDetail: CuratedPipelineDetail = {
    ...detail,
    key: 'packaged-workflow',
    package: {
      version: 1,
      digest,
      resources: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
  };
  mockRequest.mockImplementation((url) => {
    const value = String(url);
    if (value.includes('/package?')) {
      return Promise.resolve({ digest, manifest });
    }
    return Promise.resolve(
      value.endsWith('/content')
        ? packagedDetail
        : { version: 1, data: [packagedDetail], nextCursor: null },
    );
  });

  const managed = await getManagedCuratedPipeline('curated:packaged-workflow');

  expect(managed.pipelinePackage).toMatchObject({
    digest,
    rawPipeline: detail.rawPipeline,
    manifest,
  });
  expect(managed.pipelinePackage?.cachedPackagePath).toContain(
    digest.slice('pp:v1:'.length),
  );
});

it('accepts a project action the managed revision package binds to its step', async () => {
  // The server publishes this revision only because its package binds the
  // `project/` action to the step; the desktop must apply the same rule with
  // the same manifest instead of re-rejecting it as definition-only.
  const detail = fixture(
    'name: Reviewed workflow\non: dispatch\nscope: [directory]\njobs:\n  check:\n    steps:\n      - uses: project/review\n',
  );
  const manifest: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: hashPipelinePackageYaml(detail.rawPipeline),
    resources: [
      {
        id: 'project-review',
        kind: 'pipeline_action',
        displayName: 'project/review',
        sourceLabel: 'project/review',
        sourceVisibility: 'local',
        invocationKeys: ['project/review'],
        dependencyResourceIds: [],
        trees: [],
      },
    ],
    bindings: [
      {
        jobId: 'check',
        stepId: '__auto_step_0',
        resourceIds: ['project-review'],
      },
    ],
    environmentRequirements: [],
    totalFiles: 0,
    totalBytes: 0,
  };
  const digest = await computePipelinePackageDigest(manifest);
  const packagedDetail: CuratedPipelineDetail = {
    ...detail,
    key: 'packaged-action-workflow',
    package: {
      version: 1,
      digest,
      resources: [],
      environmentRequirements: [],
      totalFiles: 0,
      totalBytes: 0,
    },
  };
  mockRequest.mockImplementation((url) => {
    const value = String(url);
    if (value.includes('/package?')) {
      return Promise.resolve({ digest, manifest });
    }
    return Promise.resolve(
      value.endsWith('/content')
        ? packagedDetail
        : { version: 1, data: [packagedDetail], nextCursor: null },
    );
  });

  const managed = await getManagedCuratedPipeline(
    'curated:packaged-action-workflow',
  );

  expect(managed.pipelinePackage).toMatchObject({ digest, manifest });
  // A second read comes from the published revision on disk and must not
  // fall back to the network just because the definition-only check fails.
  mockRequest.mockClear();
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? packagedDetail
        : { version: 1, data: [packagedDetail], nextCursor: null },
    ),
  );
  await expect(
    getManagedCuratedPipeline('curated:packaged-action-workflow'),
  ).resolves.toMatchObject({ pipelinePackage: { digest } });
  expect(
    mockRequest.mock.calls.some(([url]) => String(url).endsWith('/content')),
  ).toBe(false);
});

it('still rejects an unpackaged project action in a managed revision', async () => {
  const detail = {
    ...fixture(
      'name: Reviewed workflow\non: dispatch\nscope: [directory]\njobs:\n  check:\n    steps:\n      - uses: project/review\n',
    ),
    key: 'unpackaged-action-workflow',
  };
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? detail
        : { version: 1, data: [detail], nextCursor: null },
    ),
  );

  await expect(
    getManagedCuratedPipeline('curated:unpackaged-action-workflow'),
  ).rejects.toMatchObject({
    issues: [expect.objectContaining({ code: 'unsupported_reference' })],
  });
});

it('does not publish invalid content or replace the last good revision', async () => {
  const valid = fixture();
  let current = valid;
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? current
        : { version: 1, data: [current], nextCursor: null },
    ),
  );
  const first = await getManagedCuratedPipeline('curated:reviewed-workflow');
  current = fixture('name: Broken\njobs: {}\n');
  await expect(
    getManagedCuratedPipeline('curated:reviewed-workflow'),
  ).rejects.toThrow();
  expect(await readFile(first.info.filePath ?? '', 'utf8')).toEqual(
    valid.rawPipeline,
  );
});

it('uses a verified cached revision offline but never a previous account revision', async () => {
  const current = fixture();
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? current
        : { version: 1, data: [current], nextCursor: null },
    ),
  );
  const first = await getManagedCuratedPipeline('curated:reviewed-workflow');
  mockRequest.mockRejectedValue(new Error('offline'));
  expect(
    (await getManagedCuratedPipeline('curated:reviewed-workflow')).info
      .filePath,
  ).toEqual(first.info.filePath);
  mockCredentials.apiKey = 'another-account';
  await expect(
    getManagedCuratedPipeline('curated:reviewed-workflow'),
  ).rejects.toThrow('offline');
});

it('automatically synchronizes downloaded keys without downloading untouched catalog entries', async () => {
  let current = fixture();
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? current
        : { version: 1, data: [current], nextCursor: null },
    ),
  );
  const old = await getManagedCuratedPipeline('curated:reviewed-workflow');
  current = fixture(current.rawPipeline.replace('echo reviewed', 'echo sync'));
  await Promise.all([
    syncManagedCuratedPipelines(),
    syncManagedCuratedPipelines(),
  ]);
  expect(
    mockRequest.mock.calls.filter(([url]) => String(url).endsWith('/content')),
  ).toHaveLength(2);
  expect(await readFile(old.info.filePath ?? '', 'utf8')).toContain(
    'echo reviewed',
  );
  const latest = await getManagedCuratedPipeline('curated:reviewed-workflow');
  expect(await readFile(latest.info.filePath ?? '', 'utf8')).toContain(
    'echo sync',
  );
  expect(
    mockRequest.mock.calls.filter(([url]) => String(url).endsWith('/content')),
  ).toHaveLength(2);
});

it('rejects authoritative retirement and access revocation instead of using a cached revision', async () => {
  const current = fixture();
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? current
        : { version: 1, data: [current], nextCursor: null },
    ),
  );
  const first = await getManagedCuratedPipeline('curated:reviewed-workflow');
  mockRequest.mockResolvedValue({ version: 1, data: [], nextCursor: null });
  await expect(
    getManagedCuratedPipeline('curated:reviewed-workflow'),
  ).rejects.toThrow(
    'This curated workflow is no longer available. Refresh the workflow list.',
  );
  expect(await readFile(first.info.filePath ?? '', 'utf8')).toEqual(
    current.rawPipeline,
  );
  mockRequest.mockRejectedValue(
    Object.assign(new Error('revoked'), { status: 403 }),
  );
  await expect(
    getManagedCuratedPipeline('curated:reviewed-workflow'),
  ).rejects.toThrow('revoked');
});

it('confirms a newer coherent detail after a metadata publication race', async () => {
  const old = fixture();
  const latest = fixture(
    old.rawPipeline.replace('echo reviewed', 'echo latest'),
  );
  mockRequest
    .mockResolvedValueOnce({ version: 1, data: [old], nextCursor: null })
    .mockResolvedValueOnce(latest)
    .mockResolvedValueOnce({ version: 1, data: [latest], nextCursor: null });
  const result = await getManagedCuratedPipeline('curated:reviewed-workflow');
  expect(result.info.curatedContentHash).toEqual(latest.contentHash);
  expect(await readFile(result.info.filePath ?? '', 'utf8')).toEqual(
    latest.rawPipeline,
  );
});

it('retains selected offline metadata independently of bounded browse page eviction', async () => {
  const current = fixture();
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? current
        : { version: 1, data: [current], nextCursor: null },
    ),
  );
  const first = await getManagedCuratedPipeline('curated:reviewed-workflow');
  for (let index = 0; index < 14; index++)
    await listCuratedPipelines({ q: `other-query-${index}` });
  mockRequest.mockRejectedValue(new Error('offline'));
  expect(
    (await getManagedCuratedPipeline('curated:reviewed-workflow')).info
      .filePath,
  ).toEqual(first.info.filePath);
  expect(await listManagedCuratedPipelines()).toEqual([
    expect.objectContaining({
      id: 'curated:reviewed-workflow',
      source: 'curated',
    }),
  ]);
});

it('never falls back to an older verified revision after a newer advertised download fails', async () => {
  let current = fixture();
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? current
        : { version: 1, data: [current], nextCursor: null },
    ),
  );
  await getManagedCuratedPipeline('curated:reviewed-workflow');
  current = fixture(
    current.rawPipeline.replace('echo reviewed', 'echo updated'),
  );
  mockRequest.mockImplementation((url) =>
    String(url).endsWith('/content')
      ? Promise.reject(new Error('download failed'))
      : Promise.resolve({ version: 1, data: [current], nextCursor: null }),
  );
  await expect(
    getManagedCuratedPipeline('curated:reviewed-workflow'),
  ).rejects.toThrow('download failed');
  for (let index = 0; index < 14; index++)
    await listCuratedPipelines({ q: `other-query-${index}` });
  mockRequest.mockRejectedValue(new Error('offline'));
  await expect(
    getManagedCuratedPipeline('curated:reviewed-workflow'),
  ).rejects.toThrow('offline');
});

it.each([401, 403, 404])(
  'keeps authoritative denial %s across later offline requests until a fresh success',
  async (status) => {
    const current = fixture();
    mockRequest.mockImplementation((url) =>
      Promise.resolve(
        String(url).endsWith('/content')
          ? current
          : { version: 1, data: [current], nextCursor: null },
      ),
    );
    await getManagedCuratedPipeline('curated:reviewed-workflow');
    mockRequest.mockRejectedValue(
      Object.assign(new Error('denied'), { status }),
    );
    await expect(
      getManagedCuratedPipeline('curated:reviewed-workflow'),
    ).rejects.toThrow('denied');
    mockRequest.mockRejectedValue(new Error('offline'));
    await expect(
      getManagedCuratedPipeline('curated:reviewed-workflow'),
    ).rejects.toThrow('no longer available');
    mockRequest.mockResolvedValue({
      version: 1,
      data: [current],
      nextCursor: null,
    });
    expect(
      (await getManagedCuratedPipeline('curated:reviewed-workflow')).info
        .source,
    ).toBe('curated');
  },
);

it('owns one lazy sync timer, follows account identity, and stops subsequent automatic work', async () => {
  jest.useFakeTimers();
  let current = fixture();
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? current
        : { version: 1, data: [current], nextCursor: null },
    ),
  );
  await getManagedCuratedPipeline('curated:reviewed-workflow');
  current = fixture(
    current.rawPipeline.replace('echo reviewed', 'echo automatic'),
  );
  mockRequest.mockClear();
  startManagedCuratedPipelineSync();
  startManagedCuratedPipelineSync();
  expect(jest.getTimerCount()).toBe(1);
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  // Await the already-started tick via the public coalescing entrypoint.
  await syncManagedCuratedPipelines();
  expect(
    mockRequest.mock.calls.filter(([url]) => String(url).endsWith('/content')),
  ).toHaveLength(1);
  mockCredentials.apiKey = 'new-account-with-no-managed-downloads';
  mockRequest.mockClear();
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  await syncManagedCuratedPipelines();
  expect(mockRequest).not.toHaveBeenCalled();
  stopManagedCuratedPipelineSync();
  expect(jest.getTimerCount()).toBe(0);
  await jest.advanceTimersByTimeAsync(10 * 60_000);
  expect(mockRequest).not.toHaveBeenCalled();
});

it('persists direct-preview metadata immediately for offline use before any list or sync', async () => {
  const detail = fixture();
  mockRequest.mockResolvedValue(detail);
  await getCuratedPipeline(detail.key);
  expect(mockRequest).toHaveBeenCalledTimes(1);
  mockRequest.mockRejectedValue(new Error('offline'));
  const managed = await getManagedCuratedPipeline(`curated:${detail.key}`);
  expect(managed.info.curatedContentHash).toEqual(detail.contentHash);
  expect(await readFile(managed.info.filePath ?? '', 'utf8')).toEqual(
    detail.rawPipeline,
  );
  expect(await listManagedCuratedPipelines()).toEqual([
    expect.objectContaining({ id: `curated:${detail.key}` }),
  ]);
});

it('does not roll a newer manifest back when an older preview finishes later', async () => {
  const old = { ...fixture(), revision: 1 };
  const latest = {
    ...fixture(old.rawPipeline.replace('echo reviewed', 'echo latest')),
    revision: 2,
  };
  mockRequest.mockImplementation((url) =>
    Promise.resolve(
      String(url).endsWith('/content')
        ? latest
        : { version: 1, data: [latest], nextCursor: null },
    ),
  );
  const managed = await getManagedCuratedPipeline('curated:reviewed-workflow');
  mockRequest.mockResolvedValue(old);
  await getCuratedPipeline(old.key);
  const manifest = await readFile(
    join(dirname(dirname(managed.info.filePath ?? '')), 'metadata.json'),
    'utf8',
  );
  expect(manifest).toContain(latest.contentHash);
  expect(manifest).not.toContain(old.contentHash);
});
