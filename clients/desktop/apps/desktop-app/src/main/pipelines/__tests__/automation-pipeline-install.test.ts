import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pipelinePaths from '@canopy/desktop-shared/pipelines/config-paths';
import {
  getStoredPipelineText,
  listStoredPipelines,
} from '@canopy/desktop-shared/pipelines/store';
import {
  computePipelinePackageDigestSync,
  hashPipelinePackageYaml,
} from '@canopy/desktop-shared/node';
import { AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE } from '@canopy/desktop-shared/lib/automation-install';
import type {
  PipelinePackageManifestV1,
  PipelinePackageResource,
} from '@canopy/protocol/pipelines';

let mockRoot = '';
jest.mock('../../lib/paths', () => ({
  getDataDir: (): string => mockRoot,
  getPipelinePackageDismissalStorePath: (): string =>
    `${mockRoot}/dismissals.json`,
  getPipelinePackageInstallStorePath: (): string => `${mockRoot}/installs.json`,
  getPipelinePackagesDir: (): string => `${mockRoot}/pipeline-packages`,
  getPipelineDataRoot: (): string => `${mockRoot}/pipeline-data`,
  getPipelineAssetsDir: (id: string): string =>
    `${mockRoot}/pipeline-data/${id}/assets`,
  getPipelineAssetsManifestPath: (id: string): string =>
    `${mockRoot}/pipeline-data/${id}/assets.json`,
}));
jest.mock('../resource-lanes', () => ({
  assertPipelineContext: jest.fn(() => Promise.resolve()),
  pipelineResourceContextEnabled: jest.fn(() => false),
  pipelineContextSnapshot: jest.fn(() => Promise.resolve('revision')),
  assertPipelineContextSnapshot: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../canopy-cloud/shared-item-subscriptions', () => ({
  recordSharedItemInstall: jest.fn(),
  recordSharedItemUninstall: jest.fn(),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  subscribeCanopyCloudAccountChanges: (): (() => void) => () => undefined,
  readCanopyCloudAccountWithStatus: jest.fn(() =>
    Promise.resolve({ status: 'ok', entry: { account: { id: 'user-a' } } }),
  ),
}));
jest.mock('../../canopy-cloud/public-share-client', () => ({
  getPublicPipelineShareSnapshot: jest.fn(),
}));
jest.mock('../canopy-server-client', () => ({
  PACKAGE_REQUEST_TIMEOUT_MS: 30_000,
  getAutomationPackage: jest.fn(),
  getAutomationPackageBlob: jest.fn(),
  getPublicAutomationPackage: jest.fn(),
  getPublicAutomationPackageBlob: jest.fn(),
  getCuratedAutomationPackage: jest.fn(),
  getCuratedAutomationPackageBlob: jest.fn(),
}));
jest.mock('../pipeline-local-metadata-store', () => ({
  deleteUserPipelineLocalMetadata: jest.fn(),
  readPipelineLocalMetadata: jest.fn(() => ({})),
  recordUserPipelineOwner: jest.fn(),
  setUserPipelineAgentAuthor: jest.fn(),
}));
jest.mock('../pipeline-owner-policy', () => ({
  getUserPipelineOwner: jest.fn(() => Promise.resolve('personal')),
  selectedOwnerContext: jest.fn(() => Promise.resolve('personal')),
}));
jest.mock('../../plugins/invocable-inventory-service', () => ({
  loadPipelinePackageInventorySources: jest.fn(),
}));
jest.mock('../../plugins/plugin-resolver', () => ({
  resolveEffectivePluginSelectionRefs: jest.fn(),
}));
jest.mock('../../auth/provider-auth-state', () => ({
  getCachedClaudeAuthStatusObserved: jest.fn(),
  getCachedCodexAuthStatusObserved: jest.fn(),
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  getAiCreditsRoutingContextWithStatus: jest.fn(),
}));

import {
  getAutomationPackage,
  getAutomationPackageBlob,
} from '../canopy-server-client';
import { recordUserPipelineOwner } from '../pipeline-local-metadata-store';
import {
  installAutomationPipelines,
  pipelinesRecordedByAutomations,
  previewAutomationPipelines,
} from '../automation-pipeline-install';
import {
  findCapabilityPackageInstallByOwner,
  listPipelinePackageInstalls,
  upsertCapabilityPackageInstall,
} from '../pipeline-package-install-store';
import {
  installAutomationCapabilityPackage,
  removeAutomationCapabilityPackageInstall,
} from '../pipeline-package-service';

const ENTRY_KEY = '11111111-1111-4111-8111-111111111111';
const WORKER_KEY = 'project-worker';

function pipelineYaml(name: string, extra = ''): string {
  return [
    `name: ${name}`,
    'on: dispatch',
    'jobs:',
    '  run:',
    '    steps:',
    `      - run: echo ${name}${extra}`,
    '',
  ].join('\n');
}

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface PackageFixture {
  digest: string;
  manifest: PipelinePackageManifestV1;
  blobs: Map<string, Uint8Array>;
}

function buildPackage(input: {
  entryYaml: string;
  workerYaml?: string;
  assetFiles?: Record<string, string>;
  /** Asset files the analyzer accepted as executable. */
  executableAssetFiles?: readonly string[];
  installMode?: 'seed' | 'replace';
  /** Corrupt the entry pipeline's pinned hash. */
  badEntryHash?: boolean;
}): PackageFixture {
  const blobs = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const resources: PipelinePackageResource[] = [];
  const pipelineResource = (
    key: string,
    name: string,
    yaml: string,
    dependencyResourceIds: string[],
    badHash = false,
  ): PipelinePackageResource => {
    const bytes = encoder.encode(yaml);
    blobs.set(sha256(bytes), bytes);
    return {
      id: `automation-pipeline-${key}`,
      kind: 'automation_pipeline',
      displayName: name,
      sourceLabel: 'Your pipelines',
      sourceVisibility: 'local',
      invocationKeys: [],
      dependencyResourceIds,
      pipelineKey: key,
      pipelineContentHash: badHash
        ? hashPipelinePackageYaml(`${yaml}# tampered`)
        : hashPipelinePackageYaml(yaml),
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'automation_pipeline',
          rootName: key,
          entries: [
            {
              path: 'pipeline.yaml',
              sha256: sha256(bytes),
              size: bytes.byteLength,
              mode: 'read',
            },
          ],
        },
      ],
    };
  };
  const assetIds: string[] = [];
  if (input.assetFiles) {
    const entries = Object.entries(input.assetFiles).map(
      ([relativePath, contents]) => {
        const bytes = encoder.encode(contents);
        blobs.set(sha256(bytes), bytes);
        return {
          path: relativePath,
          sha256: sha256(bytes),
          size: bytes.byteLength,
          mode: input.executableAssetFiles?.includes(relativePath)
            ? ('execute' as const)
            : ('read' as const),
        };
      },
    );
    const id = `file-asset-${ENTRY_KEY}-specialists`;
    assetIds.push(id);
    resources.push({
      id,
      kind: 'file_asset',
      displayName: 'specialists',
      sourceLabel: 'Pipeline files',
      sourceVisibility: 'local',
      invocationKeys: [],
      dependencyResourceIds: [],
      pipelineKey: ENTRY_KEY,
      assetId: 'specialists',
      installMode: input.installMode ?? 'seed',
      required: true,
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'pipeline_asset',
          rootName: 'specialists',
          entries,
        },
      ],
    });
  }
  resources.push(
    pipelineResource(
      ENTRY_KEY,
      'Journey entry',
      input.entryYaml,
      assetIds,
      input.badEntryHash,
    ),
  );
  if (input.workerYaml !== undefined)
    resources.push(
      pipelineResource(WORKER_KEY, 'Journey worker', input.workerYaml, []),
    );
  const files = resources.flatMap((resource) =>
    resource.trees.flatMap((tree) => tree.entries),
  );
  const manifest: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: hashPipelinePackageYaml('{"automation":true}'),
    resources,
    bindings: [
      {
        jobId: 'automation',
        stepId: 'action',
        resourceIds: resources
          .filter((resource) => resource.kind === 'automation_pipeline')
          .map((resource) => resource.id),
      },
    ],
    environmentRequirements: [],
    totalFiles: files.length,
    totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
  };
  return {
    digest: computePipelinePackageDigestSync(manifest),
    manifest,
    blobs,
  };
}

function servePackage(fixture: PackageFixture): void {
  jest
    .mocked(getAutomationPackage)
    .mockResolvedValue({ digest: fixture.digest, manifest: fixture.manifest });
  jest
    .mocked(getAutomationPackageBlob)
    .mockImplementation((_remoteId, _digest, blobSha) => {
      const bytes = fixture.blobs.get(blobSha);
      return bytes
        ? Promise.resolve(bytes)
        : Promise.reject(new Error(`missing blob ${blobSha}`));
    });
}

function stageA(
  fixture: PackageFixture,
  existingPipelines?: Array<{
    key: string;
    localPipelineId: string;
    expectedContentHash: string;
  }>,
  recordedPipelineIds?: ReadonlySet<string>,
): ReturnType<typeof installAutomationPipelines> {
  return installAutomationPipelines(
    {
      remoteId: 'remote-automation',
      packageRef: { version: 1, digest: fixture.digest },
      stage: 'pipelines',
      ...(existingPipelines ? { existingPipelines } : {}),
    },
    recordedPipelineIds ? { recordedPipelineIds } : {},
  );
}

function userPipelines(): Array<{ id: string; name: string }> {
  return (listStoredPipelines().data ?? []).filter(
    (pipeline) => pipeline.source === 'user',
  );
}

function storePath(): string {
  return `${mockRoot}/installs.json`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

describe('automation pipeline install (Stage A)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockRoot = await mkdtemp(join(tmpdir(), 'automation-pipeline-install-'));
    jest
      .spyOn(pipelinePaths, 'getUserPipelinesDir')
      .mockReturnValue(join(mockRoot, 'pipelines'));
    jest
      .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
      .mockReturnValue(join(mockRoot, 'pipelines', 'index.json'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(mockRoot, { recursive: true, force: true });
  });

  it('creates each packaged pipeline as a user pipeline, links it to the package and installs its files', async () => {
    const entryYaml = pipelineYaml('Journey entry');
    const workerYaml = pipelineYaml('Journey worker');
    const fixture = buildPackage({
      entryYaml,
      workerYaml,
      assetFiles: { 'a.json': '{"a":1}\n', 'nested/b.json': '{"b":2}\n' },
    });
    servePackage(fixture);

    const result = await stageA(fixture);

    const anyLocalId: unknown = expect.any(String);
    expect(result.pipelines).toEqual([
      {
        key: ENTRY_KEY,
        localPipelineId: anyLocalId,
        pipelineContentHash: hashPipelinePackageYaml(entryYaml),
        outcome: 'created',
      },
      {
        key: WORKER_KEY,
        localPipelineId: anyLocalId,
        pipelineContentHash: hashPipelinePackageYaml(workerYaml),
        outcome: 'created',
      },
    ]);
    const [entry, worker] = result.pipelines;
    if (!entry || !worker) throw new Error('expected two pipelines');
    // New local ids; the YAML bytes are pinned exactly.
    expect(entry.localPipelineId).not.toBe(ENTRY_KEY);
    expect(getStoredPipelineText(entry.localPipelineId).data).toBe(entryYaml);
    expect(getStoredPipelineText(worker.localPipelineId).data).toBe(workerYaml);
    // The project pipeline installs as a user pipeline with the same name.
    expect(userPipelines()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: worker.localPipelineId,
          name: 'Journey worker',
        }),
      ]),
    );
    expect(recordUserPipelineOwner).toHaveBeenCalledTimes(2);
    expect(await listPipelinePackageInstalls(storePath())).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localPipelineId: entry.localPipelineId,
          packageDigest: fixture.digest,
          pipelineContentHash: entry.pipelineContentHash,
        }),
        expect.objectContaining({
          localPipelineId: worker.localPipelineId,
          packageDigest: fixture.digest,
          pipelineContentHash: worker.pipelineContentHash,
        }),
      ]),
    );
    const assetsDir = `${mockRoot}/pipeline-data/${entry.localPipelineId}/assets/specialists`;
    expect(await readFile(join(assetsDir, 'a.json'), 'utf8')).toBe('{"a":1}\n');
    expect(await readFile(join(assetsDir, 'nested', 'b.json'), 'utf8')).toBe(
      '{"b":2}\n',
    );
    expect(
      JSON.parse(
        await readFile(
          `${mockRoot}/pipeline-data/${entry.localPipelineId}/assets.json`,
          'utf8',
        ),
      ),
    ).toEqual({
      version: 1,
      assets: {
        specialists: {
          installMode: 'seed',
          files: {
            'a.json': sha256('{"a":1}\n'),
            'nested/b.json': sha256('{"b":2}\n'),
          },
        },
      },
    });
  });

  it('installs an executable asset file as executable', async () => {
    const fixture = buildPackage({
      entryYaml: pipelineYaml('Journey entry'),
      assetFiles: { 'run.sh': '#!/bin/sh\necho hi\n', 'a.json': '{}\n' },
      executableAssetFiles: ['run.sh'],
    });
    servePackage(fixture);

    const result = await stageA(fixture);

    const entry = result.pipelines[0];
    if (!entry) throw new Error('expected a pipeline');
    const assetsDir = `${mockRoot}/pipeline-data/${entry.localPipelineId}/assets/specialists`;
    expect((await stat(join(assetsDir, 'run.sh'))).mode & 0o111).not.toBe(0);
    expect((await stat(join(assetsDir, 'a.json'))).mode & 0o111).toBe(0);
  });

  it('creates the folder of an asset that carries no files', async () => {
    const fixture = buildPackage({
      entryYaml: pipelineYaml('Journey entry'),
      assetFiles: {},
    });
    servePackage(fixture);

    const result = await stageA(fixture);

    const entry = result.pipelines[0];
    if (!entry) throw new Error('expected a pipeline');
    const assetsDir = `${mockRoot}/pipeline-data/${entry.localPipelineId}/assets/specialists`;
    expect((await stat(assetsDir)).isDirectory()).toBe(true);
  });

  it('is idempotent on retry: no duplicate pipelines', async () => {
    const fixture = buildPackage({
      entryYaml: pipelineYaml('Journey entry'),
      workerYaml: pipelineYaml('Journey worker'),
      assetFiles: { 'a.json': 'one\n' },
    });
    servePackage(fixture);

    const first = await stageA(fixture);
    const second = await stageA(fixture);

    expect(second.pipelines.map((pipeline) => pipeline.outcome)).toEqual([
      'reused',
      'reused',
    ]);
    expect(
      second.pipelines.map((pipeline) => pipeline.localPipelineId),
    ).toEqual(first.pipelines.map((pipeline) => pipeline.localPipelineId));
    expect(userPipelines()).toHaveLength(2);
  });

  it("gives a second installed copy its own pipelines, never the first copy's", async () => {
    const fixture = buildPackage({
      entryYaml: pipelineYaml('Journey entry'),
      workerYaml: pipelineYaml('Journey worker'),
    });
    servePackage(fixture);
    const first = await stageA(fixture);
    const firstIds = first.pipelines.map((entry) => entry.localPipelineId);

    // The first copy's automation now records its pipelines.
    const second = await stageA(fixture, undefined, new Set(firstIds));

    expect(second.pipelines.map((entry) => entry.outcome)).toEqual([
      'created',
      'created',
    ]);
    for (const entry of second.pipelines) {
      expect(firstIds).not.toContain(entry.localPipelineId);
    }
  });

  it('lists the pipelines installed automations record', () => {
    const base = {
      version: 1 as const,
      name: 'Copy',
      enabled: false,
      schedule: {
        kind: 'cron' as const,
        expression: '0 2 * * *',
        timezone: 'local' as const,
      },
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      failureCount: 0,
      action: { type: 'app_advisor_prompt' as const, prompt: 'Go' },
    };
    const installedFrom = {
      remoteId: 'remote-automation',
      contentHash: 'a'.repeat(64),
      installedAt: '2026-10-01T00:00:00.000Z',
    };
    expect(
      pipelinesRecordedByAutomations([
        { ...base, id: 'own', name: 'Own' },
        {
          ...base,
          id: 'action-copy',
          installedFrom: {
            ...installedFrom,
            bundledPipelineLocalId: 'action-1',
          },
        },
        {
          ...base,
          id: 'prompt-copy',
          installedFrom: {
            ...installedFrom,
            pipelineDependencies: [
              {
                key: ENTRY_KEY,
                localPipelineId: 'entry-1',
                pipelineContentHash: 'b'.repeat(64),
              },
            ],
          },
        },
      ]),
    ).toEqual(new Set(['action-1', 'entry-1']));
  });

  it('refuses a blob that does not match its pinned hash before writing anything', async () => {
    const fixture = buildPackage({
      entryYaml: pipelineYaml('Journey entry'),
      workerYaml: pipelineYaml('Journey worker'),
      badEntryHash: true,
    });
    servePackage(fixture);

    await expect(stageA(fixture)).rejects.toThrow("doesn't match its hash");

    expect(userPipelines()).toEqual([]);
    expect(await listPipelinePackageInstalls(storePath())).toEqual([]);
    expect(await exists(`${mockRoot}/pipeline-packages`)).toBe(false);
    expect(await exists(`${mockRoot}/pipeline-data`)).toBe(false);
  });

  it('refuses a locally edited recorded pipeline before writing anything', async () => {
    const entryYaml = pipelineYaml('Journey entry');
    const original = buildPackage({ entryYaml });
    servePackage(original);
    const [entry] = (await stageA(original)).pipelines;
    if (!entry) throw new Error('expected the entry pipeline');
    const storedPath = join(
      mockRoot,
      'pipelines',
      `${entry.localPipelineId}.yaml`,
    );
    await writeFile(storedPath, `${entryYaml}# my edit\n`, 'utf8');
    const updated = buildPackage({
      entryYaml: pipelineYaml('Journey entry', ' v2'),
      workerYaml: pipelineYaml('Journey worker'),
    });
    servePackage(updated);

    await expect(
      stageA(updated, [
        {
          key: ENTRY_KEY,
          localPipelineId: entry.localPipelineId,
          expectedContentHash: entry.pipelineContentHash,
        },
      ]),
    ).rejects.toThrow(AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE);

    // The edit is preserved, the new worker was not created, and the entry
    // stays linked to the package it was installed from.
    expect(await readFile(storedPath, 'utf8')).toBe(`${entryYaml}# my edit\n`);
    expect(userPipelines()).toHaveLength(1);
    expect(await listPipelinePackageInstalls(storePath())).toEqual([
      expect.objectContaining({ packageDigest: original.digest }),
    ]);
  });

  it('keeps an unchanged recorded pipeline and rewrites a changed one under the same id', async () => {
    const workerYaml = pipelineYaml('Journey worker');
    const original = buildPackage({
      entryYaml: pipelineYaml('Journey entry'),
      workerYaml,
    });
    servePackage(original);
    const installed = (await stageA(original)).pipelines;
    const updatedEntryYaml = pipelineYaml('Journey entry', ' v2');
    const updated = buildPackage({ entryYaml: updatedEntryYaml, workerYaml });
    servePackage(updated);

    const result = await stageA(
      updated,
      installed.map((pipeline) => ({
        key: pipeline.key,
        localPipelineId: pipeline.localPipelineId,
        expectedContentHash: pipeline.pipelineContentHash,
      })),
    );

    expect(result.pipelines).toEqual([
      expect.objectContaining({
        key: ENTRY_KEY,
        localPipelineId: installed[0]?.localPipelineId,
        outcome: 'reused',
      }),
      expect.objectContaining({
        key: WORKER_KEY,
        localPipelineId: installed[1]?.localPipelineId,
        outcome: 'kept',
      }),
    ]);
    expect(
      getStoredPipelineText(installed[0]?.localPipelineId ?? '').data,
    ).toBe(updatedEntryYaml);
    expect(userPipelines()).toHaveLength(2);
    // Both are relinked to the new package.
    expect(
      (await listPipelinePackageInstalls(storePath())).map(
        (record) =>
          record.distributionMode !== 'definition_only' && record.packageDigest,
      ),
    ).toEqual([updated.digest, updated.digest]);
  });

  it('reuses an unlinked local pipeline with the same YAML', async () => {
    const entryYaml = pipelineYaml('Journey entry');
    const fixture = buildPackage({ entryYaml });
    servePackage(fixture);
    const existingId = randomUUID();
    await mkdir(join(mockRoot, 'pipelines'), { recursive: true });
    await writeFile(
      join(mockRoot, 'pipelines', `${existingId}.yaml`),
      entryYaml,
      'utf8',
    );
    await writeFile(
      join(mockRoot, 'pipelines', 'index.json'),
      JSON.stringify({
        pipelines: [
          {
            id: existingId,
            name: 'Mine',
            filename: `${existingId}.yaml`,
            description: '',
            icon: '',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
            triggerTypes: ['dispatch'],
            scopes: ['directory'],
          },
        ],
      }),
      'utf8',
    );

    const result = await stageA(fixture);

    expect(result.pipelines).toEqual([
      expect.objectContaining({
        localPipelineId: existingId,
        outcome: 'reused',
      }),
    ]);
    expect(userPipelines()).toHaveLength(1);
  });

  it.each([
    ['seed', 'local edit\n'],
    ['replace', 'from the share\n'],
  ] as const)(
    'installs files in %s mode over a locally edited file',
    async (installMode, expected) => {
      const fixture = buildPackage({
        entryYaml: pipelineYaml('Journey entry'),
        assetFiles: { 'a.json': 'from the share\n', 'new.json': 'new\n' },
        installMode,
      });
      servePackage(fixture);
      const [entry] = (await stageA(fixture)).pipelines;
      if (!entry) throw new Error('expected the entry pipeline');
      const assetsDir = `${mockRoot}/pipeline-data/${entry.localPipelineId}/assets/specialists`;
      await writeFile(join(assetsDir, 'a.json'), 'local edit\n', 'utf8');
      await rm(join(assetsDir, 'new.json'));

      await stageA(fixture);

      expect(await readFile(join(assetsDir, 'a.json'), 'utf8')).toBe(expected);
      // A missing file is always restored.
      expect(await readFile(join(assetsDir, 'new.json'), 'utf8')).toBe('new\n');
      // The record keeps the hash of what install wrote, so a later update
      // can tell the local edit apart.
      const recorded: unknown = JSON.parse(
        await readFile(
          `${mockRoot}/pipeline-data/${entry.localPipelineId}/assets.json`,
          'utf8',
        ),
      );
      expect(recorded).toEqual({
        version: 1,
        assets: {
          specialists: {
            installMode,
            files: {
              'a.json': sha256('from the share\n'),
              'new.json': sha256('new\n'),
            },
          },
        },
      });
    },
  );

  describe('preview (update review)', () => {
    function preview(
      fixture: PackageFixture,
      existingPipelines?: Array<{
        key: string;
        localPipelineId: string;
        expectedContentHash: string;
      }>,
    ): ReturnType<typeof previewAutomationPipelines> {
      return previewAutomationPipelines({
        remoteId: 'remote-automation',
        packageRef: { version: 1, digest: fixture.digest },
        stage: 'pipelines-preview',
        ...(existingPipelines ? { existingPipelines } : {}),
      });
    }

    it('reports what a fresh install would create without saving anything', async () => {
      const entryYaml = pipelineYaml('Journey entry');
      const fixture = buildPackage({
        entryYaml,
        assetFiles: { 'a.json': 'one\n' },
      });
      servePackage(fixture);

      const result = await preview(fixture);

      expect(result.pipelines).toEqual([
        {
          key: ENTRY_KEY,
          pipelineContentHash: hashPipelinePackageYaml(entryYaml),
          outcome: 'created',
          rewrites: false,
          rawPipeline: entryYaml,
          assetChanges: [],
        },
      ]);
      expect(userPipelines()).toEqual([]);
      expect(await listPipelinePackageInstalls(storePath())).toEqual([]);
      expect(await exists(`${mockRoot}/pipeline-data`)).toBe(false);
    });

    it.each([
      [
        'replace',
        {
          added: ['d.json'],
          updated: ['a.json'],
          overwritten: ['b.json'],
          kept: [],
        },
      ],
      [
        'seed',
        {
          added: ['d.json'],
          updated: [],
          overwritten: [],
          kept: ['a.json', 'b.json'],
        },
      ],
    ] as const)(
      'previews an update in %s mode: the shared YAML and each file change, writing nothing',
      async (installMode, expectedChanges) => {
        const workerYaml = pipelineYaml('Journey worker');
        const original = buildPackage({
          entryYaml: pipelineYaml('Journey entry'),
          workerYaml,
          assetFiles: {
            'a.json': 'one\n',
            'b.json': 'two\n',
            'c.json': 'three\n',
          },
          installMode,
        });
        servePackage(original);
        const installed = (await stageA(original)).pipelines;
        const [entry, worker] = installed;
        if (!entry || !worker) throw new Error('expected both pipelines');
        const assetsDir = `${mockRoot}/pipeline-data/${entry.localPipelineId}/assets/specialists`;
        await writeFile(join(assetsDir, 'b.json'), 'my edit\n', 'utf8');
        const updatedEntryYaml = pipelineYaml('Journey entry', ' v2');
        const updated = buildPackage({
          entryYaml: updatedEntryYaml,
          workerYaml,
          assetFiles: {
            'a.json': 'one v2\n',
            'b.json': 'two v2\n',
            'c.json': 'three\n',
            'd.json': 'four\n',
          },
          installMode,
        });
        servePackage(updated);

        const result = await preview(
          updated,
          installed.map((pipeline) => ({
            key: pipeline.key,
            localPipelineId: pipeline.localPipelineId,
            expectedContentHash: pipeline.pipelineContentHash,
          })),
        );

        expect(result.pipelines).toEqual([
          {
            key: ENTRY_KEY,
            localPipelineId: entry.localPipelineId,
            pipelineContentHash: hashPipelinePackageYaml(updatedEntryYaml),
            outcome: 'reused',
            rewrites: true,
            rawPipeline: updatedEntryYaml,
            assetChanges: [
              { assetId: 'specialists', installMode, ...expectedChanges },
            ],
          },
          expect.objectContaining({
            key: WORKER_KEY,
            localPipelineId: worker.localPipelineId,
            outcome: 'kept',
            rewrites: false,
            rawPipeline: workerYaml,
          }),
        ]);
        // Nothing changed on disk or in the install records.
        expect(getStoredPipelineText(entry.localPipelineId).data).toBe(
          pipelineYaml('Journey entry'),
        );
        expect(await readFile(join(assetsDir, 'a.json'), 'utf8')).toBe('one\n');
        expect(await readFile(join(assetsDir, 'b.json'), 'utf8')).toBe(
          'my edit\n',
        );
        expect(await exists(join(assetsDir, 'd.json'))).toBe(false);
        expect(
          (await listPipelinePackageInstalls(storePath())).map(
            (record) =>
              record.distributionMode !== 'definition_only' &&
              record.packageDigest,
          ),
        ).toEqual([original.digest, original.digest]);
      },
    );

    it('refuses a locally edited recorded pipeline, as Stage A does', async () => {
      const entryYaml = pipelineYaml('Journey entry');
      const original = buildPackage({ entryYaml });
      servePackage(original);
      const [entry] = (await stageA(original)).pipelines;
      if (!entry) throw new Error('expected the entry pipeline');
      await writeFile(
        join(mockRoot, 'pipelines', `${entry.localPipelineId}.yaml`),
        `${entryYaml}# my edit\n`,
        'utf8',
      );
      const updated = buildPackage({
        entryYaml: pipelineYaml('Journey entry', ' v2'),
      });
      servePackage(updated);

      await expect(
        preview(updated, [
          {
            key: ENTRY_KEY,
            localPipelineId: entry.localPipelineId,
            expectedContentHash: entry.pipelineContentHash,
          },
        ]),
      ).rejects.toThrow(AUTOMATION_PIPELINE_LOCAL_CHANGES_MESSAGE);
    });
  });
});

describe('automation package removal and update (Stage B)', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockRoot = await mkdtemp(join(tmpdir(), 'automation-pipeline-release-'));
    jest
      .spyOn(pipelinePaths, 'getUserPipelinesDir')
      .mockReturnValue(join(mockRoot, 'pipelines'));
    jest
      .spyOn(pipelinePaths, 'getUserPipelineIndexPath')
      .mockReturnValue(join(mockRoot, 'pipelines', 'index.json'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(mockRoot, { recursive: true, force: true });
  });

  async function installAutomation(
    fixture: PackageFixture,
    localAutomationId: string,
  ): Promise<void> {
    servePackage(fixture);
    await installAutomationCapabilityPackage({
      remoteId: 'remote-automation',
      localAutomationId,
      packageRef: { version: 1, digest: fixture.digest },
    });
  }

  it('drops the pipeline links an automation created only when no other install references its package, and keeps the pipelines', async () => {
    const fixture = buildPackage({
      entryYaml: pipelineYaml('Journey entry'),
      workerYaml: pipelineYaml('Journey worker'),
    });
    servePackage(fixture);
    const installed = (await stageA(fixture)).pipelines;
    await installAutomation(fixture, 'automation-a');
    await installAutomation(fixture, 'automation-b');

    await removeAutomationCapabilityPackageInstall('automation-a');
    // automation-b still references the package, so its pipelines stay linked.
    expect(await listPipelinePackageInstalls(storePath())).toHaveLength(2);

    await removeAutomationCapabilityPackageInstall('automation-b');
    expect(await listPipelinePackageInstalls(storePath())).toEqual([]);
    expect(
      await findCapabilityPackageInstallByOwner(storePath(), {
        kind: 'automation',
        localAutomationId: 'automation-b',
      }),
    ).toBeNull();
    // The local pipelines stay.
    expect(
      userPipelines()
        .map((pipeline) => pipeline.id)
        .sort(),
    ).toEqual(installed.map((pipeline) => pipeline.localPipelineId).sort());
  });

  it('keeps unrelated pipeline package links', async () => {
    const fixture = buildPackage({ entryYaml: pipelineYaml('Journey entry') });
    servePackage(fixture);
    await stageA(fixture);
    await installAutomation(fixture, 'automation-a');
    const other = buildPackage({ entryYaml: pipelineYaml('Other') });
    await upsertCapabilityPackageInstall(storePath(), {
      owner: { kind: 'pipeline', localPipelineId: 'unrelated-pipeline' },
      pipelineContentHash: 'c'.repeat(64),
      packageDigest: other.digest,
      installedAt: '2026-10-01T00:00:00.000Z',
    });

    await removeAutomationCapabilityPackageInstall('automation-a');

    expect(await listPipelinePackageInstalls(storePath())).toEqual([
      expect.objectContaining({ localPipelineId: 'unrelated-pipeline' }),
    ]);
  });

  it('unlinks a dependency the updated share no longer lists, keeping its pipeline', async () => {
    const entryYaml = pipelineYaml('Journey entry');
    const original = buildPackage({
      entryYaml,
      workerYaml: pipelineYaml('Journey worker'),
    });
    servePackage(original);
    const installed = (await stageA(original)).pipelines;
    await installAutomation(original, 'automation-a');
    // The update drops the worker; Stage A relinks only the entry.
    const updated = buildPackage({
      entryYaml: pipelineYaml('Journey entry', ' v2'),
    });
    servePackage(updated);
    await stageA(
      updated,
      installed.map((pipeline) => ({
        key: pipeline.key,
        localPipelineId: pipeline.localPipelineId,
        expectedContentHash: pipeline.pipelineContentHash,
      })),
    );

    await installAutomation(updated, 'automation-a');

    expect(await listPipelinePackageInstalls(storePath())).toEqual([
      expect.objectContaining({
        localPipelineId: installed[0]?.localPipelineId,
        packageDigest: updated.digest,
      }),
    ]);
    expect(userPipelines()).toHaveLength(2);
  });
});
