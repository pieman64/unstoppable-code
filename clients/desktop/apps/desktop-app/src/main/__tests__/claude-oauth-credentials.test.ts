import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildWindowsClaudeCredentialTargetName,
  getClaudeCredentialsFilePath,
  readClaudeOauthCredentialsResult,
} from '../auth/claude-oauth-credentials';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

const mockedReadFile = jest.mocked(readFile);

describe('Claude OAuth credential lookup', (): void => {
  const originalPlatform = process.platform;
  const originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  afterEach((): void => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
    });
    if (originalOauthToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
    }
    mockedReadFile.mockReset();
  });

  it('uses the keytar Windows service/account target format', (): void => {
    expect(buildWindowsClaudeCredentialTargetName('windows-user')).toBe(
      'Claude Code-credentials/windows-user',
    );
  });

  it('respects CLAUDE_CONFIG_DIR for the current credentials file', (): void => {
    const originalConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join('C:', 'custom-claude');
    try {
      expect(getClaudeCredentialsFilePath()).toBe(
        join('C:', 'custom-claude', '.credentials.json'),
      );
    } finally {
      if (originalConfigDirectory === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalConfigDirectory;
      }
    }
  });

  it('preserves stored plan metadata when an OAuth token is also exported', async (): Promise<void> => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      writable: true,
    });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'environment-access-token';
    mockedReadFile.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'stored-access-token',
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        },
      }),
    );

    await expect(readClaudeOauthCredentialsResult()).resolves.toEqual({
      status: 'success',
      credentials: {
        accessToken: 'stored-access-token',
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
    });
  });

  it('falls back to an exported OAuth token when no platform store is supported', async (): Promise<void> => {
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      writable: true,
    });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'environment-access-token';

    await expect(readClaudeOauthCredentialsResult()).resolves.toEqual({
      status: 'success',
      credentials: { accessToken: 'environment-access-token' },
    });
    expect(mockedReadFile).not.toHaveBeenCalled();
  });
});
