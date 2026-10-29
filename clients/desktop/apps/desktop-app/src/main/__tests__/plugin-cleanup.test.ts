jest.mock('../lib/paths', () => ({
  getChatPluginsRootDir: jest.fn(() =>
    process.platform === 'win32'
      ? 'C:\\Users\\Tommy\\.canopy\\chat-plugins'
      : '/Users/Tommy/.canopy/chat-plugins',
  ),
  getChatSkillPluginDir: jest.fn(
    (projectId: string, worktreeId: string, chatId: string) =>
      process.platform === 'win32'
        ? `C:\\Users\\Tommy\\.canopy\\chat-plugins\\${projectId}\\${worktreeId}\\${chatId}`
        : `/Users/Tommy/.canopy/chat-plugins/${projectId}/${worktreeId}/${chatId}`,
  ),
}));

jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof FsModule>('node:fs'),
  rmSync: jest.fn(),
}));

import type * as FsModule from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  cleanupChatSkillPluginDir,
  cleanupWorktreeChatPluginDirs,
} from '../plugins/plugin-cleanup';

describe('plugin-cleanup', () => {
  let warnSpy: jest.SpiedFunction<typeof console.warn>;
  const rmMock = jest.mocked(fs.rmSync);

  beforeEach(() => {
    rmMock.mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    rmMock.mockReset();
    warnSpy.mockRestore();
  });

  it('removes generated plugin state recursively', () => {
    cleanupWorktreeChatPluginDirs('canopy', 'kudu');

    const root =
      process.platform === 'win32'
        ? 'C:\\Users\\Tommy\\.canopy\\chat-plugins'
        : '/Users/Tommy/.canopy/chat-plugins';
    expect(rmMock).toHaveBeenCalledWith(path.join(root, 'canopy', 'kudu'), {
      recursive: true,
      force: true,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not throw when generated state removal fails', () => {
    rmMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' });
    });

    expect(() =>
      cleanupChatSkillPluginDir('canopy', 'kudu', 'chat-1'),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      '[plugin-cleanup] Failed to remove generated plugin state',
      { code: 'EBUSY' },
    );
  });
});
