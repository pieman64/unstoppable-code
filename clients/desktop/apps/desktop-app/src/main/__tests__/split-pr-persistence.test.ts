jest.mock('node:fs/promises');
jest.mock('../lib/paths', () => ({
  getWorkspaceSplitMapFilePath: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/split-maps/${worktreeId}.json`,
  ),
}));

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { SplitPrMap } from '@canopy/desktop-shared/types/github';
import {
  deleteSplitPrMapForWorktree,
  readSplitPrMap,
  writeSplitPrMap,
} from '../lib/split-pr-persistence';
import { getWorkspaceSplitMapFilePath } from '../lib/paths';

const mockedReadFile = jest.mocked(readFile);
const mockedWriteFile = jest.mocked(writeFile);
const mockedMkdir = jest.mocked(mkdir);
const mockedGetWorkspaceSplitMapFilePath = jest.mocked(
  getWorkspaceSplitMapFilePath,
);

const sampleMap: SplitPrMap = {
  version: 1,
  originalPrNumber: 42,
  originalPrUrl: 'https://github.com/org/repo/pull/42',
  originalBaseBranch: 'develop',
  originalHeadBranch: 'feature/big-pr',
  originalHeadSha: 'abc123',
  integrationBranch: 'split/feature-big-pr-integration',
  originalWorktreeId: 'wt-1',
  children: [],
  status: 'planning',
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

describe('split-pr-persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('readSplitPrMap', () => {
    it('round-trips a written map', async () => {
      mockedReadFile.mockResolvedValueOnce(
        JSON.stringify({ version: 1, map: sampleMap }),
      );

      const result = await readSplitPrMap('workspace-1', 'wt-1');

      expect(result).toEqual(sampleMap);
      expect(mockedReadFile).toHaveBeenCalledWith(
        '/mock/workspaces/workspace-1/split-maps/wt-1.json',
        'utf8',
      );
    });

    it('returns null for corrupt JSON', async () => {
      mockedReadFile.mockResolvedValueOnce('{not valid json');

      const result = await readSplitPrMap('workspace-1', 'wt-1');

      expect(result).toBeNull();
    });

    it('returns null for a version mismatch', async () => {
      mockedReadFile.mockResolvedValueOnce(
        JSON.stringify({ version: 2, map: sampleMap }),
      );

      const result = await readSplitPrMap('workspace-1', 'wt-1');

      expect(result).toBeNull();
    });

    it('returns null when the file is missing', async () => {
      mockedReadFile.mockRejectedValueOnce(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await readSplitPrMap('workspace-1', 'wt-1');

      expect(result).toBeNull();
    });

    it('round-trips the optional PR-content fields (originalPrTitle, prBodyBase, prTitleGenerated)', async () => {
      const enrichedMap: SplitPrMap = {
        ...sampleMap,
        originalPrTitle: 'Big multi-concern PR',
        children: [
          {
            index: 1,
            title: 'refactor: extract helper',
            type: 'refactor',
            branchName: 'split/child-01',
            baseBranch: 'split/feature-big-pr-integration',
            dependsOn: [],
            changes: [],
            prBodyBase: 'Generated body\n\n## Summary\n- did stuff',
            prTitleGenerated: 'Extract the shared helper',
          },
        ],
      };
      mockedReadFile.mockResolvedValueOnce(
        JSON.stringify({ version: 1, map: enrichedMap }),
      );

      const result = await readSplitPrMap('workspace-1', 'wt-1');

      expect(result).toEqual(enrichedMap);
      expect(result?.originalPrTitle).toBe('Big multi-concern PR');
      expect(result?.children[0]?.prBodyBase).toContain('Generated body');
      expect(result?.children[0]?.prTitleGenerated).toBe(
        'Extract the shared helper',
      );
    });
  });

  describe('writeSplitPrMap', () => {
    it('creates the parent directory before writing', async () => {
      mockedMkdir.mockResolvedValueOnce(undefined);
      mockedWriteFile.mockResolvedValueOnce(undefined);

      const result = await writeSplitPrMap('workspace-1', 'wt-1', sampleMap);

      expect(result).toBe(true);
      expect(mockedMkdir).toHaveBeenCalledWith(
        '/mock/workspaces/workspace-1/split-maps',
        { recursive: true },
      );
      expect(mockedWriteFile).toHaveBeenCalledWith(
        '/mock/workspaces/workspace-1/split-maps/wt-1.json',
        JSON.stringify({ version: 1, map: sampleMap }, null, 2),
        'utf8',
      );
      expect(mockedGetWorkspaceSplitMapFilePath).toHaveBeenCalledWith(
        'workspace-1',
        'wt-1',
      );
    });

    it('returns false when the write fails', async () => {
      mockedMkdir.mockResolvedValueOnce(undefined);
      mockedWriteFile.mockRejectedValueOnce(new Error('disk full'));

      const result = await writeSplitPrMap('workspace-1', 'wt-1', sampleMap);

      expect(result).toBe(false);
    });
  });

  describe('deleteSplitPrMapForWorktree', () => {
    it('removes the split map file', async () => {
      const { rm } = jest.requireMock<{
        rm: jest.Mock<Promise<void>, [string, unknown]>;
      }>('node:fs/promises');
      rm.mockResolvedValueOnce(undefined);

      await deleteSplitPrMapForWorktree('workspace-1', 'wt-1');

      expect(rm).toHaveBeenCalledWith(
        '/mock/workspaces/workspace-1/split-maps/wt-1.json',
        { force: true },
      );
    });
  });
});
