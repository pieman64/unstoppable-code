import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as PathsModule from '../lib/paths';

const tempDir = mkdtempSync(join(tmpdir(), 'code-review-registry-'));
const defaultRegistryPath = join(tempDir, 'registry.json');
let registryPathResolver = (): string => defaultRegistryPath;

jest.mock('../lib/paths', () => {
  const actual = jest.requireActual<typeof PathsModule>('../lib/paths');
  return {
    ...actual,
    getCodeReviewRegistryFilePath: (): string => registryPathResolver(),
  };
});

import {
  getCodeReviewTarget,
  getCodeReviewTargetSync,
  registerCodeReviewTarget,
  removeCodeReviewTarget,
} from '../lib/code-review-registry';

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('code-review registry', () => {
  beforeEach(() => {
    registryPathResolver = (): string => defaultRegistryPath;
  });

  it('returns null for unknown scopes', async () => {
    expect(await getCodeReviewTarget('missing-scope')).toBeNull();
    expect(getCodeReviewTargetSync('missing-scope')).toBeNull();
  });

  it('registers and resolves a target by scope key, async and sync', async () => {
    await registerCodeReviewTarget('proj-1--wt-1', {
      projectId: 'proj-1',
      worktreeId: 'wt-1',
    });
    expect(await getCodeReviewTarget('proj-1--wt-1')).toEqual({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
    });
    expect(getCodeReviewTargetSync('proj-1--wt-1')).toEqual({
      projectId: 'proj-1',
      worktreeId: 'wt-1',
    });
  });

  it('keys two projects sharing a worktree name separately', async () => {
    await registerCodeReviewTarget('proj-a--main', {
      projectId: 'proj-a',
      worktreeId: 'main',
    });
    await registerCodeReviewTarget('proj-b--main', {
      projectId: 'proj-b',
      worktreeId: 'main',
    });
    expect(getCodeReviewTargetSync('proj-a--main')).toEqual({
      projectId: 'proj-a',
      worktreeId: 'main',
    });
    expect(getCodeReviewTargetSync('proj-b--main')).toEqual({
      projectId: 'proj-b',
      worktreeId: 'main',
    });
  });

  it('overwrites an existing registration', async () => {
    await registerCodeReviewTarget('proj-1--wt-1', {
      projectId: 'proj-2',
      worktreeId: 'wt-1',
    });
    expect(getCodeReviewTargetSync('proj-1--wt-1')).toEqual({
      projectId: 'proj-2',
      worktreeId: 'wt-1',
    });
  });

  it('recreates the registry parent when it disappears before removal writes', async () => {
    await registerCodeReviewTarget('remove-me', {
      projectId: 'proj-remove',
      worktreeId: 'wt-remove',
    });
    const replacementPath = join(tempDir, 'recreated', 'registry.json');
    let pathRead = false;
    registryPathResolver = (): string => {
      if (!pathRead) {
        pathRead = true;
        return defaultRegistryPath;
      }
      return replacementPath;
    };

    await expect(removeCodeReviewTarget('remove-me')).resolves.toBeUndefined();
    registryPathResolver = (): string => replacementPath;
    await expect(getCodeReviewTarget('remove-me')).resolves.toBeNull();
  });
});
