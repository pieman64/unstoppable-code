import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs, {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { PipelinePackageManifestV1 } from '@canopy/protocol/pipelines';
import {
  assertPipelinePackageMatchesYaml,
  computePipelinePackageDigestSync,
  hashPipelinePackageYaml,
} from '../package-contract';
import {
  installPipelinePackageAtomically,
  verifyCachedPipelinePackage,
} from '../package-cache';

const rawPipeline = 'name: Example\n';
const bytes = new TextEncoder().encode('hello');
const blobHash = createHash('sha256').update(bytes).digest('hex');

function manifest(): PipelinePackageManifestV1 {
  return {
    version: 1,
    pipelineContentHash: hashPipelinePackageYaml(rawPipeline),
    resources: [
      {
        id: 'skill',
        kind: 'standalone_skill',
        displayName: 'Skill',
        sourceLabel: 'local',
        sourceVisibility: 'local',
        invocationKeys: ['$skill'],
        dependencyResourceIds: [],
        trees: [
          {
            provider: 'codex',
            runtimeKind: 'standalone_skill',
            rootName: 'skill',
            entries: [
              {
                path: 'SKILL.md',
                sha256: blobHash,
                size: bytes.length,
                mode: 'read',
              },
            ],
          },
        ],
      },
    ],
    bindings: [{ jobId: 'job', stepId: 'step', resourceIds: ['skill'] }],
    environmentRequirements: [],
    totalFiles: 1,
    totalBytes: bytes.length,
  };
}

describe('desktop pipeline package contract and cache', () => {
  it('matches exact YAML and computes the protocol digest synchronously', () => {
    const value = manifest();
    expect(computePipelinePackageDigestSync(value)).toMatch(/^pp:v1:/);
    expect(() =>
      assertPipelinePackageMatchesYaml(value, rawPipeline),
    ).not.toThrow();
    expect(() =>
      assertPipelinePackageMatchesYaml(value, `${rawPipeline}# changed`),
    ).toThrow('does not match');
  });

  it('verifies and atomically materializes a content-addressed package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-'));
    try {
      const value = manifest();
      const digest = computePipelinePackageDigestSync(value);
      const installed = await installPipelinePackageAtomically({
        packagesRoot: root,
        digest,
        manifest: value,
        fetchBlob: (sha256) => {
          expect(sha256).toBe(blobHash);
          return Promise.resolve(bytes);
        },
      });
      await expect(
        readFile(
          join(
            installed,
            'materialized',
            'skill',
            'codex',
            'skill',
            'SKILL.md',
          ),
          'utf8',
        ),
      ).resolves.toBe('hello');
      await expect(
        verifyCachedPipelinePackage(installed, digest),
      ).resolves.toEqual(value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('flushes staged package files through handles Windows can flush', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-flush-'));
    // Windows FlushFileBuffers rejects read-only regular-file handles. Keep
    // real disk I/O, but enforce that contract on every host.
    const open = fs.open;
    const syncedFiles: string[] = [];
    const openSpy = jest
      .spyOn(fs, 'open')
      .mockImplementation(async (path, flags, mode) => {
        const handle = await open(path, flags, mode);
        const sync = handle.sync.bind(handle);
        // Omitted flags default to read-only.
        const writable =
          typeof flags === 'number'
            ? (flags & (constants.O_WRONLY | constants.O_RDWR)) !== 0
            : /[wa+]/.test(flags ?? 'r');
        handle.sync = async (): Promise<void> => {
          if (!writable) {
            throw Object.assign(
              new Error('EPERM: operation not permitted, fsync'),
              { code: 'EPERM', syscall: 'fsync' },
            );
          }
          syncedFiles.push(basename(String(path)));
          await sync();
        };
        return handle;
      });
    try {
      const value = manifest();
      const digest = computePipelinePackageDigestSync(value);
      const installed = await installPipelinePackageAtomically({
        packagesRoot: root,
        digest,
        manifest: value,
        fetchBlob: () => Promise.resolve(bytes),
      });
      expect(syncedFiles).toEqual([
        blobHash,
        'manifest.json',
        '.pipeline-package-digest',
      ]);
      await expect(
        verifyCachedPipelinePackage(installed, digest),
      ).resolves.toEqual(value);
    } finally {
      openSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a cached package whose blob content was corrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-corrupt-'));
    try {
      const value = manifest();
      const digest = computePipelinePackageDigestSync(value);
      const installed = await installPipelinePackageAtomically({
        packagesRoot: root,
        digest,
        manifest: value,
        fetchBlob: () => Promise.resolve(bytes),
      });
      await writeFile(join(installed, 'blobs', blobHash), 'tampered', 'utf8');
      await expect(
        verifyCachedPipelinePackage(installed, digest),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('redownloads a package instead of reusing a corrupt cache entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-repair-'));
    try {
      const value = manifest();
      const digest = computePipelinePackageDigestSync(value);
      const installed = await installPipelinePackageAtomically({
        packagesRoot: root,
        digest,
        manifest: value,
        fetchBlob: () => Promise.resolve(bytes),
      });
      await writeFile(
        join(installed, 'materialized', 'skill', 'codex', 'skill', 'SKILL.md'),
        'tampered',
        'utf8',
      );
      const fetchBlob = jest.fn(() => Promise.resolve(bytes));

      await expect(
        installPipelinePackageAtomically({
          packagesRoot: root,
          digest,
          manifest: value,
          fetchBlob,
        }),
      ).resolves.toBe(installed);
      expect(fetchBlob).toHaveBeenCalledWith(blobHash);
      await expect(
        readFile(
          join(
            installed,
            'materialized',
            'skill',
            'codex',
            'skill',
            'SKILL.md',
          ),
          'utf8',
        ),
      ).resolves.toBe('hello');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('removes staged package files when context expires before the durable rename', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pipeline-package-fence-'));
  try {
    const value = manifest();
    const onCreated = jest.fn();
    await expect(
      installPipelinePackageAtomically({
        packagesRoot: root,
        digest: computePipelinePackageDigestSync(value),
        manifest: value,
        fetchBlob: () => Promise.resolve(bytes),
        beforeCommit: () =>
          Promise.reject(new Error('Pipeline unavailable (context-mismatch)')),
        onCreated,
      }),
    ).rejects.toThrow('Pipeline unavailable (context-mismatch)');
    expect(await readdir(join(root, 'packages'))).toEqual([]);
    expect(onCreated).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
