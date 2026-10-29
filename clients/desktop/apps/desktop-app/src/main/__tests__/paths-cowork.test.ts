jest.mock('@canopy/desktop-shared/canopy-paths', () => ({
  getCanopyDataDir: jest.fn(() => '/mock-data'),
}));

jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: jest.fn(() => null),
  getWorkspaceExternalPath: jest.fn(() => null),
}));

import {
  coworkWorkspaceRootDirFor,
  getWorkspaceHomeDir,
  getCoworkWorkspaceRootDir,
  getWorkspaceChatHistoryDir,
  getWorkspaceChatHistoryMetaFilePath,
  getWorkspaceChatHistorySummaryFilePath,
  getWorkspaceChatHistoryConversationFilePath,
  getWorkspaceDerivedDir,
  getWorkspaceDir,
} from '../lib/paths';
import { getWorkspaceExternalPath } from '../lib/workspace-registry';
import { join } from 'node:path';

const mockedGetWorkspaceExternalPath = jest.mocked(getWorkspaceExternalPath);

describe('cowork project paths', () => {
  const ws = getWorkspaceDir('cw-1');

  afterEach(() => {
    mockedGetWorkspaceExternalPath.mockReturnValue(null);
  });

  it('places the managed home inside the project dir', () => {
    expect(getWorkspaceHomeDir('cw-1')).toBe(join(ws, 'home'));
  });

  it('falls back to the managed home dir when no external path is registered', () => {
    expect(getCoworkWorkspaceRootDir('cw-1')).toBe(getWorkspaceHomeDir('cw-1'));
  });

  it('derives the root from a config-supplied external path without the registry', () => {
    mockedGetWorkspaceExternalPath.mockClear();
    expect(coworkWorkspaceRootDirFor('cw-1', '/Users/me/attached-folder')).toBe(
      '/Users/me/attached-folder',
    );
    expect(mockedGetWorkspaceExternalPath).not.toHaveBeenCalled();
  });

  it('derives the managed home when the config carries no external path', () => {
    expect(coworkWorkspaceRootDirFor('cw-1', undefined)).toBe(
      getWorkspaceHomeDir('cw-1'),
    );
  });

  it('resolves to the registered external path when one is attached', () => {
    mockedGetWorkspaceExternalPath.mockReturnValue('/Users/me/attached-folder');
    expect(getCoworkWorkspaceRootDir('cw-1')).toBe('/Users/me/attached-folder');
  });

  it('places archived chats under chat-history/{chatId}', () => {
    const dir = getWorkspaceChatHistoryDir('cw-1', 'chat-9');
    expect(dir).toBe(join(ws, 'chat-history', 'chat-9'));
    expect(getWorkspaceChatHistoryMetaFilePath('cw-1', 'chat-9')).toBe(
      join(dir, 'meta.json'),
    );
    expect(getWorkspaceChatHistorySummaryFilePath('cw-1', 'chat-9')).toBe(
      join(dir, 'summary.md'),
    );
    expect(getWorkspaceChatHistoryConversationFilePath('cw-1', 'chat-9')).toBe(
      join(dir, 'conversation.json'),
    );
  });

  it('places derived data under derived/', () => {
    expect(getWorkspaceDerivedDir('cw-1')).toBe(join(ws, 'derived'));
  });
});
