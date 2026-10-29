import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { rewriteCursorShellInput } from '../rtk-rewrite';

function writeRtkScript(tempDir: string, scriptBody: string): string {
  const scriptPath = path.join(tempDir, 'rtk');
  fs.writeFileSync(
    scriptPath,
    `#!${process.execPath}\n${scriptBody}\n`,
    'utf8',
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function shellPayload(toolInput: unknown, toolName = 'Shell'): unknown {
  return {
    hook_event_name: 'preToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tool-1',
  };
}

describe('rewriteCursorShellInput', () => {
  let tempDir: string;
  let capturePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-cursor-rtk-'));
    capturePath = path.join(tempDir, 'argv.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rewrites a native Shell command and preserves the other input fields', async () => {
    const rtkBinaryPath = writeRtkScript(
      tempDir,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write('rtk git status\\n');",
        'process.exit(0);',
      ].join('\n'),
    );

    const updated = await rewriteCursorShellInput(
      shellPayload({ command: 'git status', cwd: '/repo' }),
      { rtkBinaryPath, signal: new AbortController().signal },
    );

    expect(updated).toEqual({ command: 'rtk git status', cwd: '/repo' });
    expect(JSON.parse(fs.readFileSync(capturePath, 'utf8'))).toEqual([
      'rewrite',
      'git status',
    ]);
  });

  it('ignores other tools and malformed commands without invoking RTK', async () => {
    const rtkBinaryPath = writeRtkScript(
      tempDir,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, 'invoked');`,
        "process.stdout.write('rtk never');",
        'process.exit(0);',
      ].join('\n'),
    );
    const options = { rtkBinaryPath, signal: new AbortController().signal };

    await expect(
      rewriteCursorShellInput(
        shellPayload({ file_path: '/repo/a.txt', content: 'x' }, 'Write'),
        options,
      ),
    ).resolves.toBeUndefined();
    await expect(
      rewriteCursorShellInput(shellPayload({ command: '   ' }), options),
    ).resolves.toBeUndefined();
    await expect(
      rewriteCursorShellInput(shellPayload({ command: ['git'] }), options),
    ).resolves.toBeUndefined();
    await expect(
      rewriteCursorShellInput(shellPayload('git status'), options),
    ).resolves.toBeUndefined();
    await expect(rewriteCursorShellInput(null, options)).resolves.toBe(
      undefined,
    );
    expect(fs.existsSync(capturePath)).toBe(false);
  });

  it('returns undefined when RTK declines, fails, echoes the input, or is aborted', async () => {
    const declined = writeRtkScript(tempDir, 'process.exit(1);');
    const signal = new AbortController().signal;
    await expect(
      rewriteCursorShellInput(shellPayload({ command: 'git status' }), {
        rtkBinaryPath: declined,
        signal,
      }),
    ).resolves.toBeUndefined();

    const silent = writeRtkScript(tempDir, 'process.exit(0);');
    await expect(
      rewriteCursorShellInput(shellPayload({ command: 'git status' }), {
        rtkBinaryPath: silent,
        signal,
      }),
    ).resolves.toBeUndefined();

    const identical = writeRtkScript(
      tempDir,
      "process.stdout.write('git status');process.exit(0);",
    );
    await expect(
      rewriteCursorShellInput(shellPayload({ command: 'git status' }), {
        rtkBinaryPath: identical,
        signal,
      }),
    ).resolves.toBeUndefined();

    const rewriting = writeRtkScript(
      tempDir,
      "process.stdout.write('rtk git status');process.exit(0);",
    );
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      rewriteCursorShellInput(shellPayload({ command: 'git status' }), {
        rtkBinaryPath: rewriting,
        signal: aborted.signal,
      }),
    ).resolves.toBeUndefined();
  });
});
