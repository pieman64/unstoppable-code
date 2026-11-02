import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const execFileMock = jest.fn();
jest.mock('node:child_process', () => ({
  get execFile(): typeof execFileMock {
    return execFileMock;
  },
}));
import { readCursorAccessToken } from '../cursor/account-credentials';

describe('native Cursor credential reads', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'cursor-usage-auth-'));
    execFileMock.mockReset();
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads only the CLI access-token entry with bounded async Keychain access', async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(null, 'token\n'),
    );
    const signal = new AbortController().signal;
    await expect(
      readCursorAccessToken({ HOME: directory }, signal, 'darwin'),
    ).resolves.toBe('token');
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/security',
      [
        'find-generic-password',
        '-a',
        'cursor-user',
        '-s',
        'cursor-access-token',
        '-w',
      ],
      expect.objectContaining({
        signal,
        timeout: 10_000,
        maxBuffer: 65536,
        env: { HOME: directory },
      }),
      expect.any(Function),
    );
  });
  it('does not expose the command error or partial credential on Keychain failure', async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ): void => callback(new Error('private error'), 'partial secret'),
    );
    await expect(
      readCursorAccessToken({}, new AbortController().signal, 'darwin'),
    ).resolves.toBeNull();
  });
  it('reads the same private APPDATA file used by the managed Windows runtime', async () => {
    await mkdir(join(directory, 'Cursor'));
    await writeFile(
      join(directory, 'Cursor', 'auth.json'),
      JSON.stringify({
        accessToken: 'windows-token',
        refreshToken: 'not-returned',
      }),
    );
    await expect(
      readCursorAccessToken(
        { APPDATA: directory },
        new AbortController().signal,
        'win32',
      ),
    ).resolves.toBe('windows-token');
    expect(execFileMock).not.toHaveBeenCalled();
  });
  it.each(['invalid json', '{"accessToken":9}', ' '.repeat(65537)])(
    'rejects an unreadable or oversized auth record',
    async (data) => {
      await mkdir(join(directory, 'Cursor'));
      await writeFile(join(directory, 'Cursor', 'auth.json'), data);
      await expect(
        readCursorAccessToken(
          { APPDATA: directory },
          new AbortController().signal,
          'win32',
        ),
      ).resolves.toBeNull();
    },
  );
  it('does not fall back to another account when the managed credential is missing', async () => {
    await expect(
      readCursorAccessToken({}, new AbortController().signal, 'win32'),
    ).resolves.toBeNull();
    await expect(
      readCursorAccessToken(
        { APPDATA: directory },
        new AbortController().signal,
        'win32',
      ),
    ).resolves.toBeNull();
  });
  it('does no work after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readCursorAccessToken({}, controller.signal, 'darwin'),
    ).rejects.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
