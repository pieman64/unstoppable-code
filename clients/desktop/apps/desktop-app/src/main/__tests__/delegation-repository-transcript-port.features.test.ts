import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeDelegationTranscriptPortConformance } from '@canopy/desktop-shared/node/delegation/testing/transcript-port-conformance';
import { createRepositoryTranscriptPortFixture } from './helpers/repository-transcript-port-fixture';

jest.setTimeout(240_000);

describe('repository delegation transcript registry features', () => {
  const roots: string[] = [];
  const cleanups: Array<() => Promise<void>> = [];
  const factory = Object.assign(
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'repository-features-'));
      roots.push(root);
      const fixture = await createRepositoryTranscriptPortFixture(root)();
      cleanups.push(fixture.close);
      return fixture;
    },
    {
      capabilities:
        createRepositoryTranscriptPortFixture('unused').capabilities,
    },
  );

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) await cleanup();
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });

  describeDelegationTranscriptPortConformance('repository', factory, {
    registry: true,
    durability: 'repository',
    features: { receipts: true, repair: true },
  });
});
