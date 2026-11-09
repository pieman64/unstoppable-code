import { brandEnvName } from '@canopy/execution-engine/brand/env';
import { BRAND } from '@canopy/brand/current';

const RTK_BINARY_PATH_ENV = brandEnvName('RTK_BINARY_PATH');
const PREF_RTK_ENABLED_ENV = brandEnvName('PREF_RTK_ENABLED');

export function buildRtkHookWrapperScript(): string {
  return `const { spawn } = require('node:child_process');
const { mkdir } = require('node:fs/promises');
const { dirname } = require('node:path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

async function ensureRtkManagedDirs() {
  const dbPath = process.env.RTK_DB_PATH;
  if (typeof dbPath === 'string' && dbPath.length > 0) {
    await mkdir(dirname(dbPath), { recursive: true });
  }
  const teeDir = process.env.RTK_TEE_DIR;
  if (typeof teeDir === 'string' && teeDir.length > 0) {
    await mkdir(teeDir, { recursive: true });
  }
}

async function runRtk(command) {
  try {
    await ensureRtkManagedDirs();
  } catch (err) {
    process.stderr.write('[rtk] Failed to pre-create managed dirs: ' + String(err) + '\\n');
    return undefined;
  }
  const binary = process.env[${JSON.stringify(RTK_BINARY_PATH_ENV)}] || 'rtk';
  return new Promise((resolve) => {
    const child = spawn(binary, ['rewrite', command], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: process.platform === 'win32',
    });
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(undefined);
    }, 2000);
    child.stdout.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    child.once('error', () => finish(undefined));
    child.once('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf8').replace(/[\\r\\n]+$/, '');
      if (!stdout || (code !== 0 && code !== 3)) {
        finish(undefined);
        return;
      }
      finish(stdout);
    });
  });
}

(async () => {
  if (process.env[${JSON.stringify(PREF_RTK_ENABLED_ENV)}] === 'false') return;
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return;
  }
  const toolInput = isRecord(payload) ? payload.tool_input : undefined;
  const command = isRecord(toolInput) ? toolInput.command : undefined;
  if (typeof command !== 'string' || command.trim().length === 0) return;
  const rewritten = await runRtk(command);
  if (!rewritten) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: ${JSON.stringify(
        `Command rewritten by ${BRAND.displayName} RTK integration`,
      )},
      updatedInput: { ...toolInput, command: rewritten },
    },
  }));
})().catch(() => {});
`;
}
