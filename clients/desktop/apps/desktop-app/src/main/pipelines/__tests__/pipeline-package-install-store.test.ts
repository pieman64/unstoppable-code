import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as atomicFile from '../../lib/atomic-file';
import {
  findCapabilityPackageInstallByOwner,
  insertCapabilityPackageInstallIfAbsent,
  listCapabilityPackageInstalls,
  findPipelinePackageInstall,
  listPipelinePackageInstalls,
  removePipelinePackageInstall,
  repinCapabilityPackageInstallLocalContent,
  upsertCapabilityPackageInstall,
  upsertPipelinePackageInstall,
} from '../pipeline-package-install-store';

describe('pipeline package install store', () => {
  it('round-trips incomplete skill materialization without losing the retryable state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skill-package-completion-'));
    const storePath = join(root, 'installs.json');
    try {
      await upsertCapabilityPackageInstall(storePath, {
        owner: { kind: 'skill', localId: 'helper' },
        originExternalId: 'source',
        pipelineContentHash: 'a'.repeat(64),
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        installedAt: '2026-10-29T12:00:00Z',
        supportingFilesComplete: false,
      });
      await expect(listCapabilityPackageInstalls(storePath)).resolves.toEqual([
        expect.objectContaining({ supportingFilesComplete: false }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('persists one idempotent record per local pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      const first = {
        localPipelineId: 'local-1',
        originExternalId: 'share-1',
        pipelineContentHash: 'a'.repeat(64),
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        installedAt: '2026-08-30T12:00:00.000Z',
      };
      await upsertPipelinePackageInstall(storePath, first);
      await upsertPipelinePackageInstall(storePath, {
        ...first,
        installedAt: '2026-08-30T12:01:00.000Z',
      });

      await expect(listPipelinePackageInstalls(storePath)).resolves.toEqual([
        { ...first, installedAt: '2026-08-30T12:01:00.000Z' },
      ]);
      await expect(
        findPipelinePackageInstall(storePath, {
          originExternalId: 'share-1',
          pipelineContentHash: 'a'.repeat(64),
          packageDigest: `pp:v1:${'A'.repeat(43)}`,
        }),
      ).resolves.toMatchObject({ localPipelineId: 'local-1' });
      expect(JSON.parse(await readFile(storePath, 'utf8'))).toMatchObject({
        version: 1,
        records: [
          {
            owner: { kind: 'pipeline', localPipelineId: 'local-1' },
          },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists and resolves automation-owned capability packages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'automation-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      await upsertCapabilityPackageInstall(storePath, {
        owner: { kind: 'automation', localAutomationId: 'automation-1' },
        originExternalId: 'share-1',
        localContentHash: 'a'.repeat(64),
        pipelineContentHash: 'd'.repeat(64),
        packageDigest: `pp:v1:${'D'.repeat(43)}`,
        installedAt: '2026-09-18T12:00:00.000Z',
      });

      await expect(
        findCapabilityPackageInstallByOwner(storePath, {
          kind: 'automation',
          localAutomationId: 'automation-1',
        }),
      ).resolves.toMatchObject({
        owner: { kind: 'automation', localAutomationId: 'automation-1' },
        localContentHash: 'a'.repeat(64),
        packageDigest: `pp:v1:${'D'.repeat(43)}`,
      });
      await expect(listPipelinePackageInstalls(storePath)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    'skill',
    'agent',
    'collection',
    'blueprint',
    'shared-container',
  ] as const)(
    'persists and resolves a %s-owned capability package',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), `${kind}-package-ledger-`));
      const storePath = join(root, 'installs.json');
      try {
        const owner = { kind, localId: `${kind}-1` };
        await upsertCapabilityPackageInstall(storePath, {
          owner,
          originExternalId: 'share-1',
          pipelineContentHash: 'c'.repeat(64),
          packageDigest: `pp:v1:${'C'.repeat(43)}`,
          installedAt: '2026-09-22T12:00:00.000Z',
        });

        await expect(
          findCapabilityPackageInstallByOwner(storePath, owner),
        ).resolves.toMatchObject({ owner, originExternalId: 'share-1' });
        // A pipeline ledger read must not see a foreign owner's row.
        await expect(listPipelinePackageInstalls(storePath)).resolves.toEqual(
          [],
        );
        expect(
          JSON.parse(await readFile(storePath, 'utf8')) as unknown,
        ).toMatchObject({ records: [{ owner }] });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps ids in different owner namespaces distinct', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixed-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      const common = {
        pipelineContentHash: 'd'.repeat(64),
        packageDigest: `pp:v1:${'D'.repeat(43)}`,
        installedAt: '2026-09-22T12:00:00.000Z',
      };
      await upsertCapabilityPackageInstall(storePath, {
        owner: { kind: 'skill', localId: 'shared-id' },
        ...common,
      });
      await upsertCapabilityPackageInstall(storePath, {
        owner: { kind: 'agent', localId: 'shared-id' },
        ...common,
      });

      await expect(
        listCapabilityPackageInstalls(storePath),
      ).resolves.toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('migrates legacy pipeline-owner rows while reading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      await import('node:fs/promises').then(({ writeFile }) =>
        writeFile(
          storePath,
          JSON.stringify({
            version: 1,
            records: [
              {
                localPipelineId: 'legacy-pipeline',
                pipelineContentHash: 'e'.repeat(64),
                packageDigest: `pp:v1:${'E'.repeat(43)}`,
                installedAt: '2026-09-18T12:00:00.000Z',
              },
            ],
          }),
          'utf8',
        ),
      );
      await expect(listPipelinePackageInstalls(storePath)).resolves.toEqual([
        expect.objectContaining({ localPipelineId: 'legacy-pipeline' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('removes records idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      await upsertPipelinePackageInstall(storePath, {
        localPipelineId: 'local-1',
        pipelineContentHash: 'b'.repeat(64),
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-08-30T12:00:00.000Z',
      });
      await removePipelinePackageInstall(storePath, 'local-1');
      await removePipelinePackageInstall(storePath, 'local-1');
      await expect(listPipelinePackageInstalls(storePath)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists definition-only provenance without a package digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      const record = {
        localPipelineId: 'local-definition-only',
        originExternalId: 'share-definition-only',
        pipelineContentHash: 'c'.repeat(64),
        distributionMode: 'definition_only' as const,
        installedAt: '2026-08-30T12:00:00.000Z',
      };
      await upsertPipelinePackageInstall(storePath, record);

      await expect(listPipelinePackageInstalls(storePath)).resolves.toEqual([
        record,
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent mutations without dropping records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          upsertPipelinePackageInstall(storePath, {
            localPipelineId: `local-${index}`,
            pipelineContentHash: index.toString(16).padStart(64, '0'),
            packageDigest: `pp:v1:${String.fromCharCode(65 + index).repeat(43)}`,
            installedAt: '2026-08-30T12:00:00.000Z',
          }),
        ),
      );

      await expect(
        listPipelinePackageInstalls(storePath),
      ).resolves.toHaveLength(12);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('atomically preserves a package record when definition-only provenance loses the race', async () => {
    const root = await mkdtemp(join(tmpdir(), 'capability-package-ledger-'));
    const storePath = join(root, 'installs.json');
    const owner = { kind: 'skill' as const, localId: 'helper' };
    try {
      await Promise.all([
        upsertCapabilityPackageInstall(storePath, {
          owner,
          originExternalId: 'packaged-share',
          pipelineContentHash: 'a'.repeat(64),
          packageDigest: `pp:v1:${'A'.repeat(43)}`,
          distributionMode: 'package',
          installedAt: '2026-09-24T00:00:00.000Z',
        }),
        insertCapabilityPackageInstallIfAbsent(storePath, {
          owner,
          originExternalId: 'definition-share',
          pipelineContentHash: 'b'.repeat(64),
          distributionMode: 'definition_only',
          installedAt: '2026-09-24T00:00:01.000Z',
        }),
      ]);

      await expect(
        findCapabilityPackageInstallByOwner(storePath, owner),
      ).resolves.toMatchObject({
        originExternalId: 'packaged-share',
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Previously this threw `Invalid pipeline package install store`, taking the
  // whole ledger down over one bad row. No call site catches it, so the
  // realistic trigger — install a packaged skill, then downgrade to a build
  // whose record parser predates skill owners — hard-failed every pipeline and
  // automation package resolution. Degrading to defaults matches the repo's
  // persistence rule and is strictly less harmful than refusing to function.
  // CAN-5479: a converted chat automation's install keeps its share check.
  it('repins an install’s local content only while it still pins the expected hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-repin-'));
    const storePath = join(root, 'installs.json');
    const owner = {
      kind: 'automation' as const,
      localAutomationId: 'automation-1',
    };
    try {
      await upsertCapabilityPackageInstall(storePath, {
        owner,
        localContentHash: 'b'.repeat(64),
        pipelineContentHash: 'a'.repeat(64),
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        installedAt: '2026-10-29T12:00:00Z',
      });
      await expect(
        repinCapabilityPackageInstallLocalContent(
          storePath,
          owner,
          'a'.repeat(64),
          'c'.repeat(64),
        ),
      ).resolves.toBe(false);
      await expect(
        repinCapabilityPackageInstallLocalContent(
          storePath,
          owner,
          'b'.repeat(64),
          'c'.repeat(64),
        ),
      ).resolves.toBe(true);
      await expect(
        findCapabilityPackageInstallByOwner(storePath, owner),
      ).resolves.toMatchObject({
        localContentHash: 'c'.repeat(64),
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
      });
      await expect(
        repinCapabilityPackageInstallLocalContent(
          storePath,
          { kind: 'automation', localAutomationId: 'missing' },
          'c'.repeat(64),
          'd'.repeat(64),
        ),
      ).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads past a record it cannot parse instead of discarding the ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      const good = {
        owner: { kind: 'pipeline' as const, localPipelineId: 'local-1' },
        originExternalId: 'share-1',
        pipelineContentHash: 'a'.repeat(64),
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        installedAt: '2026-08-30T12:00:00.000Z',
      };
      const fromANewerBuild = { owner: { kind: 'future', localId: 'x' } };
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        storePath,
        JSON.stringify({ version: 1, records: [fromANewerBuild, good] }),
        'utf8',
      );

      await expect(
        listCapabilityPackageInstalls(storePath),
      ).resolves.toHaveLength(1);

      // And a write must carry the unreadable row through rather than deleting
      // whatever the newer build recorded.
      await upsertCapabilityPackageInstall(storePath, {
        owner: { kind: 'skill', localId: 'helper' },
        originExternalId: 'share-2',
        pipelineContentHash: 'b'.repeat(64),
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-08-30T12:02:00.000Z',
      });
      // Unreadable rows are appended after the ones this build understands.
      expect(JSON.parse(await readFile(storePath, 'utf8'))).toMatchObject({
        records: [
          { owner: { kind: 'pipeline', localPipelineId: 'local-1' } },
          { owner: { kind: 'skill', localId: 'helper' } },
          { owner: { kind: 'future', localId: 'x' } },
        ],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the newest of two rows for one owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      const row = (installedAt: string): Record<string, unknown> => ({
        owner: { kind: 'pipeline', localPipelineId: 'local-1' },
        pipelineContentHash: 'a'.repeat(64),
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        installedAt,
      });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(
        storePath,
        JSON.stringify({
          version: 1,
          records: [
            row('2026-08-30T12:00:00.000Z'),
            row('2026-08-30T13:00:00.000Z'),
          ],
        }),
        'utf8',
      );

      await expect(listCapabilityPackageInstalls(storePath)).resolves.toEqual([
        expect.objectContaining({ installedAt: '2026-08-30T13:00:00.000Z' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies an unreadable ledger aside instead of writing over it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      const { readdir, writeFile } = await import('node:fs/promises');
      await writeFile(storePath, '{"version":1,"records":[TRUNCATED', 'utf8');

      await upsertCapabilityPackageInstall(storePath, {
        owner: { kind: 'skill', localId: 'helper' },
        pipelineContentHash: 'b'.repeat(64),
        packageDigest: `pp:v1:${'B'.repeat(43)}`,
        installedAt: '2026-08-30T12:02:00.000Z',
      });

      const preserved = (await readdir(root)).filter((name) =>
        name.startsWith('installs.json.unreadable-'),
      );
      expect(preserved).toHaveLength(1);
      await expect(
        readFile(join(root, preserved[0] ?? ''), 'utf8'),
      ).resolves.toBe('{"version":1,"records":[TRUNCATED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('initializes empty when the ledger envelope itself is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(storePath, 'not json at all', 'utf8');

      await expect(listPipelinePackageInstalls(storePath)).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('never writes over a ledger from a newer version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    try {
      const { readdir, writeFile } = await import('node:fs/promises');
      const newer = JSON.stringify({ version: 2, records: [], owners: {} });
      await writeFile(storePath, newer, 'utf8');

      await expect(listCapabilityPackageInstalls(storePath)).resolves.toEqual(
        [],
      );
      await expect(
        upsertCapabilityPackageInstall(storePath, {
          owner: { kind: 'skill', localId: 'helper' },
          pipelineContentHash: 'b'.repeat(64),
          packageDigest: `pp:v1:${'B'.repeat(43)}`,
          installedAt: '2026-08-30T12:02:00.000Z',
        }),
      ).rejects.toThrow(
        'Pipeline package install ledger is from a newer version',
      );
      await expect(
        removePipelinePackageInstall(storePath, 'pipeline-1'),
      ).rejects.toThrow(
        'Pipeline package install ledger is from a newer version',
      );
      await expect(readFile(storePath, 'utf8')).resolves.toBe(newer);
      expect(await readdir(root)).toEqual(['installs.json']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('installs every ledger write durably', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    const write = jest.spyOn(atomicFile, 'writeFileAtomically');
    try {
      await upsertPipelinePackageInstall(storePath, {
        localPipelineId: 'pipeline-1',
        pipelineContentHash: 'a'.repeat(64),
        packageDigest: `pp:v1:${'A'.repeat(43)}`,
        installedAt: '2026-08-30T12:00:00.000Z',
      });
      await removePipelinePackageInstall(storePath, 'pipeline-1');
      expect(write).toHaveBeenCalledTimes(2);
      for (const call of write.mock.calls) {
        expect(call[0]).toBe(storePath);
        expect(call[2]).toMatchObject({ durable: true });
      }
    } finally {
      write.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('treats a record installed before its folder flush failed as written', async () => {
    const { StorageOutcomeUnknownError } =
      await import('@canopy/core-runtime/storage');
    const root = await mkdtemp(join(tmpdir(), 'pipeline-package-ledger-'));
    const storePath = join(root, 'installs.json');
    const real = atomicFile.writeFileAtomically;
    const write = jest
      .spyOn(atomicFile, 'writeFileAtomically')
      .mockImplementationOnce(async (target, data, options) => {
        await real(target, data, { ...options, durable: false });
        throw new StorageOutcomeUnknownError(
          'directory_flush',
          new Error('flush failed'),
        );
      });
    try {
      await expect(
        upsertPipelinePackageInstall(storePath, {
          localPipelineId: 'pipeline-1',
          pipelineContentHash: 'a'.repeat(64),
          packageDigest: `pp:v1:${'A'.repeat(43)}`,
          installedAt: '2026-08-30T12:00:00.000Z',
        }),
      ).resolves.toBeUndefined();
      expect(
        (await listPipelinePackageInstalls(storePath)).map(
          (record) => record.localPipelineId,
        ),
      ).toEqual(['pipeline-1']);
    } finally {
      write.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
