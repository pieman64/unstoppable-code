import { statSync } from 'node:fs';
import type * as InstructionFiles from '../instruction-files';
import { lstat, readFile, readlink, writeFile } from 'node:fs/promises';
import {
  loadWorkspaceClaudeMd,
  saveWorkspaceClaudeMd,
} from '../workspace-claude-md';
import { readWorkspaceConfig } from '../workspace-persistence';
import { getWorkspaceClaudeMdPath } from '../paths';
import { resolveWorkspaceReferenceRepoPath } from '../workspace-reference-repo';
import { ensureAgentsMdSymlink } from '../instruction-files';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  lstat: jest.fn(),
  readlink: jest.fn(),
}));
jest.mock('../workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
}));
jest.mock('../paths', () => ({
  getWorkspaceClaudeMdPath: jest.fn(
    (id: string) => `/data/workspaces/${id}/CLAUDE.md`,
  ),
}));
jest.mock('../instruction-files', () => ({
  ...jest.requireActual<typeof InstructionFiles>('../instruction-files'),
  ensureAgentsMdSymlink: jest.fn(),
}));
jest.mock('../workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));

const mockedReadFile = jest.mocked(readFile);
const mockedReadConfig = jest.mocked(readWorkspaceConfig);
const mockedPath = jest.mocked(getWorkspaceClaudeMdPath);

describe('loadWorkspaceClaudeMd', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repos: [],
    });
  });

  it('returns the file content when the file exists', async () => {
    mockedReadFile.mockResolvedValue('# hi\n');
    await expect(loadWorkspaceClaudeMd('ws-1')).resolves.toBe('# hi\n');
    expect(mockedPath).toHaveBeenCalledWith('ws-1');
  });

  it('returns empty string for a missing file (ENOENT)', async () => {
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('no such file'), { code: 'ENOENT' }),
    );
    await expect(loadWorkspaceClaudeMd('ws-1')).resolves.toBe('');
  });

  it('rethrows a non-ENOENT read error (does NOT coerce to empty)', async () => {
    // A real read error must NOT look like a confirmed-empty file — otherwise
    // the portal editor could Save empty back over the real CLAUDE.md.
    mockedReadFile.mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    await expect(loadWorkspaceClaudeMd('ws-1')).rejects.toThrow(
      'permission denied',
    );
  });

  it.each(['load', 'save'])(
    'preserves canonical AGENTS.md on %s in a source-backed project',
    async (operation) => {
      mockedReadConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        repos: [],
        sourceRepoPath: '/repo',
      });
      jest.mocked(resolveWorkspaceReferenceRepoPath).mockResolvedValue('/repo');
      jest.mocked(lstat).mockImplementation((filePath) => {
        if (filePath === '/repo/AGENTS.md') {
          return Promise.resolve(statSync(__filename));
        }
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      });
      mockedReadFile.mockImplementation((filePath) => {
        if (filePath === '/repo/AGENTS.md')
          return Promise.resolve('# Keep my project rules');
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      });

      if (operation === 'load') {
        await expect(loadWorkspaceClaudeMd('ws-1')).resolves.toBe(
          '# Keep my project rules',
        );
      } else {
        await saveWorkspaceClaudeMd(
          'ws-1',
          '# Keep my project rules\nUpdated',
          'test',
        );
        expect(writeFile).toHaveBeenCalledWith(
          '/repo/AGENTS.md',
          '# Keep my project rules\nUpdated',
          'utf8',
        );
      }
      expect(ensureAgentsMdSymlink).not.toHaveBeenCalled();
    },
  );
});

describe('source-backed instruction compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
      sourceRepoPath: '/repo',
    });
    jest.mocked(resolveWorkspaceReferenceRepoPath).mockResolvedValue('/repo');
  });

  it.each([
    'legacy-link',
    'reverse-link',
    'mirror-copy',
    'independent-files',
  ] as const)(
    'preserves %s when saving project instructions',
    async (layout) => {
      jest.mocked(lstat).mockImplementation((filePath) => {
        const entry = statSync(__filename);
        const isLink =
          layout === 'legacy-link'
            ? filePath === '/repo/AGENTS.md'
            : layout === 'reverse-link' && filePath === '/repo/CLAUDE.md';
        entry.isFile = (): boolean => !isLink;
        entry.isSymbolicLink = (): boolean => isLink;
        return Promise.resolve(entry);
      });
      jest
        .mocked(readlink)
        .mockImplementation((filePath) =>
          Promise.resolve(
            filePath === '/repo/AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md',
          ),
        );
      mockedReadFile.mockImplementation((filePath) =>
        Promise.resolve(
          layout === 'independent-files' && filePath === '/repo/CLAUDE.md'
            ? '# Claude-specific rules'
            : '# Shared rules',
        ),
      );
      await saveWorkspaceClaudeMd('ws-1', '# Updated shared rules', 'test');
      expect(writeFile).toHaveBeenCalledWith(
        `/repo/${layout === 'legacy-link' ? 'CLAUDE.md' : 'AGENTS.md'}`,
        '# Updated shared rules',
        'utf8',
      );
      if (layout === 'mirror-copy') {
        expect(writeFile).toHaveBeenCalledWith(
          '/repo/CLAUDE.md',
          '# Updated shared rules',
          'utf8',
        );
      } else {
        expect(writeFile).toHaveBeenCalledTimes(1);
      }
      expect(ensureAgentsMdSymlink).not.toHaveBeenCalled();
    },
  );

  it('refuses to write through an arbitrary AGENTS.md symlink', async () => {
    jest.mocked(lstat).mockImplementation((filePath) => {
      if (filePath === '/repo/AGENTS.md') {
        const entry = statSync(__filename);
        entry.isFile = (): boolean => false;
        entry.isSymbolicLink = (): boolean => true;
        return Promise.resolve(entry);
      }
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    jest.mocked(readlink).mockResolvedValue('../outside.md');
    await expect(
      saveWorkspaceClaudeMd('ws-1', '# Changed', 'test'),
    ).rejects.toThrow(/symbolic link/i);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
