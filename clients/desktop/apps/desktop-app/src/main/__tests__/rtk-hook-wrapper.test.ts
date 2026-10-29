import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Script } from 'node:vm';
import { BRAND } from '@canopy/brand/current';
import { brandEnvName } from '@canopy/desktop-shared/brand/env';
import { buildRtkHookWrapperScript } from '../integration/rtk-hook-wrapper';

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, `#!${process.execPath}\n${source}\n`, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

async function runWrapper(input: {
  wrapperPath: string;
  payload: unknown;
  env: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [input.wrapperPath], {
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('close', (status) => {
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        status,
      });
    });
    child.stdin.end(JSON.stringify(input.payload));
  });
}

describe('buildRtkHookWrapperScript', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canopy-rtk-wrapper-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('generates JavaScript that parses', () => {
    expect(() => new Script(buildRtkHookWrapperScript())).not.toThrow();
  });

  it('rewrites Bash commands and trims trailing newlines', async () => {
    const wrapperPath = path.join(tempDir, 'rtk-hook-wrapper.js');
    const rtkPath = path.join(tempDir, 'rtk');
    fs.writeFileSync(wrapperPath, buildRtkHookWrapperScript(), 'utf8');
    writeExecutable(
      rtkPath,
      [
        "if (process.argv[2] !== 'rewrite') process.exit(2);",
        "process.stdout.write('printf rewritten\\n\\n');",
        'process.exit(0);',
      ].join('\n'),
    );

    const result = await runWrapper({
      wrapperPath,
      payload: {
        tool_input: {
          command: 'printf original',
          description: 'keep me',
        },
      },
      env: {
        ...process.env,
        [brandEnvName('RTK_BINARY_PATH')]: rtkPath,
        [brandEnvName('PREF_RTK_ENABLED')]: 'true',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `Command rewritten by ${BRAND.displayName} RTK integration`,
        updatedInput: {
          command: 'printf rewritten',
          description: 'keep me',
        },
      },
    });
  });

  it('creates RTK managed directories before spawning RTK', async () => {
    const wrapperPath = path.join(tempDir, 'rtk-hook-wrapper.js');
    const rtkPath = path.join(tempDir, 'rtk');
    const capturePath = path.join(tempDir, 'capture.json');
    const dbPath = path.join(tempDir, 'nested', 'db', 'history.db');
    const teeDir = path.join(tempDir, 'nested', 'tee', 'logs');
    fs.writeFileSync(wrapperPath, buildRtkHookWrapperScript(), 'utf8');
    writeExecutable(
      rtkPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
        '  dbParentExists: fs.existsSync(require("node:path").dirname(process.env.RTK_DB_PATH)),',
        '  teeDirExists: fs.existsSync(process.env.RTK_TEE_DIR),',
        '}));',
        "process.stdout.write('echo rewritten');",
        'process.exit(0);',
      ].join('\n'),
    );

    const result = await runWrapper({
      wrapperPath,
      payload: { tool_input: { command: 'echo original' } },
      env: {
        ...process.env,
        [brandEnvName('RTK_BINARY_PATH')]: rtkPath,
        [brandEnvName('PREF_RTK_ENABLED')]: 'true',
        RTK_DB_PATH: dbPath,
        RTK_TEE_DIR: teeDir,
      },
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(capturePath, 'utf8'))).toEqual({
      dbParentExists: true,
      teeDirExists: true,
    });
  });

  it('fails soft when RTK managed directories cannot be created', async () => {
    const wrapperPath = path.join(tempDir, 'rtk-hook-wrapper.js');
    const rtkPath = path.join(tempDir, 'rtk');
    const capturePath = path.join(tempDir, 'capture.json');
    const blockingFilePath = path.join(tempDir, 'not-a-directory');
    fs.writeFileSync(wrapperPath, buildRtkHookWrapperScript(), 'utf8');
    fs.writeFileSync(blockingFilePath, 'already a file', 'utf8');
    writeExecutable(
      rtkPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(capturePath)}, 'spawned');`,
        "process.stdout.write('echo rewritten');",
        'process.exit(0);',
      ].join('\n'),
    );

    const result = await runWrapper({
      wrapperPath,
      payload: { tool_input: { command: 'echo original' } },
      env: {
        ...process.env,
        [brandEnvName('RTK_BINARY_PATH')]: rtkPath,
        [brandEnvName('PREF_RTK_ENABLED')]: 'true',
        RTK_DB_PATH: path.join(blockingFilePath, 'history.db'),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('[rtk] Failed to pre-create managed dirs:');
    expect(fs.existsSync(capturePath)).toBe(false);
  });
});
