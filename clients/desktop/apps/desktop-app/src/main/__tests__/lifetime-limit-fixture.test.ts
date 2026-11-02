import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileDelegationStorage } from '@canopy/desktop-shared/node/delegation/storage';
import { isE2eBuild } from '../lib/e2e-gate';
import { configureManagedDelegationLifetimeService } from '../agents/delegation/service';
import { seedDelegationLifetimeLimitFixture } from '../e2e-fixtures/lifetime-limit-fixture';

let mockRoot = '';
jest.mock('../lib/e2e-gate', () => ({ isE2eBuild: jest.fn() }));
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: (): string => mockRoot,
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFileDetailed: (): Promise<object> =>
    Promise.resolve({ authority: 'ok', preferences: {} }),
}));
jest.mock('../agents/delegation/service', () => ({
  configureManagedDelegationLifetimeService: jest.fn(),
  ManagedDelegationLifetimeService: class {
    readonly cap: number;
    constructor(options: { measuredCap?: number }) {
      this.cap = options.measuredCap ?? 512;
    }
    normalize(): number {
      return this.cap === 512 ? 512 : 1024;
    }
  },
}));

describe('E2E-only lifetime composition', () => {
  beforeEach(async () => {
    mockRoot = await mkdtemp(join(tmpdir(), 'lifetime-fixture-'));
    jest.mocked(isE2eBuild).mockReturnValue(true);
    jest.mocked(configureManagedDelegationLifetimeService).mockClear();
  });
  afterEach(async () => {
    await rm(mockRoot, { recursive: true, force: true });
  });

  it('does nothing in a production build even with a configured nonexistent spec', async () => {
    jest.mocked(isE2eBuild).mockReturnValue(false);
    await seedDelegationLifetimeLimitFixture(join(mockRoot, 'does-not-exist'));
    expect(configureManagedDelegationLifetimeService).not.toHaveBeenCalled();
    expect(
      await new FileDelegationStorage(
        join(mockRoot, 'delegation', 'runs'),
      ).loadReadOnly(),
    ).toEqual({ records: [], missing: true });
  });

  it('injects the test cap before seeding deterministic, decodable retained identities only', async () => {
    const specPath = join(mockRoot, 'spec.json');
    await writeFile(
      specPath,
      JSON.stringify({
        version: 1,
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        measuredCap: 3072,
        retained: 2,
      }),
    );
    await seedDelegationLifetimeLimitFixture(specPath);
    expect(configureManagedDelegationLifetimeService).toHaveBeenCalledWith(
      expect.objectContaining({ cap: 3072 }),
    );
    const { records, missing } = await new FileDelegationStorage(
      join(mockRoot, 'delegation', 'runs'),
    ).loadReadOnly();
    expect(missing).toBe(false);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.state.delegationId).sort()).toEqual([
      '17000000-0000-4000-8000-000000000000',
      '17000000-0000-4000-8000-000000000001',
    ]);
    expect(records.every((record) => record.state.status === 'completed')).toBe(
      true,
    );
    await expect(
      readFile(join(mockRoot, 'delegation', 'lifetime-baseline.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
