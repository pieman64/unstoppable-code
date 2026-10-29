import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type * as FsPromisesModule from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computePipelinePackageDigest,
  type PipelinePackageManifestV1,
} from '@canopy/protocol/pipelines';

import type { SharedSkillDetail } from '@canopy/desktop-shared/types/skills';
import type {
  ResourceContextInput,
  ResourceContextDecision,
} from '@canopy/desktop-shared/lib/resource-context-policy';
import { createResourceInstallReceiptsStore } from '../../lib/resource-install-receipts';
import {
  assertStoredSkillContext,
  filterStoredSkillContexts,
} from '../skill-install-context';

const mockContextEnabled = jest.fn((): boolean => false);
let mockContext = 'organization-a';
const mockGetSharedSkill = jest.fn<Promise<SharedSkillDetail>, [string]>();
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): unknown => ({ isEnabled: mockContextEnabled }),
}));
jest.mock('../../lib/workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: async (): Promise<void> => {},
    whenIdle: async (): Promise<void> => {},
    accountEpoch: (): number => 1,
    getState: (): unknown => ({ revision: 1, context: mockContext }),
  }),
}));
jest.mock('../../services/resource-context-policy-service', () => ({
  getResourceContextPolicyService: (): unknown => ({
    decide: (input: ResourceContextInput): Promise<ResourceContextDecision> => {
      const owner = input.resource.owner;
      const organization =
        input.resource.provenance?.ownerContext.kind === 'organization' ||
        (typeof owner === 'object' &&
          owner !== null &&
          'type' in owner &&
          owner.type === 'organization');
      return Promise.resolve(
        organization && mockContext !== 'organization-a'
          ? { allow: false, reason: 'context-mismatch' }
          : { allow: true },
      );
    },
  }),
}));
jest.mock('../../lib/canopy-cloud-account-store', () => ({
  readCanopyCloudAccountWithStatus: (): Promise<unknown> =>
    Promise.resolve({
      status: 'ok',
      entry: { account: { id: 'user-a' } },
    }),
}));
jest.mock('../canopy-server-client', () => ({
  getSharedSkill: (id: string): Promise<SharedSkillDetail> =>
    mockGetSharedSkill(id),
}));
const sharedDetail: SharedSkillDetail = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'helper',
  description: '',
  rawSkill: '---\nname: helper\n---\nBody\n',
  contentHash: 'hash',
  publicShare: null,
  createdBy: { id: 'user-a', name: 'User' },
  createdAt: '',
  updatedAt: '',
  canUpdate: true,
  canDelete: true,
  shareScope: 'organization',
  owner: {
    type: 'organization',
    id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    name: 'A',
  },
};

const skillsRoot = { path: '' };
const packagesRoot = { path: '' };

jest.mock('../paths', () => ({
  getSourceDir: (sourceId: string): string =>
    join(skillsRoot.path, sourceId.replace(':', '-')),
  getSkillDir: (sourceId: string, skillName: string): string =>
    join(skillsRoot.path, sourceId.replace(':', '-'), skillName),
}));
jest.mock('../../lib/paths', () => ({
  getPipelinePackagesDir: (): string => packagesRoot.path,
  getDataDir: (): string => join(packagesRoot.path, 'receipts'),
  getPipelinePackageInstallStorePath: (): string =>
    join(packagesRoot.path, 'installs.json'),
}));
const mockUpsertInstall = jest.fn();
jest.mock('../../pipelines/pipeline-package-install-store', () => ({
  upsertCapabilityPackageInstall: (...args: unknown[]): Promise<void> =>
    mockUpsertInstall(...args) as Promise<void>,
}));
const mockGetPackage = jest.fn();
const mockGetBlob = jest.fn<Promise<Uint8Array>, unknown[]>();
const mockGetPublicPackage = jest.fn<Promise<unknown>, unknown[]>();
const mockGetPublicBlob = jest.fn<Promise<Uint8Array>, unknown[]>();
jest.mock('../../pipelines/canopy-server-client', () => ({
  getSkillPackage: (...args: unknown[]): Promise<unknown> =>
    mockGetPackage(...args) as Promise<unknown>,
  getSkillPackageBlob: (...args: unknown[]): Promise<Uint8Array> =>
    mockGetBlob(...args),
  getPublicSkillPackage: (...args: unknown[]): Promise<unknown> =>
    mockGetPublicPackage(...args),
  getPublicSkillPackageBlob: (...args: unknown[]): Promise<Uint8Array> =>
    mockGetPublicBlob(...args),
}));

import {
  installSkillCapabilityPackage,
  installSubjectCapabilityPackage,
  type InstallSubjectCapabilityPackageResult,
} from '../skill-package-install';

// The cache install recomputes the digest over the manifest, so a fabricated
// one would only ever exercise the mismatch path.
const blobs = new Map<string, Uint8Array>();

function blob(content: string): { sha256: string; size: number } {
  const bytes = new TextEncoder().encode(content);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  blobs.set(sha256, bytes);
  return { sha256, size: bytes.byteLength };
}

function manifest(
  overrides: Partial<PipelinePackageManifestV1> = {},
): PipelinePackageManifestV1 {
  const skillMd = blob('---\nname: helper\n---\nBody\n');
  const guide = blob('guide');
  const siblingMd = blob('---\nname: sibling\n---\nSibling\n');
  const base: PipelinePackageManifestV1 = {
    version: 1,
    pipelineContentHash: 'a'.repeat(64),
    resources: [
      {
        id: 'primary',
        kind: 'standalone_skill',
        displayName: 'helper',
        sourceLabel: 'custom:app',
        sourceVisibility: 'local',
        invocationKeys: ['/helper'],
        dependencyResourceIds: ['sibling'],
        trees: [
          {
            provider: 'claude',
            runtimeKind: 'standalone_skill',
            rootName: 'helper',
            entries: [
              { path: 'SKILL.md', mode: 'read', ...skillMd },
              { path: 'references/guide.md', mode: 'read', ...guide },
            ],
          },
        ],
      },
      {
        id: 'sibling',
        kind: 'standalone_skill',
        displayName: 'sibling',
        sourceLabel: 'custom:app',
        sourceVisibility: 'local',
        invocationKeys: ['/sibling'],
        dependencyResourceIds: [],
        trees: [
          {
            provider: 'claude',
            runtimeKind: 'standalone_skill',
            rootName: 'sibling',
            entries: [{ path: 'SKILL.md', mode: 'read', ...siblingMd }],
          },
        ],
      },
    ],
    bindings: [{ target: 'subject', resourceIds: ['primary'] }],
    environmentRequirements: [],
    totalFiles: 3,
    totalBytes: skillMd.size + guide.size + siblingMd.size,
  };
  return { ...base, ...overrides };
}

describe('installSkillCapabilityPackage', () => {
  let root: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    blobs.clear();
    mockContextEnabled.mockReturnValue(false);
    mockContext = 'organization-a';
    mockGetSharedSkill.mockReset().mockResolvedValue(sharedDetail);
    root = await mkdtemp(join(tmpdir(), 'skill-package-install-'));
    skillsRoot.path = join(root, 'skills');
    packagesRoot.path = join(root, 'packages');
    mockUpsertInstall.mockReset().mockResolvedValue(undefined);
    mockGetPublicPackage.mockReset();
    mockGetPublicBlob.mockImplementation(
      (...args: unknown[]): Promise<Uint8Array> => mockGetBlob(...args),
    );
    mockGetBlob.mockImplementation(
      (_id, _digest, sha256): Promise<Uint8Array> => {
        if (typeof sha256 !== 'string')
          return Promise.reject(new Error('missing blob hash'));
        const bytes = blobs.get(sha256);
        return bytes
          ? Promise.resolve(bytes)
          : Promise.reject(new Error(`missing blob ${sha256}`));
      },
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function serve(value: PipelinePackageManifestV1): Promise<string> {
    const digest = await computePipelinePackageDigest(value);
    mockGetPackage.mockResolvedValue({ digest, manifest: value });
    return digest;
  }

  async function install(
    digest: string,
  ): Promise<Awaited<ReturnType<typeof installSkillCapabilityPackage>>> {
    return installSkillCapabilityPackage({
      remoteId: '00000000-0000-4000-8000-000000000001',
      skillName: 'helper',
      primaryRootName: 'helper',
      packageRef: { version: 1, digest },
    });
  }

  it.each([false, true])(
    'installs public packages through public endpoints with enforcement %s',
    async (enabled): Promise<void> => {
      mockContextEnabled.mockReturnValue(enabled);
      mockGetSharedSkill.mockRejectedValue(new Error('not an owned skill'));
      const value = manifest();
      const digest = await computePipelinePackageDigest(value);
      mockGetPublicPackage.mockResolvedValue({ digest, manifest: value });
      const result = await installSkillCapabilityPackage({
        remoteId: 'public-share-id',
        publicShare: true,
        skillName: 'helper',
        primaryRootName: 'helper',
        packageRef: { version: 1, digest },
      });
      expect(result.supportingFileCount).toBe(1);
      expect(result.installedDependencies).toEqual([
        { name: 'sibling', localName: 'sibling' },
      ]);
      expect(mockGetPublicPackage).toHaveBeenCalledWith(
        'public-share-id',
        digest,
      );
      expect(mockGetPublicBlob).toHaveBeenCalled();
      expect(mockGetPackage).not.toHaveBeenCalled();
      expect(mockGetSharedSkill).not.toHaveBeenCalled();
      expect(
        await createResourceInstallReceiptsStore('user-a').listForAccount(),
      ).toEqual([]);
    },
  );

  it('rejects unverified public packages before writing skill files', async (): Promise<void> => {
    mockContextEnabled.mockReturnValue(true);
    mockGetSharedSkill.mockRejectedValue(new Error('not an owned skill'));
    mockGetPublicPackage.mockRejectedValue(new Error('public share revoked'));
    await expect(
      installSkillCapabilityPackage({
        remoteId: 'public-share-id',
        publicShare: true,
        skillName: 'helper',
        primaryRootName: 'helper',
        packageRef: { version: 1, digest: 'digest' },
      }),
    ).rejects.toThrow('public share revoked');
    expect(mockGetSharedSkill).not.toHaveBeenCalled();
    expect(mockGetBlob).not.toHaveBeenCalled();
    expect(mockUpsertInstall).not.toHaveBeenCalled();
    await expect(stat(join(skillsRoot.path, 'custom-app'))).rejects.toThrow();
  });

  it.each(['helper', 'sibling'])(
    'preserves existing scoped origin for public package target %s',
    async (name): Promise<void> => {
      mockContextEnabled.mockReturnValue(true);
      const { recordSharedSkillInstall } =
        await import('../skill-install-context');
      await recordSharedSkillInstall(sharedDetail, `custom:app/${name}`);
      const directory = join(skillsRoot.path, 'custom-app', name);
      await mkdir(directory, { recursive: true });
      const content =
        name === 'sibling' ? '---\nname: sibling\n---\nSibling\n' : 'ORIGINAL';
      await writeFile(join(directory, 'SKILL.md'), content);
      const value = manifest();
      const digest = await computePipelinePackageDigest(value);
      mockGetPublicPackage.mockResolvedValue({ digest, manifest: value });
      mockGetSharedSkill.mockImplementation(
        (id): Promise<SharedSkillDetail> =>
          id === sharedDetail.id
            ? Promise.resolve(sharedDetail)
            : Promise.reject(new Error('not an owned skill')),
      );
      mockContext = 'personal';
      await expect(
        installSkillCapabilityPackage({
          remoteId: 'public-share-id',
          publicShare: true,
          skillName: 'helper',
          primaryRootName: 'helper',
          packageRef: { version: 1, digest },
        }),
      ).rejects.toThrow('context-mismatch');
      expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toBe(content);
      expect(mockGetSharedSkill).not.toHaveBeenCalledWith('public-share-id');
      expect(mockUpsertInstall).not.toHaveBeenCalled();
    },
  );

  it('keeps identical personal dependencies unbound across imports and access removal', async (): Promise<void> => {
    mockContextEnabled.mockReturnValue(true);
    const digest = await serve(manifest());
    const rawSkill = '---\nname: sibling\n---\nSibling\n';
    const store = createResourceInstallReceiptsStore('user-a');
    for (const name of ['sibling', 'sibling-2']) {
      const directory = join(skillsRoot.path, 'custom-app', name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'SKILL.md'), rawSkill);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await install(digest);
      expect(result.installedDependencies).toEqual([
        { name: 'sibling', localName: 'sibling-3' },
      ]);
    }
    mockContext = 'personal';
    mockGetSharedSkill.mockRejectedValue(new Error('access-removed'));
    for (const name of ['sibling', 'sibling-2']) {
      expect(
        await store.findLocal('skills', `custom:app/${name}`),
      ).toBeUndefined();
      await expect(
        assertStoredSkillContext(`custom:app/${name}`),
      ).resolves.toBeUndefined();
      expect(
        await readFile(
          join(skillsRoot.path, 'custom-app', name, 'SKILL.md'),
          'utf8',
        ),
      ).toBe(rawSkill);
    }
    await expect(
      assertStoredSkillContext('custom:app/sibling-3'),
    ).rejects.toThrow('access-removed');
  });

  it('rejects binding a package directly to an unbound personal primary', async (): Promise<void> => {
    mockContextEnabled.mockReturnValue(true);
    const digest = await serve(manifest());
    const directory = join(skillsRoot.path, 'custom-app', 'helper');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), sharedDetail.rawSkill);
    await expect(install(digest)).rejects.toThrow('origin');
    expect(
      await createResourceInstallReceiptsStore('user-a').listForAccount(),
    ).toEqual([]);
    await expect(stat(join(directory, 'references'))).rejects.toThrow();
  });

  it.each(['fresh', 'reused', 'renamed'])(
    'binds every %s dependency to the remote origin and blocks it after switching context',
    async (kind): Promise<void> => {
      mockContextEnabled.mockReturnValue(true);
      const digest = await serve(manifest());
      const sibling = join(skillsRoot.path, 'custom-app', 'sibling');
      if (kind !== 'fresh') {
        await mkdir(sibling, { recursive: true });
        await writeFile(
          join(sibling, 'SKILL.md'),
          kind === 'reused' ? '---\nname: sibling\n---\nSibling\n' : 'MINE',
        );
      }
      if (kind === 'reused') {
        const { recordSharedSkillInstall } =
          await import('../skill-install-context');
        await recordSharedSkillInstall(sharedDetail, 'custom:app/sibling');
      }
      const result = await install(digest);
      const name = kind === 'renamed' ? 'sibling-2' : 'sibling';
      expect(result.installedDependencies).toEqual([
        { name: 'sibling', localName: name },
      ]);
      const store = createResourceInstallReceiptsStore('user-a');
      expect(
        (await store.findLocal('skills', `custom:app/${name}`))?.receipt
          .localResourceIds,
      ).toEqual(
        expect.arrayContaining(['custom:app/helper', `custom:app/${name}`]),
      );
      for (const context of ['personal', 'organization-b']) {
        mockContext = context;
        await expect(
          assertStoredSkillContext(`custom:app/${name}`),
        ).rejects.toThrow('context-mismatch');
        await expect(
          filterStoredSkillContexts([{ sourceId: 'custom:app', name }]),
        ).resolves.toEqual([]);
      }
    },
  );

  it.each(['copy', 'ledger', 'context'])(
    'rolls back dependency bindings and files after %s failure while retaining prior primary origin',
    async (failure): Promise<void> => {
      mockContextEnabled.mockReturnValue(true);
      const digest = await serve(manifest());
      const store = createResourceInstallReceiptsStore('user-a');
      const { recordSharedSkillInstall } =
        await import('../skill-install-context');
      await recordSharedSkillInstall(sharedDetail, 'custom:app/helper');
      const previous = await store.find('skills', sharedDetail.id);
      const fsPromises =
        jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
      const realWriteFile = fsPromises.writeFile;
      let boundBeforeWrite = false;
      const spy = jest
        .spyOn(fsPromises, 'writeFile')
        .mockImplementation(async (file, data, options): Promise<void> => {
          if (
            typeof file === 'string' &&
            file.endsWith(join('sibling', 'SKILL.md'))
          ) {
            boundBeforeWrite =
              (await store.findLocal('skills', 'custom:app/sibling')) !==
              undefined;
            if (failure === 'copy') throw new Error('disk full');
            if (failure === 'context') mockContext = 'personal';
          }
          await realWriteFile(file, data, options);
        });
      if (failure === 'ledger')
        mockUpsertInstall.mockRejectedValueOnce(new Error('ledger failed'));
      try {
        await expect(install(digest)).rejects.toThrow(
          failure === 'copy'
            ? 'disk full'
            : failure === 'ledger'
              ? 'ledger failed'
              : 'context-mismatch',
        );
      } finally {
        spy.mockRestore();
      }
      expect(boundBeforeWrite).toBe(true);
      // Rollback keeps the prior origin and bindings; the receipt store may
      // retain the aborted write's authorization timestamp (it never deletes).
      const retained = await store.find('skills', sharedDetail.id);
      expect({ ...retained, authorizedAt: undefined }).toEqual({
        ...previous,
        authorizedAt: undefined,
      });
      expect(
        await store.findLocal('skills', 'custom:app/sibling'),
      ).toBeUndefined();
      await expect(
        stat(join(skillsRoot.path, 'custom-app', 'sibling')),
      ).rejects.toThrow();
    },
  );

  it('keeps flag-off package installs free of context lookups and receipts', async (): Promise<void> => {
    await install(await serve(manifest()));
    expect(mockGetSharedSkill).not.toHaveBeenCalled();
    expect(
      await createResourceInstallReceiptsStore('user-a').listForAccount(),
    ).toEqual([]);
  });

  it('installs a publisher adapter with sibling documents and relative references as support files only', async () => {
    const value = manifest();
    value.resources = value.resources.slice(0, 1);
    const resource = value.resources[0];
    resource.dependencyResourceIds = [];
    const entries = resource.trees[0].entries;
    entries.push(
      {
        path: '.upstream/skills/charts/SKILL.md',
        mode: 'read',
        ...blob('Read ../../references/guide.md and ../sibling/SKILL.md'),
      },
      {
        path: '.upstream/skills/sibling/SKILL.md',
        mode: 'read',
        ...blob('Sibling instructions'),
      },
      {
        path: '.upstream/references/guide.md',
        mode: 'read',
        ...blob('Shared reference'),
      },
    );
    value.totalFiles = entries.length;
    value.totalBytes = entries.reduce((sum, file) => sum + file.size, 0);
    const digest = await serve(value);
    const directory = join(skillsRoot.path, 'custom-app', 'helper');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), 'Selected wrapper');
    const result = await install(digest);
    expect(result.installedDependencies).toEqual([]);
    expect(
      await readFile(
        join(directory, '.upstream/skills/charts/../../references/guide.md'),
        'utf8',
      ),
    ).toBe('Shared reference');
    expect(
      await readFile(
        join(directory, '.upstream/skills/charts/../sibling/SKILL.md'),
        'utf8',
      ),
    ).toBe('Sibling instructions');
  });

  it('copies supporting files beside the imported skill without rewriting SKILL.md', async () => {
    const digest = await serve(manifest());
    const skillDir = join(skillsRoot.path, 'custom-app', 'helper');
    await mkdir(skillDir, { recursive: true });
    // The import already wrote the share's raw bytes, which are what the
    // content hash covers. The install must not replace them.
    await writeFile(join(skillDir, 'SKILL.md'), 'ORIGINAL BYTES', 'utf8');

    const result = await install(digest);

    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf8')).toBe(
      'ORIGINAL BYTES',
    );
    expect(
      await readFile(join(skillDir, 'references', 'guide.md'), 'utf8'),
    ).toBe('guide');
    expect(result.supportingFileCount).toBe(1);
  });

  it('installs an invoked sibling skill through the subject closure', async () => {
    const digest = await serve(manifest());
    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });

    const result = await install(digest);

    expect(result.installedDependencies).toEqual([
      { name: 'sibling', localName: 'sibling' },
    ]);
    expect(
      await readFile(
        join(skillsRoot.path, 'custom-app', 'sibling', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Sibling');
  });

  it('installs every subject-bound skill and records the supplied subject owner', async () => {
    const value = manifest();
    const digest = await computePipelinePackageDigest(value);

    const result = await installSubjectCapabilityPackage({
      owner: { kind: 'agent', localId: 'agent_model_reviewer' },
      originExternalId: '00000000-0000-4000-8000-000000000001',
      packageRef: { version: 1, digest },
      download: { digest, manifest: value },
      fetchBlob: (sha256) => {
        const bytes = blobs.get(sha256);
        if (!bytes) throw new Error(`missing blob ${sha256}`);
        return Promise.resolve(bytes);
      },
    });

    expect(result.installedSkills).toEqual([
      { name: 'helper', localName: 'helper' },
      { name: 'sibling', localName: 'sibling' },
    ]);
    expect(mockUpsertInstall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        owner: { kind: 'agent', localId: 'agent_model_reviewer' },
        packageDigest: digest,
      }),
    );
  });

  it('rolls back subject finalization when package preflight rejects the download', async () => {
    const value = manifest();
    const digest = await computePipelinePackageDigest(value);
    const rollbackFinalization = jest.fn(() => Promise.resolve());

    await expect(
      installSubjectCapabilityPackage({
        owner: { kind: 'agent', localId: 'agent_model_reviewer' },
        packageRef: { version: 1, digest: `pp:v1:${'B'.repeat(43)}` },
        download: { digest, manifest: value },
        fetchBlob: (sha256) => {
          const bytes = blobs.get(sha256);
          if (!bytes) throw new Error(`missing blob ${sha256}`);
          return Promise.resolve(bytes);
        },
        rollbackFinalization,
      }),
    ).rejects.toThrow(/changed/i);

    expect(rollbackFinalization).toHaveBeenCalledTimes(1);
  });

  // An install silently replacing local work is the worst outcome available
  // here, so a taken name must deduplicate rather than overwrite.
  it('never overwrites a sibling name the recipient already uses', async () => {
    const digest = await serve(manifest());
    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });
    const existing = join(skillsRoot.path, 'custom-app', 'sibling');
    await mkdir(existing, { recursive: true });
    await writeFile(join(existing, 'SKILL.md'), 'MINE', 'utf8');

    const result = await install(digest);

    expect(result.installedDependencies).toEqual([
      { name: 'sibling', localName: 'sibling-2' },
    ]);
    expect(await readFile(join(existing, 'SKILL.md'), 'utf8')).toBe('MINE');
    expect(
      await readFile(
        join(skillsRoot.path, 'custom-app', 'sibling-2', 'SKILL.md'),
        'utf8',
      ),
    ).toContain('Sibling');
  });

  it('refuses a manifest whose digest does not match the reviewed ref', async () => {
    await serve(manifest());

    await expect(install(`pp:v1:${'B'.repeat(43)}`)).rejects.toThrow(
      /changed/i,
    );
  });

  it('reports packaged plugin resources instead of dropping them silently', async () => {
    const commandBlob = blob('# command');
    const withPlugin = manifest();
    withPlugin.resources.push({
      id: 'plugin-command',
      kind: 'plugin_command',
      displayName: '/deploy',
      sourceLabel: 'acme-tools',
      sourceVisibility: 'private',
      invocationKeys: ['/deploy'],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'claude',
          runtimeKind: 'plugin_fragment',
          rootName: 'acme-tools',
          entries: [
            { path: 'commands/deploy.md', mode: 'read', ...commandBlob },
          ],
        },
      ],
    });
    const binding = withPlugin.bindings[0];
    if (!binding) throw new Error('Fixture binding is missing');
    binding.resourceIds = ['primary', 'plugin-command'];
    withPlugin.totalFiles += 1;
    withPlugin.totalBytes += commandBlob.size;
    const digest = await serve(withPlugin);
    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });

    const result = await install(digest);

    expect(result.uninstalledResourceLabels).toEqual(['/deploy']);
  });

  // These arrive from the renderer and reach a bare `path.join`, so an
  // escape must be refused before any write happens.
  it.each(['../evil', 'nested/child', '..', ''])(
    'refuses the unsafe skill folder name %p',
    async (skillName) => {
      const digest = await serve(manifest());

      await expect(
        installSkillCapabilityPackage({
          remoteId: '00000000-0000-4000-8000-000000000001',
          skillName,
          primaryRootName: 'helper',
          packageRef: { version: 1, digest },
        }),
      ).rejects.toThrow(/Invalid skillName/);
    },
  );

  // Re-importing the same share must not pile up helper-2, helper-3, ...
  // The reused import path now runs this install, so every repeat import of a
  // Collection or a double-clicked Import would otherwise duplicate.
  it('reuses an identical sibling instead of suffixing on re-import', async () => {
    const digest = await serve(manifest());
    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });

    const first = await install(digest);
    const second = await install(digest);

    expect(first.installedDependencies).toEqual([
      { name: 'sibling', localName: 'sibling' },
    ]);
    expect(second.installedDependencies).toEqual(first.installedDependencies);
    // No sibling-2 folder was created.
    await expect(
      readFile(
        join(skillsRoot.path, 'custom-app', 'sibling-2', 'SKILL.md'),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  it('keeps the recipient files when it reuses an identical sibling folder', async () => {
    // The reuse branch exists so a re-import does not pile up `sibling-2`.
    // Reuse means writing into a folder the recipient already owns, so the
    // copy has to leave their files alone — a byte-identical SKILL.md proves
    // the *skill* is the same, not that every supporting file is.
    const recipientNotes = 'MY LOCAL WORK\n';
    const packagedNotes = 'PACKAGE VERSION\n';
    const siblingMd = '---\nname: sibling\n---\nSibling\n';
    const notes = blob(packagedNotes);
    const withSiblingNotes = manifest();
    const sibling = withSiblingNotes.resources[1];
    if (!sibling) throw new Error('fixture is missing the sibling resource');
    const siblingTree = sibling.trees[0];
    if (!siblingTree) throw new Error('fixture sibling has no tree');
    siblingTree.entries = [
      ...siblingTree.entries,
      { path: 'references/notes.md', mode: 'read', ...notes },
    ];
    withSiblingNotes.totalFiles += 1;
    withSiblingNotes.totalBytes += notes.size;
    const digest = await serve(withSiblingNotes);

    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });
    // Pre-existing sibling: identical SKILL.md, plus the recipient's own file
    // at a path the package also carries.
    await mkdir(join(skillsRoot.path, 'custom-app', 'sibling', 'references'), {
      recursive: true,
    });
    await writeFile(
      join(skillsRoot.path, 'custom-app', 'sibling', 'SKILL.md'),
      siblingMd,
      'utf8',
    );
    await writeFile(
      join(skillsRoot.path, 'custom-app', 'sibling', 'references', 'notes.md'),
      recipientNotes,
      'utf8',
    );

    await install(digest);

    await expect(
      readFile(
        join(
          skillsRoot.path,
          'custom-app',
          'sibling',
          'references',
          'notes.md',
        ),
        'utf8',
      ),
    ).resolves.toBe(recipientNotes);
  });

  it("keeps the recipient's files in the imported skill's own folder", async () => {
    // A re-import (or a recipient who first took the definition-only version)
    // reaches this with a folder that already holds their own files. The
    // package fills in what is missing; it never replaces what is there.
    const digest = await serve(manifest());
    const helperDir = join(skillsRoot.path, 'custom-app', 'helper');
    await mkdir(join(helperDir, 'references'), { recursive: true });
    await writeFile(join(helperDir, 'references', 'guide.md'), 'MY GUIDE\n');

    const result = await install(digest);

    await expect(
      readFile(join(helperDir, 'references', 'guide.md'), 'utf8'),
    ).resolves.toBe('MY GUIDE\n');
    // Kept silently would leave the recipient believing they have the
    // publisher's version, so the kept path is reported.
    expect(result.keptLocalFiles).toEqual(['helper/references/guide.md']);
  });

  it('does not report an existing file identical to the packaged one', async () => {
    const digest = await serve(manifest());
    const helperDir = join(skillsRoot.path, 'custom-app', 'helper');
    await mkdir(join(helperDir, 'references'), { recursive: true });
    await writeFile(join(helperDir, 'references', 'guide.md'), 'guide');

    const result = await install(digest);

    expect(result.keptLocalFiles).toEqual([]);
  });

  it('finds the shared skill by content when its packaged folder name differs', async () => {
    // The package tree carries the publisher's LOCAL folder name, which is
    // suffixed whenever they had imported the skill themselves (`helper-2`),
    // while the recipient's import is named from the frontmatter (`helper`).
    const renamed = manifest();
    const primary = renamed.resources[0];
    const primaryTree = primary?.trees[0];
    const skillMdEntry = primaryTree?.entries.find(
      (entry) => entry.path === 'SKILL.md',
    );
    if (!primaryTree || !skillMdEntry) throw new Error('fixture changed');
    primaryTree.rootName = 'helper-2';
    renamed.pipelineContentHash = skillMdEntry.sha256;
    const digest = await serve(renamed);
    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });

    const result = await install(digest);

    // Supporting files land beside the imported skill...
    await expect(
      readFile(
        join(skillsRoot.path, 'custom-app', 'helper', 'references', 'guide.md'),
        'utf8',
      ),
    ).resolves.toBe('guide');
    // ...and the shared skill is not installed a second time as a dependency.
    expect(result.installedDependencies).toEqual([
      { name: 'sibling', localName: 'sibling' },
    ]);
    await expect(
      readFile(
        join(skillsRoot.path, 'custom-app', 'helper-2', 'SKILL.md'),
        'utf8',
      ),
    ).rejects.toThrow();
  });

  // A failure partway through must not leave earlier work behind: supporting
  // files already copied beside the imported skill, and dependencies already
  // installed, while the ledger (written only on success) records nothing.
  it('rolls back everything a failed install created, and nothing else', async () => {
    const digest = await serve(manifest());
    const helperDir = join(skillsRoot.path, 'custom-app', 'helper');
    await mkdir(helperDir, { recursive: true });
    // The recipient's own file in the imported skill's folder must survive.
    await writeFile(join(helperDir, 'mine.md'), 'MINE', 'utf8');

    // The real module object, so the spy is seen by the code under test.
    const fsPromises =
      jest.requireActual<typeof FsPromisesModule>('node:fs/promises');
    const realWriteFile = fsPromises.writeFile;
    const spy = jest
      .spyOn(fsPromises, 'writeFile')
      .mockImplementation((file, data, options) =>
        typeof file === 'string' &&
        file.includes(join('custom-app', 'sibling', 'SKILL.md'))
          ? Promise.reject(new Error('disk full'))
          : realWriteFile(file, data, options),
      );
    try {
      await expect(install(digest)).rejects.toThrow('disk full');
    } finally {
      spy.mockRestore();
    }

    // The supporting file copied before the failure is gone, along with the
    // `references/` folder this install created to hold it...
    await expect(
      readFile(join(helperDir, 'references', 'guide.md'), 'utf8'),
    ).rejects.toThrow();
    await expect(stat(join(helperDir, 'references'))).rejects.toThrow();
    // ...as is the dependency folder this install created...
    await expect(
      readFile(join(skillsRoot.path, 'custom-app', 'sibling', 'SKILL.md')),
    ).rejects.toThrow();
    // ...but the recipient's own file is untouched, and nothing was recorded.
    await expect(readFile(join(helperDir, 'mine.md'), 'utf8')).resolves.toBe(
      'MINE',
    );
    expect(mockUpsertInstall).not.toHaveBeenCalled();
  });

  it('rolls back copied resources when recording install provenance fails', async () => {
    const value = manifest();
    const digest = await serve(value);
    let finalized = false;
    const finalizeInstall = jest.fn<
      Promise<string>,
      [InstallSubjectCapabilityPackageResult]
    >(() => {
      finalized = true;
      return Promise.resolve('final-local-hash');
    });
    const rollbackFinalization = jest.fn(() => {
      finalized = false;
      return Promise.resolve();
    });
    mockUpsertInstall.mockRejectedValueOnce(new Error('ledger read-only'));

    await expect(
      installSubjectCapabilityPackage({
        owner: { kind: 'agent', localId: 'agent_model_reviewer' },
        packageRef: { version: 1, digest },
        download: { digest, manifest: value },
        fetchBlob: (sha256) => {
          const bytes = blobs.get(sha256);
          if (!bytes) throw new Error(`missing blob ${sha256}`);
          return Promise.resolve(bytes);
        },
        finalizeInstall,
        rollbackFinalization,
      }),
    ).rejects.toThrow('ledger read-only');

    expect(finalizeInstall.mock.calls[0]?.[0].installedSkills).toContainEqual({
      name: 'helper',
      localName: 'helper',
    });
    expect(rollbackFinalization).toHaveBeenCalledTimes(1);
    expect(finalized).toBe(false);
    await expect(
      readFile(
        join(skillsRoot.path, 'custom-app', 'helper', 'references', 'guide.md'),
        'utf8',
      ),
    ).rejects.toThrow();
    await expect(
      stat(join(skillsRoot.path, 'custom-app', 'helper')),
    ).rejects.toThrow();
    await expect(
      readFile(join(skillsRoot.path, 'custom-app', 'sibling', 'SKILL.md')),
    ).rejects.toThrow();
    expect(mockUpsertInstall).toHaveBeenCalledTimes(1);
    expect(mockUpsertInstall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ localContentHash: 'final-local-hash' }),
    );
  });

  // The analysis emits one resource per provider for the shared skill itself
  // (a Claude tree and a Codex tree), so the skill appears TWICE in the
  // manifest. Only one can be the primary by id; the twin must not be
  // installed as a dependency of itself — which, whenever the recipient's
  // folder name differs from the publisher's, created a duplicate skill.
  it('does not install the shared skill a second time from its other provider tree', async () => {
    const twin = manifest();
    const primary = twin.resources[0];
    const primaryTree = primary?.trees[0];
    const skillMd = primaryTree?.entries.find(
      (entry) => entry.path === 'SKILL.md',
    );
    if (!primary || !primaryTree || !skillMd)
      throw new Error('fixture changed');
    primaryTree.rootName = 'helper-2';
    twin.pipelineContentHash = skillMd.sha256;
    twin.resources.push({
      ...primary,
      id: 'primary-codex',
      invocationKeys: ['$helper'],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'codex',
          runtimeKind: 'standalone_skill',
          rootName: 'helper-2',
          entries: [skillMd],
        },
      ],
    });
    const binding = twin.bindings[0];
    if (!binding) throw new Error('fixture changed');
    twin.bindings = [
      { target: 'subject', resourceIds: ['primary', 'primary-codex'] },
    ];
    twin.totalFiles += 1;
    twin.totalBytes += skillMd.size;
    const digest = await serve(twin);
    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });

    const result = await install(digest);

    expect(result.installedDependencies).toEqual([
      { name: 'sibling', localName: 'sibling' },
    ]);
    await expect(
      readFile(join(skillsRoot.path, 'custom-app', 'helper-2', 'SKILL.md')),
    ).rejects.toThrow();
  });

  // The twin trees can carry different versions of a supporting file. The
  // second one meets a file THIS install just wrote, which is not the
  // recipient's, so it must not be reported as "your version was kept".
  it('does not report a file its other provider tree already wrote as kept', async () => {
    const twin = manifest();
    const primary = twin.resources[0];
    const primaryTree = primary?.trees[0];
    const skillMd = primaryTree?.entries.find(
      (entry) => entry.path === 'SKILL.md',
    );
    if (!primary || !primaryTree || !skillMd)
      throw new Error('fixture changed');
    twin.pipelineContentHash = skillMd.sha256;
    const codexGuide = blob('codex guide');
    twin.resources.push({
      ...primary,
      id: 'primary-codex',
      invocationKeys: ['$helper'],
      dependencyResourceIds: [],
      trees: [
        {
          provider: 'codex',
          runtimeKind: 'standalone_skill',
          rootName: 'helper',
          entries: [
            skillMd,
            { path: 'references/guide.md', mode: 'read', ...codexGuide },
          ],
        },
      ],
    });
    twin.bindings = [
      { target: 'subject', resourceIds: ['primary', 'primary-codex'] },
    ];
    twin.totalFiles += 2;
    twin.totalBytes += skillMd.size + codexGuide.size;
    const digest = await serve(twin);
    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });

    const result = await install(digest);

    expect(result.keptLocalFiles).toEqual([]);
  });

  it('records the install against a skill owner', async () => {
    const digest = await serve(manifest());
    await mkdir(join(skillsRoot.path, 'custom-app', 'helper'), {
      recursive: true,
    });

    await install(digest);

    expect(mockUpsertInstall).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        owner: { kind: 'skill', localId: 'helper' },
        packageDigest: digest,
      }),
    );
  });
});
