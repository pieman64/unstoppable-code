import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildRtkClaudeHooks } from '../node/rtk/claude-hooks';

interface HookInputShape {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_use_id: string;
  tool_input: unknown;
}

function buildHookInput(toolName: string, toolInput: unknown): HookInputShape {
  return {
    session_id: 'session-1',
    transcript_path: '/tmp/transcript.jsonl',
    cwd: '/tmp/project',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'tool-1',
    tool_input: toolInput,
  };
}

function getPreToolUseHook(
  options: Parameters<typeof buildRtkClaudeHooks>[0],
): NonNullable<
  ReturnType<typeof buildRtkClaudeHooks>['PreToolUse']
>[number]['hooks'][number] {
  const matcher = buildRtkClaudeHooks(options).PreToolUse?.[0];
  if (!matcher) {
    throw new Error('Expected PreToolUse matcher');
  }

  const hook = matcher.hooks[0];
  if (!hook) {
    throw new Error('Expected PreToolUse hook callback');
  }

  return hook;
}

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

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('buildRtkClaudeHooks', () => {
  let tempDir: string;
  let originalRtkDbPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-rtk-hooks-'));
    originalRtkDbPath = process.env.RTK_DB_PATH;
    delete process.env.RTK_DB_PATH;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalRtkDbPath === undefined) {
      delete process.env.RTK_DB_PATH;
    } else {
      process.env.RTK_DB_PATH = originalRtkDbPath;
    }
  });

  it('rewrites Bash commands on RTK exit 0 and preserves existing tool input fields', async () => {
    const scriptPath = writeRtkScript(
      tempDir,
      [
        "if (process.argv[2] !== 'rewrite') process.exit(2);",
        "process.stdout.write('printf rewritten');",
        'process.exit(0);',
      ].join('\n'),
    );
    const hook = getPreToolUseHook({ rtkBinaryPath: scriptPath });

    const result = await hook(
      buildHookInput('Bash', {
        command: 'printf original',
        description: 'keep me',
      }),
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          command: 'printf rewritten',
          description: 'keep me',
        },
        permissionDecision: 'allow',
        permissionDecisionReason: 'Command rewritten by Canopy RTK integration',
      },
    });
  });

  it('rewrites Bash commands on RTK exit 3 without prompting', async () => {
    const scriptPath = writeRtkScript(
      tempDir,
      [
        "process.stdout.write('echo allow-with-exit-3');",
        'process.exit(3);',
      ].join('\n'),
    );
    const hook = getPreToolUseHook({ rtkBinaryPath: scriptPath });

    const result = await hook(
      buildHookInput('Bash', { command: 'echo original' }),
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { command: 'echo allow-with-exit-3' },
        permissionDecision: 'allow',
        permissionDecisionReason: 'Command rewritten by Canopy RTK integration',
      },
    });
  });

  it('passes rewrite argv as separate spawn arguments', async () => {
    const capturePath = path.join(tempDir, 'argv.json');
    const scriptPath = writeRtkScript(
      tempDir,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.argv.slice(2)));`,
        "process.stdout.write('echo safe');",
        'process.exit(0);',
      ].join('\n'),
    );
    const hook = getPreToolUseHook({ rtkBinaryPath: scriptPath });
    const command = 'echo "$HOME" && rm -rf /tmp/example';

    await hook(buildHookInput('Bash', { command }), undefined, {
      signal: new AbortController().signal,
    });

    expect(JSON.parse(fs.readFileSync(capturePath, 'utf8'))).toEqual([
      'rewrite',
      command,
    ]);
  });

  it('passes RTK env from options.env and creates managed path parents', async () => {
    const capturePath = path.join(tempDir, 'env.json');
    const dbPath = path.join(tempDir, 'nested', 'db', 'history.db');
    const teeDir = path.join(tempDir, 'nested', 'tee', 'logs');
    const scriptPath = writeRtkScript(
      tempDir,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
        '  dbPath: process.env.RTK_DB_PATH,',
        '  teeDir: process.env.RTK_TEE_DIR,',
        '  telemetryDisabled: process.env.RTK_TELEMETRY_DISABLED,',
        '}));',
        "process.stdout.write('echo rewritten');",
        'process.exit(0);',
      ].join('\n'),
    );
    process.env.RTK_DB_PATH = '/should/not/be/used';
    const hook = getPreToolUseHook({
      rtkBinaryPath: scriptPath,
      env: {
        RTK_DB_PATH: dbPath,
        RTK_TEE_DIR: teeDir,
        RTK_TELEMETRY_DISABLED: '1',
      },
    });

    await hook(
      buildHookInput('Bash', { command: 'echo original' }),
      undefined,
      { signal: new AbortController().signal },
    );

    expect(JSON.parse(fs.readFileSync(capturePath, 'utf8'))).toEqual({
      dbPath,
      teeDir,
      telemetryDisabled: '1',
    });
    expect(fs.existsSync(path.dirname(dbPath))).toBe(true);
    expect(fs.existsSync(teeDir)).toBe(true);
  });

  it('inherits the parent env when options.env is omitted', async () => {
    const capturePath = path.join(tempDir, 'inherited-env.json');
    const scriptPath = writeRtkScript(
      tempDir,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
        '  home: process.env.HOME,',
        '  path: process.env.PATH,',
        "  hasPath: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,",
        '}));',
        "process.stdout.write('echo rewritten');",
        'process.exit(0);',
      ].join('\n'),
    );
    const hook = getPreToolUseHook({ rtkBinaryPath: scriptPath });

    await hook(
      buildHookInput('Bash', { command: 'echo original' }),
      undefined,
      { signal: new AbortController().signal },
    );

    expect(JSON.parse(fs.readFileSync(capturePath, 'utf8'))).toEqual({
      home: process.env.HOME,
      path: process.env.PATH,
      hasPath: true,
    });
  });

  it('returns continue when managed RTK dir setup fails before spawn', async () => {
    const capturePath = path.join(tempDir, 'invoked.txt');
    const blockingPath = path.join(tempDir, 'blocker');
    fs.writeFileSync(blockingPath, 'file', 'utf8');
    const scriptPath = writeRtkScript(
      tempDir,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, 'invoked');`,
        "process.stdout.write('echo rewritten');",
        'process.exit(0);',
      ].join('\n'),
    );
    const hook = getPreToolUseHook({
      rtkBinaryPath: scriptPath,
      env: {
        RTK_DB_PATH: path.join(blockingPath, 'nested', 'history.db'),
      },
    });

    await expect(
      hook(buildHookInput('Bash', { command: 'echo original' }), undefined, {
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ continue: true });
    expect(fs.existsSync(capturePath)).toBe(false);
  });

  it('strips trailing newlines while preserving internal newlines', async () => {
    const scriptPath = writeRtkScript(
      tempDir,
      [
        "process.stdout.write('echo line-1\\necho line-2\\n\\n');",
        'process.exit(0);',
      ].join('\n'),
    );
    const hook = getPreToolUseHook({ rtkBinaryPath: scriptPath });

    const result = await hook(
      buildHookInput('Bash', { command: 'echo original' }),
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { command: 'echo line-1\necho line-2' },
        permissionDecision: 'allow',
        permissionDecisionReason: 'Command rewritten by Canopy RTK integration',
      },
    });
  });

  it('returns continue for malformed command inputs without invoking RTK', async () => {
    const capturePath = path.join(tempDir, 'invoked.txt');
    const scriptPath = writeRtkScript(
      tempDir,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, 'invoked');`,
        "process.stdout.write('echo rewritten');",
        'process.exit(0);',
      ].join('\n'),
    );
    const hook = getPreToolUseHook({ rtkBinaryPath: scriptPath });

    expect(
      await hook(buildHookInput('Bash', null), undefined, {
        signal: new AbortController().signal,
      }),
    ).toEqual({ continue: true });
    expect(
      await hook(buildHookInput('Bash', { command: '   ' }), undefined, {
        signal: new AbortController().signal,
      }),
    ).toEqual({ continue: true });

    expect(fs.existsSync(capturePath)).toBe(false);
  });

  it('returns continue when disabled', async () => {
    const capturePath = path.join(tempDir, 'invoked.txt');
    const scriptPath = writeRtkScript(
      tempDir,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, 'invoked');`,
        "process.stdout.write('echo rewritten');",
        'process.exit(0);',
      ].join('\n'),
    );
    const hook = getPreToolUseHook({
      rtkBinaryPath: scriptPath,
      isEnabled: (): boolean => false,
    });

    const result = await hook(
      buildHookInput('Bash', { command: 'echo original' }),
      undefined,
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({ continue: true });
    expect(fs.existsSync(capturePath)).toBe(false);
  });

  it('returns continue on RTK failure exits, empty stdout, spawn error, timeout, and abort', async () => {
    const failingScriptPath = writeRtkScript(
      tempDir,
      [
        'const mode = process.env.TEST_MODE;',
        "if (mode === 'exit-1') process.exit(1);",
        "if (mode === 'exit-2') process.exit(2);",
        "if (mode === 'empty') process.exit(0);",
        "setTimeout(() => { process.stdout.write('echo slow'); process.exit(0); }, 10000);",
      ].join('\n'),
    );
    const hookExit1 = getPreToolUseHook({
      rtkBinaryPath: failingScriptPath,
      env: { TEST_MODE: 'exit-1' },
    });
    const hookExit2 = getPreToolUseHook({
      rtkBinaryPath: failingScriptPath,
      env: { TEST_MODE: 'exit-2' },
    });
    const hookEmpty = getPreToolUseHook({
      rtkBinaryPath: failingScriptPath,
      env: { TEST_MODE: 'empty' },
    });
    const hookMissingBinary = getPreToolUseHook({
      rtkBinaryPath: path.join(tempDir, 'missing-rtk'),
    });
    const hookTimeout = getPreToolUseHook({
      rtkBinaryPath: failingScriptPath,
      timeoutMs: 50,
    });
    const hookAbort = getPreToolUseHook({
      rtkBinaryPath: failingScriptPath,
    });

    expect(
      await hookExit1(
        buildHookInput('Bash', { command: 'echo original' }),
        undefined,
        { signal: new AbortController().signal },
      ),
    ).toEqual({ continue: true });
    expect(
      await hookExit2(
        buildHookInput('Bash', { command: 'echo original' }),
        undefined,
        { signal: new AbortController().signal },
      ),
    ).toEqual({ continue: true });
    expect(
      await hookEmpty(
        buildHookInput('Bash', { command: 'echo original' }),
        undefined,
        { signal: new AbortController().signal },
      ),
    ).toEqual({ continue: true });
    expect(
      await hookMissingBinary(
        buildHookInput('Bash', { command: 'echo original' }),
        undefined,
        { signal: new AbortController().signal },
      ),
    ).toEqual({ continue: true });
    expect(
      await hookTimeout(
        buildHookInput('Bash', { command: 'echo original' }),
        undefined,
        { signal: new AbortController().signal },
      ),
    ).toEqual({ continue: true });

    const abortController = new AbortController();
    const pendingAbort = hookAbort(
      buildHookInput('Bash', { command: 'echo original' }),
      undefined,
      { signal: abortController.signal },
    );
    abortController.abort();
    await expect(pendingAbort).resolves.toEqual({ continue: true });
  });

  it('settles timeout and abort immediately even when RTK ignores SIGTERM', async () => {
    const survivedPath = path.join(tempDir, 'stubborn-survived.txt');
    const stubbornScriptPath = writeRtkScript(
      tempDir,
      [
        `const fs = require('node:fs');`,
        "process.on('SIGTERM', () => {});",
        `setTimeout(() => { fs.writeFileSync(${JSON.stringify(survivedPath)}, 'survived'); process.stdout.write('echo too-late'); process.exit(0); }, 500);`,
      ].join('\n'),
    );
    const hookTimeout = getPreToolUseHook({
      rtkBinaryPath: stubbornScriptPath,
      timeoutMs: 50,
    });
    const timeoutStartedAt = Date.now();

    await expect(
      hookTimeout(
        buildHookInput('Bash', { command: 'echo original' }),
        undefined,
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ continue: true });
    expect(Date.now() - timeoutStartedAt).toBeLessThan(1_000);
    await sleep(800);
    expect(fs.existsSync(survivedPath)).toBe(false);

    const hookAbort = getPreToolUseHook({
      rtkBinaryPath: stubbornScriptPath,
    });
    const abortController = new AbortController();
    const abortStartedAt = Date.now();
    const pendingAbort = hookAbort(
      buildHookInput('Bash', { command: 'echo original' }),
      undefined,
      { signal: abortController.signal },
    );
    abortController.abort();

    await expect(pendingAbort).resolves.toEqual({ continue: true });
    expect(Date.now() - abortStartedAt).toBeLessThan(1_000);
    await sleep(800);
    expect(fs.existsSync(survivedPath)).toBe(false);
  });
});
