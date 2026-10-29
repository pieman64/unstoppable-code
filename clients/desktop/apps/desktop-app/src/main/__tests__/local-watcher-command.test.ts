import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runWatcherCommand,
  readWatcherCommandResult,
  terminateWindowsProcessTree,
} from '../app-advisor/local-watcher-command';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { fsyncDirectory } from '../lib/fsync-directory';

jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof childProcess>('node:child_process');
  return { ...actual, spawn: jest.fn(actual.spawn) };
});
jest.mock('../lib/fsync-directory', () => ({
  fsyncDirectory: jest.fn(() => Promise.resolve()),
}));

const actualSpawn =
  jest.requireActual<typeof childProcess>('node:child_process').spawn;

const commandForHost = (posix: string, powershell: string): string =>
  process.platform === 'win32' ? powershell : posix;

describe('watcher command output', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'watcher-command-'));
    jest.mocked(childProcess.spawn).mockImplementation(actualSpawn);
    jest.mocked(fsyncDirectory).mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('retains stdout and stderr even when the command fails', async () => {
    const result = await runWatcherCommand({
      command: commandForHost(
        'printf hello; printf error >&2; exit 2',
        "[Console]::Out.Write('hello'); [Console]::Error.Write('error'); exit 2",
      ),
      cwd: dir,
      outputPath: join(dir, 'result.log'),
    });
    expect(result.exitCode).toBe(2);
    expect(result.output.kind).toBe('inline');
    if (result.output.kind === 'inline') {
      expect(result.output.text).toContain('hello');
      expect(result.output.text).toContain('error');
    }
    expect(result.output.byteSize).toBe(10);
    expect(result.output.lineCount).toBe(1);
    expect(await readWatcherCommandResult(join(dir, 'result.log'))).toEqual(
      result,
    );
    expect(
      JSON.parse(await readFile(join(dir, 'result.log.result.json'), 'utf8')),
    ).toMatchObject({
      version: 1,
      result: {
        exitCode: result.exitCode,
        signal: result.signal,
        output: result.output,
      },
    });
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;
  posixIt(
    'does not execute zsh-only syntax through the watcher shell',
    async () => {
      if (!existsSync('/bin/zsh')) return;
      const marker = join(dir, 'zsh-qualifier-ran');
      const previousShell = process.env.SHELL;
      process.env.SHELL = '/bin/zsh';
      try {
        await runWatcherCommand({
          command: `print -r -- *(e:'touch ${marker}':) >/dev/null`,
          cwd: dir,
          outputPath: join(dir, 'result.log'),
        });
      } finally {
        if (previousShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = previousShell;
      }
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('ignores malformed and unsupported command-result checkpoints', async () => {
    const outputPath = join(dir, 'result.log');
    await writeFile(
      `${outputPath}.result.json`,
      JSON.stringify({
        version: 2,
        result: {
          exitCode: 0,
          signal: null,
          output: {
            kind: 'inline',
            text: '',
            byteSize: 0,
            lineCount: 0,
            complete: true,
          },
        },
      }),
    );
    await expect(readWatcherCommandResult(outputPath)).resolves.toBeUndefined();
    await writeFile(`${outputPath}.result.json`, '{not-json');
    await expect(readWatcherCommandResult(outputPath)).resolves.toBeUndefined();
  });

  it('offloads complete output without changing the exit status', async () => {
    const result = await runWatcherCommand({
      command: commandForHost(
        'printf "one\\ntwo\\nthree"; exit 1',
        "[Console]::Write([string]::Join([char]10, @('one', 'two', 'three'))); exit 1",
      ),
      cwd: dir,
      outputPath: join(dir, 'result.log'),
      inlineBytes: 4,
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatchObject({
      kind: 'file',
      byteSize: 13,
      lineCount: 3,
    });
    expect(await readFile(join(dir, 'result.log'), 'utf8')).toBe(
      'one\ntwo\nthree',
    );
  });

  it('reports timeout with the output produced before termination', async () => {
    const result = await runWatcherCommand({
      command: commandForHost(
        'printf ready; sleep 30',
        "[Console]::Write('ready'); Start-Sleep -Seconds 30",
      ),
      cwd: dir,
      outputPath: join(dir, 'result.log'),
      timeoutMs: process.platform === 'win32' ? 3000 : 1000,
      env: { ...process.env, ZDOTDIR: '/dev/null' },
    });
    expect(result.reason).toBe('timeout');
    expect(result.output).toMatchObject({ kind: 'inline', text: 'ready' });
  });

  it('does not time out after the child has already closed', async () => {
    jest
      .mocked(fsyncDirectory)
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(resolve, 100)),
      );
    const result = await runWatcherCommand({
      command: commandForHost('exit 0', 'exit 0'),
      cwd: dir,
      outputPath: join(dir, 'near-deadline.log'),
      timeoutMs: 50,
    });
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBeUndefined();
  });

  it('falls back when taskkill reports a nonzero exit', async () => {
    const killer = new EventEmitter();
    const child = { pid: 42, kill: jest.fn(() => true) };
    const termination = terminateWindowsProcessTree(
      child,
      jest.fn(() => killer),
    );
    killer.emit('close', 1);
    await expect(termination).rejects.toThrow('taskkill failed');
    expect(child.kill).toHaveBeenCalled();
  });

  it('passes verbatim arguments to the cmd.exe fallback', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      'platform',
    );
    const previousComSpec = process.env.ComSpec;
    const previousPath = process.env.PATH;
    jest
      .mocked(childProcess.spawn)
      .mockImplementation((shell, args, options) => {
        expect(shell).toBe('C:\\Windows\\System32\\cmd.exe');
        expect(args).toEqual([
          '/d',
          '/s',
          '/c',
          `"${join(dir, 'cmd-fallback.log.cmd')}"`,
        ]);
        expect(options?.windowsVerbatimArguments).toBe(true);
        throw new Error('spawn options inspected');
      });
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    process.env.PATH = '';
    try {
      await expect(
        runWatcherCommand({
          command: 'exit /b 0',
          cwd: dir,
          outputPath: join(dir, 'cmd-fallback.log'),
        }),
      ).rejects.toThrow('spawn options inspected');
    } finally {
      jest.mocked(childProcess.spawn).mockImplementation(actualSpawn);
      if (platformDescriptor)
        Object.defineProperty(process, 'platform', platformDescriptor);
      if (previousComSpec === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previousComSpec;
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it('reports an output ceiling as failure and preserves the captured prefix', async () => {
    const result = await runWatcherCommand({
      command: commandForHost(
        'printf 1234567890',
        "[Console]::Write('1234567890')",
      ),
      cwd: dir,
      outputPath: join(dir, 'result.log'),
      maxBytes: 5,
    });
    expect(result.reason).toBe('output_limit');
    expect(result.output).toMatchObject({ byteSize: 5, complete: false });
  });
});
