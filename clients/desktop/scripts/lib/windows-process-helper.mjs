import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isX64PeImage, stripPeAuthenticodeSignature } from './pe-signature.mjs';

export const PROCESS_HELPER = 'canopy-process-identity.exe';
export const PROCESS_SOURCE =
  'packages/core-platform/native/windows-process/process-identity.c';
export const PROCESS_FLAGS = [
  '/nologo',
  '/std:c11',
  '/O2',
  '/MT',
  '/W4',
  '/WX',
  '/D_WIN32_WINNT=0x0600',
];
// advapi32 supplies OpenProcessToken/GetTokenInformation for --token-user.
export const PROCESS_LINK = ['/MACHINE:X64', 'advapi32.lib'];
export const PROCESS_RECIPE = JSON.stringify([
  'v3:msvc-x64',
  ...PROCESS_FLAGS,
  ...PROCESS_LINK,
  'authenticode-image-digest',
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function processSourceDigest(root) {
  return hash(
    Buffer.concat([
      readFileSync(join(root, PROCESS_SOURCE)),
      Buffer.from(PROCESS_RECIPE),
    ]),
  );
}
// Compare executable content across release signing, not signature bytes.
// Existing release signature verification remains responsible for signer trust.
export function processImageDigest(bytes) {
  if (!isX64PeImage(bytes))
    throw new Error('Windows process helper is not x64 PE');
  const offset = bytes.readUInt32LE(60);
  const image = Buffer.from(stripPeAuthenticodeSignature(bytes).buffer);
  image.writeUInt32LE(0, offset + 24 + 64);
  return hash(image);
}
export function assertProcessHelper(root) {
  const file = join(root, '.cache/bin/win32-x64', PROCESS_HELPER);
  const bytes = readFileSync(file);
  const marker = JSON.parse(readFileSync(`${file}.source.json`, 'utf8'));
  if (
    marker.source !== processSourceDigest(root) ||
    marker.binary !== processImageDigest(bytes)
  )
    throw new Error('Windows process helper is stale');
  return file;
}
export function stageProcessHelper(root, directory) {
  const source = assertProcessHelper(root);
  const target = join(directory, PROCESS_HELPER);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return target;
}

export function assertStagedProcessHelper(root, directory) {
  const source = assertProcessHelper(root);
  const staged = join(directory, PROCESS_HELPER);
  if (
    processImageDigest(readFileSync(source)) !==
    processImageDigest(readFileSync(staged))
  )
    throw new Error(
      'Staged Windows process helper differs from fresh source build',
    );
}

async function removeBuildArtifact(file, remove, wait) {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(file, { force: true });
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      if (attempt === 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code))
        throw new Error(
          `Windows process build artifact cleanup failed: ${file}`,
          {
            cause: error,
          },
        );
      // Windows can retain an image lock briefly after the child closes.
      await wait(50 * 2 ** attempt);
    }
  }
}

export async function withProcessBuildArtifacts(
  files,
  operation,
  { remove = rm, pause: wait = pause } = {},
) {
  let result;
  let failed = false;
  let primary;
  try {
    result = await operation();
  } catch (error) {
    failed = true;
    primary = error;
  }
  const cleanup = [];
  for (const file of files) {
    try {
      await removeBuildArtifact(file, remove, wait);
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (cleanup.length)
    throw new AggregateError(
      failed ? [primary, ...cleanup] : cleanup,
      failed
        ? 'Windows process build failed; artifact cleanup also failed'
        : 'Windows process build artifact cleanup failed',
      failed ? { cause: primary } : undefined,
    );
  if (failed) throw primary;
  return result;
}

/** Build commands settle after close; a failed kill cannot wait indefinitely. */
export function runProcessBuildCommand(
  file,
  args,
  options,
  execute = execFile,
) {
  if (!Number.isSafeInteger(options.timeout) || options.timeout <= 0)
    throw new Error('Windows process build command requires a bounded timeout');
  return new Promise((resolve, reject) => {
    let child;
    let result;
    let closed = false;
    let closeCode;
    let closeSignal;
    let settled = false;
    const settle = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(output);
    };
    const finish = () => {
      if (!closed || !result) return;
      const error =
        result.error ??
        (closeCode !== 0 || closeSignal !== null
          ? Object.assign(
              new Error(
                `Windows process build command closed (${closeCode}, ${closeSignal})`,
              ),
              result.output,
            )
          : null);
      settle(error, result.output);
    };
    const deadline = setTimeout(() => {
      const closure = new Error(
        'Windows process build command did not complete closure',
      );
      if (!closed) {
        try {
          child?.kill('SIGKILL');
        } catch (error) {
          closure.cause = error;
        }
      }
      settle(
        result?.error
          ? new AggregateError([result.error, closure], closure.message, {
              cause: result.error,
            })
          : closure,
      );
    }, options.timeout + 2000);
    try {
      child = execute(
        file,
        args,
        {
          ...options,
          encoding: 'utf8',
          killSignal: 'SIGKILL',
        },
        (error, stdout, stderr) => {
          result = {
            error: error ? Object.assign(error, { stdout, stderr }) : null,
            output: { stdout, stderr },
          };
          finish();
        },
      );
      child.on('error', (error) => {
        result ??= { error, output: { stdout: '', stderr: '' } };
        finish();
      });
      child.once('close', (code, signal) => {
        closed = true;
        closeCode = code;
        closeSignal = signal;
        finish();
      });
    } catch (error) {
      settle(error);
    }
  });
}
