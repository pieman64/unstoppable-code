import {
  execFile,
  type ChildProcess,
  type ExecFileOptionsWithStringEncoding,
} from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import {
  isCanonicalWindowsSid,
  LocalAuthorityIdentityError,
} from '../local-authority';
import { observeWindowsClosure } from './windows-closure';

type WindowsContinuityObservation = {
  readonly pid: number;
  readonly image: string;
  readonly creationIdentity: string;
  readonly scope: string;
};
type WindowsContinuityChange = {
  readonly before: WindowsContinuityObservation;
  readonly after: WindowsContinuityObservation;
};
/** Incomplete inspection remains a refusal, including corroborated PID reuse. */
export class WindowsColdInspectionError extends Error {
  readonly code = 'inspection-incomplete';
  readonly reason: 'retry-exhausted' | 'pid-reuse';
  readonly pid: number;
  readonly image: string;
  readonly startIdentity: string;
  readonly stage:
    | 'image-name'
    | 'mapping-query'
    | 'mapping-name'
    | 'process-continuity';
  readonly attempts?: number;
  readonly elapsedMs?: number;
  readonly before?: WindowsContinuityObservation;
  readonly after?: WindowsContinuityObservation;
  constructor(
    ...args:
      | [
          pid: number,
          image: string,
          stage: 'image-name' | 'mapping-query' | 'mapping-name',
          attempts: number,
          elapsedMs: number,
          ticks: string,
        ]
      | [change: WindowsContinuityChange]
  ) {
    const first = args[0];
    const change = typeof first === 'number' ? undefined : first;
    const pid = typeof first === 'number' ? first : first.before.pid;
    const image = typeof first === 'number' ? args[1] : first.before.image;
    super(
      change
        ? `process identity changed (pid ${pid}): ${change.before.image} -> ${change.after.image}; retry cold inspection`
        : `close ${image} (pid ${pid}) and retry`,
    );
    this.name = 'WindowsColdInspectionError';
    this.pid = pid;
    this.image = image ?? '';
    if (typeof first === 'number') {
      this.reason = 'retry-exhausted';
      this.stage = args[2] ?? 'image-name';
      this.attempts = args[3];
      this.elapsedMs = args[4];
      this.startIdentity = `win32:v1:${pid}:${args[5]}`;
    } else {
      this.reason = 'pid-reuse';
      this.stage = 'process-continuity';
      this.before = first.before;
      this.after = first.after;
      this.startIdentity = `win32:v1:${pid}:${first.before.creationIdentity}`;
    }
  }
}
function coldPidReuse(stderr: string): WindowsColdInspectionError | undefined {
  const lines = stderr.replace(/\r\n/g, '\n').split('\n');
  const receipts = lines.filter((line) =>
    line.startsWith('canopy-cold-pid-reuse-'),
  );
  if (receipts.length !== 1 || !stderr.endsWith('\n')) return undefined;
  const receipt =
    /^canopy-cold-pid-reuse-v1 ([1-9]\d*) ([a-z-]+) (\d{20}) ((?:[0-9a-f]{4}){1,32768}) ([a-z-]+) (\d{20}) ((?:[0-9a-f]{4}){1,32768})$/.exec(
      receipts[0] ?? '',
    );
  if (!receipt) return undefined;
  const [
    ,
    pidText,
    beforeScope,
    beforeTicks,
    beforeImage,
    afterScope,
    afterTicks,
    afterImage,
  ] = receipt;
  const pid = Number(pidText);
  const observation = (
    scope?: string,
    ticks?: string,
    encoded?: string,
  ): WindowsContinuityObservation | undefined => {
    if (
      !scope ||
      !ticks ||
      !encoded ||
      ![
        'same-owner',
        'same-token',
        'foreign-owner',
        'foreign-token',
        'owner-rights-denied',
        'kernel-idle',
        'post-t',
        'exited',
      ].includes(scope) ||
      BigInt(ticks) > 2650467743999999999n ||
      (BigInt(ticks) > 0n && BigInt(ticks) <= 9n)
    )
      return undefined;
    const image = (encoded.match(/.{4}/g) ?? [])
      .map((code) => String.fromCharCode(parseInt(code, 16)))
      .join('');
    if (image.includes('\0')) return undefined;
    return { pid, image, scope, creationIdentity: ticks };
  };
  if (pid < 2 || pid > 2147483647) return undefined;
  const before = observation(beforeScope, beforeTicks, beforeImage);
  const after = observation(afterScope, afterTicks, afterImage);
  if (
    !before ||
    !after ||
    (before.image === after.image &&
      (before.creationIdentity === after.creationIdentity ||
        BigInt(before.creationIdentity) === 0n ||
        BigInt(after.creationIdentity) === 0n))
  )
    return undefined;
  return new WindowsColdInspectionError({ before, after });
}
function coldRetryExhaustion(
  stderr: string,
): WindowsColdInspectionError | undefined {
  const receipts = stderr
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => line.startsWith('canopy-cold-retry-exhausted-'));
  if (receipts.length !== 1 || !stderr.endsWith('\n')) return undefined;
  const receipt =
    /^canopy-cold-retry-exhausted-v1 ([1-9]\d*) (\d{20}) (image-name|mapping-query|mapping-name) ([1-7]) ([1-9]\d*) ((?:[0-9a-f]{4}){1,32768})$/.exec(
      receipts[0] ?? '',
    );
  if (!receipt) return undefined;
  const [, pidText, ticks, stage, attemptsText, elapsedText, encoded] = receipt;
  if (
    !ticks ||
    !encoded ||
    (stage !== 'image-name' &&
      stage !== 'mapping-query' &&
      stage !== 'mapping-name')
  )
    return undefined;
  const pid = Number(pidText),
    elapsed = Number(elapsedText);
  if (
    pid < 2 ||
    pid > 2147483647 ||
    BigInt(ticks) <= 9n ||
    BigInt(ticks) > 2650467743999999999n ||
    !Number.isSafeInteger(elapsed) ||
    elapsed < 1000
  )
    return undefined;
  const image = (encoded.match(/.{4}/g) ?? [])
    .map((code) => String.fromCharCode(parseInt(code, 16)))
    .join('');
  if (image.includes('\0')) return undefined;
  return new WindowsColdInspectionError(
    pid,
    image,
    stage,
    Number(attemptsText),
    elapsed,
    ticks,
  );
}

function coldTypedRefusal(
  stderr: string,
): WindowsColdInspectionError | undefined {
  if (
    stderr
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.startsWith('canopy-cold-')).length !== 1
  )
    return undefined;
  return coldPidReuse(stderr) ?? coldRetryExhaustion(stderr);
}

export const WINDOWS_PROCESS_FILE = 'canopy-process-identity.exe';
/** Legacy identity requests plus inactive, bounded cold-observation modes. */
type WindowsHelperRequest =
  | number
  | 'token-user'
  | { readonly mode: 'cold-snapshot' | 'cold-process'; readonly pid: number };
const failure = (): Error =>
  new Error('Windows process observation unavailable');
function coldFailure(cause: unknown, stderr = ''): Error {
  // Only fixed native stage/number fields enter the message, never paths or payloads.
  const snapshot =
    /^cold snapshot incomplete stage=([A-Za-z0-9 (),:/_-]{1,160}) pid=(\d{1,10}) win32=(\d{1,10})\r?$/m.exec(
      stderr,
    );
  const enumeration =
    /^cold enumeration incomplete stage=([A-Za-z0-9 (),:/_-]{1,160}) pid=(\d{1,10}) image=[^\r\n]* win32=(\d{1,10})\r?$/m.exec(
      stderr,
    );
  const row =
    /^refused pid=(\d{1,10}) stage=([A-Za-z0-9 ():/_-]{1,160}) access=0x[0-9a-f]{8} win32=(\d{1,10}) ntstatus=0x([0-9a-f]{8}) /m.exec(
      stderr,
    );
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause
      ? String(cause.code)
      : '';
  const details = [
    /^(?:[A-Z_]{1,48}|\d{1,10})$/.test(code) ? `helper code=${code}` : '',
    row
      ? `pid=${row[1]} stage=${row[2]} win32=${row[3]} ntstatus=0x${row[4]}`
      : '',
    snapshot
      ? `stage=${snapshot[1]} pid=${snapshot[2]} win32=${snapshot[3]}`
      : '',
    enumeration
      ? `stage=${enumeration[1]} pid=${enumeration[2]} win32=${enumeration[3]}`
      : '',
  ].filter(Boolean);
  return Object.assign(
    new Error(
      `Windows process observation unavailable${details.length ? ` (${details.join('; ')})` : ''}`,
    ),
    { cause },
  );
}
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
 * Every mode shares four-child admission; cold observations have larger bounds.
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
  const cold = typeof request === 'object';
  const limit = cold ? 64 * 1024 * 1024 : 64 * 1024;
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
    const timer = setTimeout(
      () =>
        stop(
          cold
            ? coldFailure(
                Object.assign(new Error('Windows helper deadline exceeded'), {
                  code: 'ETIMEDOUT',
                }),
              )
            : failure(),
        ),
      cold ? 30_000 : 4000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    const startChild = (): void => {
      try {
        child = (execute ?? execFile)(
          file,
          typeof request === 'object'
            ? [`--${request.mode}`, String(request.pid)]
            : [request === 'token-user' ? '--token-user' : String(request)],
          {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: limit,
            cwd: path.win32.dirname(file),
            env: {},
          },
          (error, stdout, stderr) => {
            if (error || stderr !== '' || Buffer.byteLength(stdout) > limit) {
              const denial =
                cold &&
                error &&
                'code' in error &&
                error.code === 1 &&
                Buffer.byteLength(stdout) <= limit &&
                Buffer.byteLength(stderr) <= limit
                  ? coldTypedRefusal(stderr)
                  : undefined;
              stop(denial ?? (cold ? coldFailure(error, stderr) : failure()));
            } else {
              callbackResult = stdout;
              if (closed) settle(undefined, stdout);
            }
          },
        );
        child.on('error', (error) =>
          stop(cold ? coldFailure(error) : failure()),
        );
        child.once('close', (code, exitSignal) => {
          release();
          closed = true;
          if (code !== 0 || exitSignal !== null) {
            closure?.unsafe();
            settle(
              cold
                ? coldFailure(
                    Object.assign(new Error('Windows helper closed'), {
                      code: code ?? 'SIGNALLED',
                      signal: exitSignal,
                    }),
                  )
                : failure(),
            );
          } else if (callbackResult !== undefined)
            settle(undefined, callbackResult);
          else {
            closure?.unsafe();
            settle(
              cold
                ? coldFailure(
                    Object.assign(new Error('Windows helper receipt missing'), {
                      code: 'INCOMPLETE_RECEIPT',
                    }),
                  )
                : failure(),
            );
          }
        });
        if (signal?.aborted) abort();
      } catch (error) {
        // execFile threw without returning a child; there can be no close event.
        closure?.unsafe();
        release();
        settle(
          signal?.aborted
            ? signal.reason
            : cold
              ? coldFailure(error)
              : failure(),
        );
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
          (error: unknown) => {
            closure?.unsafe();
            release();
            settle(
              signal?.aborted
                ? signal.reason
                : cold
                  ? coldFailure(error)
                  : failure(),
            );
          },
        );
    } else startChild();
  });
}

/**
 * Host-supplied absolute location only; no PATH, environment or CWD search.
 * Every observer applies the same path and per-launch PE checks to one file.
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

/** Inactive migration foundation; uses the same host-selected PE helper and closure bounds. */
export function windowsColdObservation(
  file: string,
  mode: 'cold-snapshot' | 'cold-process',
  pid: number,
): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2147483647)
    return Promise.reject(refused());
  return trustedWindowsHelper(file)({ mode, pid });
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
 * Pinned receipt `canopy-principal-v1 <sid>` + LF or CRLF, exactly once, with
 * the canonical SID text the authority digest encodes (`isCanonicalWindowsSid`).
 * Returns null for anything else; structure alone never makes a SID trusted.
 */
export function windowsPrincipalSid(text: string): string | null {
  if (text.length > WINDOWS_PRINCIPAL_RECEIPT_MAX) return null;
  const sid = /^canopy-principal-v1 (S-[-0-9]*)\r?\n$/.exec(text)?.[1];
  return sid !== undefined && isCanonicalWindowsSid(sid) ? sid : null;
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
