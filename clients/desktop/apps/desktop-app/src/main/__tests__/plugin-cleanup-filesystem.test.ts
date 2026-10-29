import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const getChatPluginsRootDirMock = jest.fn<string, []>();

jest.mock('../lib/paths', () => ({
  getChatPluginsRootDir: (): string => getChatPluginsRootDirMock(),
  getChatSkillPluginDir: (
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): string =>
    path.join(getChatPluginsRootDirMock(), projectId, worktreeId, chatId),
}));

import { cleanupWorktreeChatPluginDirs } from '../plugins/plugin-cleanup';

describe('plugin cleanup filesystem behavior', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-plugin-cleanup-'));
    getChatPluginsRootDirMock.mockReturnValue(
      path.join(tempDir, 'chat-plugins'),
    );
  });

  afterEach(() => {
    getChatPluginsRootDirMock.mockReset();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes linked generated state without deleting the link target', () => {
    const realClaudeDir = path.join(tempDir, 'real-home', '.claude');
    fs.mkdirSync(realClaudeDir, { recursive: true });
    const credentialsPath = path.join(realClaudeDir, '.credentials.json');
    fs.writeFileSync(credentialsPath, '{"token":"present"}\n', 'utf8');

    const worktreePluginDir = path.join(
      getChatPluginsRootDirMock(),
      'project-1',
      'worktree-1',
    );
    const generatedStateDir = path.join(worktreePluginDir, 'generated-state');
    fs.mkdirSync(generatedStateDir, { recursive: true });
    fs.symlinkSync(
      realClaudeDir,
      path.join(generatedStateDir, '.claude'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    cleanupWorktreeChatPluginDirs('project-1', 'worktree-1');

    expect(fs.existsSync(worktreePluginDir)).toBe(false);
    expect(fs.existsSync(realClaudeDir)).toBe(true);
    expect(fs.existsSync(credentialsPath)).toBe(true);
    expect(fs.readFileSync(credentialsPath, 'utf8')).toBe(
      '{"token":"present"}\n',
    );
  });
});
