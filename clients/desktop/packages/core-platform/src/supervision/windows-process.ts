import {
  execFile,
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { LocalAuthorityIdentityError } from '../local-authority';
import { observeWindowsClosure } from './windows-closure';

export const WINDOWS_PROCESS_FILE = 'canopy-process-identity.exe';
/** The helper's two fixed modes: one validated PID, or its own TokenUser. */
type WindowsHelperRequest = number | 'token-user';
const failure = (): Error =>
  new Error('Windows process observation unavailable');
type Execute = (
  file: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => ChildProcess;
let outstanding = 0;
/** A pre-launch refusal is a failed observation, never a safe closure. */
const refused = (): Error => {
  const closure = observeWindowsClosure('identity');
  closure?.unsafe();
  closure?.close();
  return failure();
};

/**
 * Admission belongs to the OS child until close, not to its cancelled waiter.
 * Both fixed modes share the four-child admission, deadline and output limits.
 */
export function runWindowsProcess(
  file: string,
  request: WindowsHelperRequest,
  signal?: AbortSignal,
  execute?: Execute,
  prepare?: () => Promise<void>,
): Promise<string> {
  signal?.throwIfAborted();
  if (outstanding >= 4) return Promise.reject(refused());
  outstanding++;
  const closure = observeWindowsClosure('identity');
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      outstanding--;
      closure?.close();
    };
    let callbackResult: string | undefined;
    let closed = false;
    let stopping = false;
    const settle = (error?: unknown, text?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error !== undefined) {
        // AbortSignal reasons are caller-owned values; preserve exact identity.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      } else resolve(text ?? '');
    };
    const stop = (reason: unknown): void => {
      closure?.unsafe();
      settle(reason);
      if (!child || stopping || closed) return;
      stopping = true;
      try {
        child?.kill();
      } catch {
        /* Close still owns admission. */
      }
    };
    const abort = (): void => stop(signal?.reason);
    const timer = setTimeout(() => stop(failure()), 4000);
    signal?.addEventListener('abort', abort, { once: true });
    const startChild = (): void => {
      try {
        child = (execute ?? execFile)(
          file,
          [request === 'token-user' ? '--token-user' : String(request)],
          {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 64 * 1024,
            cwd: path.win32.dirname(file),
            env: {},
          },
          (error, stdout, stderr) => {
            if (error || stderr !== '' || Buffer.byteLength(stdout) > 64 * 1024)
              stop(failure());
            else {
              callbackResult = stdout;
              if (closed) settle(undefined, stdout);
            }
          },
        );
        child.on('error', () => stop(failure()));
        child.once('close', (code, exitSignal) => {
          release();
          closed = true;
          if (code !== 0 || exitSignal !== null) {
            closure?.unsafe();
            settle(failure());
          } else if (callbackResult !== undefined)
            settle(undefined, callbackResult);
          else {
            closure?.unsafe();
            settle(failure());
          }
        });
        if (signal?.aborted) abort();
      } catch {
        // execFile threw without returning a child; there can be no close event.
        closure?.unsafe();
        release();
        settle(signal?.aborted ? signal.reason : failure());
      }
    };
    if (prepare) {
      // Bound validation tails too; no admission is freed while an open is pending.
      void Promise.resolve()
        .then(prepare)
        .then(
          () => {
            if (settled) release();
            else startChild();
          },
          () => {
            closure?.unsafe();
            release();
            settle(signal?.aborted ? signal.reason : failure());
          },
        );
    } else startChild();
  });
}

/**
 * Host-supplied absolute location only; no PATH, environment or CWD search.
 * Both observers apply the same path and per-launch PE checks to one file.
 */
function trustedWindowsHelper(
  file: string,
): (request: WindowsHelperRequest, signal?: AbortSignal) => Promise<string> {
  return async (request, signal) => {
    signal?.throwIfAborted();
    if (
      process.arch !== 'x64' ||
      !/^[A-Za-z]:\\/.test(file) ||
      Array.from(file).some((character) => character.charCodeAt(0) < 32) ||
      path.win32.basename(file) !== WINDOWS_PROCESS_FILE
    )
      throw refused();
    return runWindowsProcess(file, request, signal, execFile, async () => {
      signal?.throwIfAborted();
      const handle = await open(file, 'r');
      try {
        const dos = Buffer.alloc(64);
        if (
          (await handle.read(dos, 0, 64, 0)).bytesRead !== 64 ||
          dos.readUInt16LE(0) !== 0x5a4d
        )
          throw failure();
        const offset = dos.readUInt32LE(60);
        const pe = Buffer.alloc(6);
        if (
          offset < 64 ||
          offset > 4096 ||
          (await handle.read(pe, 0, 6, offset)).bytesRead !== 6 ||
          pe.readUInt32LE(0) !== 0x4550 ||
          pe.readUInt16LE(4) !== 0x8664
        )
          throw failure();
      } finally {
        await handle.close();
      }
    });
  };
}

export function windowsProcessObserver(
  file: string,
): (pid: number, signal?: AbortSignal) => Promise<string> {
  const helper = trustedWindowsHelper(file);
  return (pid, signal) => helper(pid, signal);
}

/**
 * The helper's own primary token user, inherited from the host process's
 * primary token (thread impersonation does not apply), as canonical SID text.
 * Every failure other than the caller's abort reason is `principal_unavailable`
 * and carries no SID, path or child output.
 */
export function windowsPrincipalObserver(
  file: string,
): (signal?: AbortSignal) => Promise<string> {
  const helper = trustedWindowsHelper(file);
  return (signal) => windowsPrincipal(helper('token-user', signal), signal);
}

/** Maps one bounded `token-user` run to its SID or the fixed refusal. */
export async function windowsPrincipal(
  receipt: Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  let sid: string | null = null;
  try {
    sid = windowsPrincipalSid(await receipt);
  } catch (error) {
    if (signal?.aborted && error === signal.reason) throw error;
  }
  if (sid === null)
    throw new LocalAuthorityIdentityError('principal_unavailable');
  return sid;
}

/** `S-1-` + 15-digit authority + 15 × (`-` + 10-digit subauthority). */
const WINDOWS_SID_MAX = 184;
const WINDOWS_PRINCIPAL_RECEIPT_MAX =
  'canopy-principal-v1 '.length + WINDOWS_SID_MAX + 2;

/**
 * Pinned receipt `canopy-principal-v1 <sid>` + LF or CRLF, exactly once. The
 * SID is revision 1 with an unsigned decimal 48-bit identifier authority and
 * 0..15 unsigned decimal 32-bit subauthorities, without leading zeroes.
 * Returns null for anything else; structure alone never makes a SID trusted.
 */
export function windowsPrincipalSid(text: string): string | null {
  if (text.length > WINDOWS_PRINCIPAL_RECEIPT_MAX) return null;
  const row =
    /^canopy-principal-v1 S-1-(0|[1-9]\d{0,14})((?:-(?:0|[1-9]\d{0,9})){0,15})\r?\n$/.exec(
      text,
    );
  if (!row || row[1] === undefined || row[2] === undefined) return null;
  if (Number(row[1]) > 0xffffffffffff) return null;
  const parts = row[2].split('-').slice(1);
  if (parts.some((part) => Number(part) > 0xffffffff)) return null;
  return `S-1-${row[1]}${row[2]}`;
}

/** FILETIME remains an integer until whole seconds are safely representable. */
export function windowsStartIdentity(text: string, pid: number): string | null {
  const row = /^canopy-process-v1 ([1-9]\d{0,9}) ([1-9]\d{0,18})\r?\n$/.exec(
    text,
  );
  if (!row || row[1] !== String(pid) || row[2] === undefined) return null;
  const ticks = BigInt(row[2]);
  if (ticks <= BigInt(9) || ticks > BigInt('2650467743999999999')) return null;
  const date = new Date(
    Number(ticks / BigInt(10000000) - BigInt(11644473600)) * 1000,
  );
  const digits = date.toISOString().slice(0, 19).replace(/[-T:]/g, '');
  const micros = ((ticks % BigInt(10000000)) / BigInt(10))
    .toString()
    .padStart(6, '0');
  return `win32:v1:${pid}:${digits}${micros}`;
}
