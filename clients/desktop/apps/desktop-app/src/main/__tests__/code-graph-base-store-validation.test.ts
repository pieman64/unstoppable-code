/**
 * Main-process readers of a published code-graph base must not open SQLite.
 *
 * `readPublishedCodeGraphBase` defaults to `validation: 'full'`, which walks
 * every page of the base database, and even `metadata-only` opens the database
 * synchronously. These bases reach 1–1.6 GB, so on the Electron main thread
 * either blocks the event loop on `pread`. Main callers therefore request
 * `manifest-only`: the atomically installed manifest of an immutable,
 * integrity-checked generation plus a file-existence check. The utility
 * process that consumes the database validates it before use.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const readPublishedCodeGraphBase = jest.fn();

jest.mock('@canopy/code-graph/base-graph', () => ({
  readPublishedCodeGraphBase: (input: unknown): unknown =>
    readPublishedCodeGraphBase(input),
  codeGraphBaseVariantHash: (): string => 'variant-hash',
  getCodeGraphBaseVariantDir: (shadowDir: string): string =>
    `${shadowDir}/variant`,
}));

jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: (candidate: string): Promise<string> =>
    Promise.resolve(candidate),
}));

jest.mock('../lib/repo-shadow', () => ({
  getRepoShadowDir: (canonicalRepoRoot: string): string =>
    `/shadows/${encodeURIComponent(canonicalRepoRoot)}`,
}));

import {
  copyCompatibleCodeGraphBaseForSeed,
  readCompatibleCodeGraphBase,
} from '../lib/code-graph-base-store';

/**
 * The third main-process call site lives in `code-graph-base-manager.ts`
 * (base maintenance). It is asserted statically rather than by
 * execution: reaching it needs the manager's full sidebar/shadow/git-head
 * setup, and the property that must not regress is simply that the call opts
 * out of the page rescan.
 */
const BASE_MANAGER_SOURCE = readFileSync(
  path.join(__dirname, '..', 'lib', 'code-graph-base-manager.ts'),
  'utf8',
);

describe('main-process published code-graph base reads', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'code-graph-base-store-'));
    readPublishedCodeGraphBase.mockReset();
    // Returning null short-circuits each caller right after the read, which is
    // all these assertions need.
    readPublishedCodeGraphBase.mockResolvedValue(null);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('requests manifest-only validation when reading a compatible base', async () => {
    await readCompatibleCodeGraphBase({
      canonicalRepoRoot: '/repo',
      repoId: 'repo',
      customLanguagesFingerprint: 'none',
    });

    expect(readPublishedCodeGraphBase).toHaveBeenCalledTimes(1);
    expect(readPublishedCodeGraphBase).toHaveBeenCalledWith(
      expect.objectContaining({ validation: 'manifest-only' }),
    );
  });

  it('requests manifest-only validation when copying a base for seeding', async () => {
    await copyCompatibleCodeGraphBaseForSeed({
      canonicalRepoPath: '/repo',
      repoId: 'repo',
      customLanguagesFingerprint: 'none',
      destinationRootPath: path.join(root, 'destination'),
      seedStagingDir: path.join(root, 'staging'),
    });

    expect(readPublishedCodeGraphBase).toHaveBeenCalledTimes(1);
    expect(readPublishedCodeGraphBase).toHaveBeenCalledWith(
      expect.objectContaining({ validation: 'manifest-only' }),
    );
  });

  it('keeps base maintenance reads off main-thread SQLite', () => {
    const calls = BASE_MANAGER_SOURCE.match(/readPublishedCodeGraphBase\(/g);
    expect(calls).not.toBeNull();
    // Every occurrence must request manifest-only validation before the
    // call's closing brace.
    for (const segment of BASE_MANAGER_SOURCE.split(
      'readPublishedCodeGraphBase(',
    ).slice(1)) {
      expect(segment.slice(0, segment.indexOf('})'))).toContain(
        "validation: 'manifest-only'",
      );
    }
  });
});
