import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

/** The desktop supplies its off-main process host; this module never spawns. */
export interface DelegationFileProcess {
  readonly stdin: Pick<Writable, 'write' | 'end'>;
  readonly stdout: Pick<Readable, 'on' | 'off'>;
  readonly exited: Promise<void>;
  terminate(): void;
}

export interface DelegationFileEntry {
  readonly path: string;
  readonly directory: boolean;
}

/** Host operating system the desktop supplies; this module never reads it. */
export type DelegationHostOperatingSystem = 'darwin' | 'win32' | 'linux';

export interface NativeAssetFileSnapshot {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly modifiedNs: string;
  readonly changedNs: string;
}

function assetFileSnapshot(
  version: string,
  size: number,
  hostOs: DelegationHostOperatingSystem,
): NativeAssetFileSnapshot {
  const fields = version.split(':');
  // The broker's identity format follows the host it was compiled for.
  if (hostOs === 'win32') {
    if (
      fields.length !== 6 ||
      fields.some((field) => !/^(0|[1-9][0-9]*)$/.test(field)) ||
      Number(fields[3]) !== size
    ) {
      throw new Error('Invalid original asset identity.');
    }
    const [
      device,
      inodeHigh,
      inodeLow,
      snapshotSize,
      modifiedTime,
      changedTime,
    ] = fields;
    if (
      !device ||
      !inodeHigh ||
      !inodeLow ||
      !snapshotSize ||
      !modifiedTime ||
      !changedTime ||
      BigInt(inodeHigh) > BigInt(0xffffffff) ||
      BigInt(inodeLow) > BigInt(0xffffffff)
    ) {
      throw new Error('Invalid original asset identity.');
    }
    return {
      device,
      inode: ((BigInt(inodeHigh) << BigInt(32)) | BigInt(inodeLow)).toString(),
      size: snapshotSize,
      modifiedNs: (
        (BigInt(modifiedTime) - BigInt('116444736000000000')) *
        BigInt(100)
      ).toString(),
      changedNs: (
        (BigInt(changedTime) - BigInt('116444736000000000')) *
        BigInt(100)
      ).toString(),
    };
  }
  if (
    fields.length !== 7 ||
    fields.some((field) => !/^-?(0|[1-9][0-9]*)$/.test(field)) ||
    Number(fields[2]) !== size
  ) {
    throw new Error('Invalid original asset identity.');
  }
  const [
    device,
    inode,
    snapshotSize,
    modifiedSeconds,
    modifiedNanos,
    changedSeconds,
    changedNanos,
  ] = fields;
  if (
    !device ||
    !inode ||
    !snapshotSize ||
    !modifiedSeconds ||
    !modifiedNanos ||
    !changedSeconds ||
    !changedNanos ||
    BigInt(modifiedNanos) < BigInt(0) ||
    BigInt(modifiedNanos) >= BigInt(1000000000) ||
    BigInt(changedNanos) < BigInt(0) ||
    BigInt(changedNanos) >= BigInt(1000000000)
  ) {
    throw new Error('Invalid original asset identity.');
  }
  return {
    device,
    inode,
    size: snapshotSize,
    modifiedNs: (
      BigInt(modifiedSeconds) * BigInt(1000000000) +
      BigInt(modifiedNanos)
    ).toString(),
    changedNs: (
      BigInt(changedSeconds) * BigInt(1000000000) +
      BigInt(changedNanos)
    ).toString(),
  };
}

export interface DelegationSearchResult {
  readonly matches: readonly { path: string; line: number; text: string }[];
  readonly truncated: boolean;
  readonly filesRead: number;
}

/** Largest file a default session reads or writes, and the listing bound. */
export const DELEGATION_FILE_DEFAULT_BYTES = 65_536;
/** Largest per-file bound a session may request (isolated apply uses it). */
export const DELEGATION_FILE_MAX_BYTES = 33_554_432;

/** Per-session limits. The native helper receives the same file bound. */
export interface DelegationFileLimits {
  /** Largest file read, compared or written; defaults to 64 KiB. */
  readonly fileBytes?: number;
  /** Bytes all responses may return; defaults to 32 MiB. */
  readonly totalBytes?: number;
}

/**
 * - `refused`: the native boundary refused the request. It does not say why:
 *   missing, protected, linked, not a regular file, over the session's file
 *   bound, or (for a write) content other than the expected text.
 * - `not_text`: the file is binary or not UTF-8.
 * - `closed`: the helper stopped, timed out, or was cancelled.
 */
export type DelegationFileErrorKind = 'refused' | 'not_text' | 'closed';

export class DelegationFileAccessError extends Error {
  constructor(
    readonly kind: DelegationFileErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'DelegationFileAccessError';
  }
}

const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

/** Win32 resolves these names to a different file than the one written:
 * trailing dots and spaces are stripped (`.env ` opens `.env`), `~N` is an 8.3
 * short-name alias for an arbitrary long name, and device names ignore their
 * directory and extension. The native broker checks the real long name; the
 * Node-side checks reject the aliases instead. */
export function windowsNameAlias(part: string): boolean {
  return (
    /[. ]$/.test(part) || /~[0-9]/.test(part) || WINDOWS_DEVICE_NAME.test(part)
  );
}

/** A `/`-separated relative path from root to file, for the POSIX-form
 * validators and persisted change records, on every platform. */
export function delegationRelativePath(
  root: string,
  file: string,
  pathApi: Pick<typeof path, 'relative' | 'sep'> = path,
): string {
  return pathApi.relative(root, file).split(pathApi.sep).join('/');
}

/** Validation is repeated by the native boundary, including every component. */
export function validDelegationPath(
  value: unknown,
  directory = false,
  platform: NodeJS.Platform = process.platform,
): value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') >= 4096)
    return false;
  if (!value) return directory;
  return value.split('/').every((part) => {
    const lower = part.toLowerCase();
    return (
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      !(platform === 'win32' && windowsNameAlias(part)) &&
      !Array.from(part).some(
        (character) =>
          character.charCodeAt(0) < 32 ||
          character === '\\' ||
          character === ':',
      ) &&
      ![
        '.git',
        '.codex',
        '.claude',
        '.ssh',
        '.aws',
        '.kube',
        '.config',
        '.canopy',
        '.npmrc',
        '.netrc',
        'auth.json',
        'credentials',
      ].includes(lower) &&
      !lower.startsWith('.env') &&
      !lower.endsWith('.pem') &&
      !lower.endsWith('.key')
    );
  });
}

/** Whether a requested per-file bound is one the native helper accepts. */
export function validDelegationFileBytes(value: number | undefined): boolean {
  return (
    value === undefined ||
    (Number.isSafeInteger(value) &&
      value > 0 &&
      value <= DELEGATION_FILE_MAX_BYTES)
  );
}

/** One fixed helper, one pinned root, serialized bounded requests, no shell. */
export class NativeDelegationFiles {
  private buffer: Buffer = Buffer.alloc(0);
  private pending?: {
    resolve: (value: Buffer) => void;
    reject: (error: Error) => void;
  };
  private expected?: number;
  private ready = false;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private remainingBytes: number;
  private readonly fileBytes: number;
  private readonly signal: AbortSignal;
  private readonly onData = (chunk: unknown): void => {
    if (
      !Buffer.isBuffer(chunk) ||
      this.buffer.length + chunk.length >
        Math.max(this.fileBytes, DELEGATION_FILE_DEFAULT_BYTES) + 65_568
    ) {
      this.fail();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.expected === undefined) {
      const newline = this.buffer.indexOf(10);
      if (newline === -1) {
        if (this.buffer.length > 32) this.fail();
        return;
      }
      const header = this.buffer.subarray(0, newline).toString('ascii');
      this.buffer = this.buffer.subarray(newline + 1);
      if (header === 'READY' && !this.ready) {
        this.ready = true;
        this.complete(Buffer.alloc(0));
        return;
      }
      if (!this.ready || !this.pending) {
        this.fail();
        return;
      }
      if (header === 'ERR') {
        this.rejectPending(
          new DelegationFileAccessError(
            'refused',
            'File access was denied or the expected file content changed.',
          ),
        );
        return;
      }
      if (!/^OK (0|[1-9][0-9]{0,8})$/.test(header)) {
        this.fail();
        return;
      }
      this.expected = Number(header.slice(3));
      if (
        this.expected > Math.max(this.fileBytes, DELEGATION_FILE_DEFAULT_BYTES)
      ) {
        this.fail();
        return;
      }
    }
    if (this.buffer.length >= this.expected) {
      const result = Buffer.from(this.buffer.subarray(0, this.expected));
      this.buffer = this.buffer.subarray(this.expected);
      this.expected = undefined;
      if (this.buffer.length) {
        this.fail();
        return;
      }
      this.complete(result);
    }
  };
  private readonly onAbort = (): void => this.fail();

  private constructor(
    private readonly process: DelegationFileProcess,
    signal: AbortSignal,
    limits: DelegationFileLimits,
    private readonly hostOs: DelegationHostOperatingSystem | undefined,
  ) {
    this.signal = signal;
    this.fileBytes = limits.fileBytes ?? DELEGATION_FILE_DEFAULT_BYTES;
    this.remainingBytes = limits.totalBytes ?? 33_554_432;
    process.stdout.on('data', this.onData);
    signal.addEventListener('abort', this.onAbort, { once: true });
    void process.exited.then(
      () => this.fail(),
      () => this.fail(),
    );
  }

  /**
   * `limits.fileBytes` must match the bound the helper was started with.
   * `hostOs` is the host the helper runs on; original asset reads need it to
   * decode the helper's file identity.
   */
  static async open(
    process: DelegationFileProcess,
    signal: AbortSignal,
    limits: DelegationFileLimits = {},
    hostOs?: DelegationHostOperatingSystem,
  ): Promise<NativeDelegationFiles> {
    if (!validDelegationFileBytes(limits.fileBytes))
      throw new Error('Invalid delegated file bound.');
    const access = new NativeDelegationFiles(process, signal, limits, hostOs);
    try {
      await access.response();
      return access;
    } catch (error) {
      await access.close();
      throw error;
    }
  }

  async read(relativePath: string): Promise<string> {
    if (!validDelegationPath(relativePath))
      throw new Error('Invalid read-only file path.');
    const bytes = await this.request(`R\t${relativePath}\n`);
    if (bytes.includes(0))
      throw new DelegationFileAccessError(
        'not_text',
        'Binary files are unavailable to this delegation.',
      );
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new DelegationFileAccessError(
        'not_text',
        'Files that are not UTF-8 text are unavailable to this delegation.',
      );
    }
  }

  async readAsset(
    relativePath: string,
    offset: number,
  ): Promise<{
    bytes: Buffer;
    size: number;
    version: string;
    snapshot: NativeAssetFileSnapshot;
  }> {
    // ':' names a drive or an alternate data stream only on Windows; on POSIX
    // hosts it is an ordinary name character. Fail closed for unknown hosts.
    const colonAllowed = this.hostOs === 'darwin' || this.hostOs === 'linux';
    if (
      !relativePath ||
      Buffer.byteLength(relativePath, 'utf8') >= 4096 ||
      relativePath
        .split('/')
        .some(
          (part) =>
            !part ||
            part === '.' ||
            part === '..' ||
            Array.from(part).some(
              (character) =>
                character.charCodeAt(0) < 32 ||
                character === '\\' ||
                (character === ':' && !colonAllowed),
            ),
        ) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > 104_857_600
    )
      throw new Error('Invalid original asset range or path.');
    const response = await this.request(`A\t${relativePath}\t${offset}\n`);
    const newline = response.indexOf(10);
    const metadata = response.subarray(0, newline).toString('ascii');
    const fields = /^(0|[1-9][0-9]*)\t([0-9:-]+)$/.exec(metadata);
    if (newline < 0 || newline > 288 || !fields) {
      this.fail();
      throw new Error('Invalid original asset metadata.');
    }
    const size = Number(fields[1]);
    const bytes = response.subarray(newline + 1);
    if (
      !Number.isSafeInteger(size) ||
      size > 104_857_600 ||
      offset > size ||
      bytes.length !== Math.min(196_608, size - offset)
    ) {
      this.fail();
      throw new Error('Invalid original asset chunk.');
    }
    let snapshot: NativeAssetFileSnapshot;
    try {
      if (!this.hostOs)
        throw new Error('Original asset reads need the host platform.');
      snapshot = assetFileSnapshot(fields[2], size, this.hostOs);
    } catch (error) {
      this.fail();
      throw error;
    }
    return {
      bytes,
      size,
      version: createHash('sha256').update(fields[2]).digest('hex'),
      snapshot,
    };
  }

  /** Compare against exact previously read content; null means create/delete. */
  async write(
    relativePath: string,
    expected: string | null,
    text: string | null,
  ): Promise<void> {
    if (
      !validDelegationPath(relativePath) ||
      (expected === null && text === null)
    )
      throw new Error('Invalid delegated edit.');
    const before = Buffer.from(expected ?? '', 'utf8');
    const after = Buffer.from(text ?? '', 'utf8');
    if (before.length > this.fileBytes || after.length > this.fileBytes)
      throw new Error('Delegated edit exceeds its byte limit.');
    await this.request(
      Buffer.concat([
        Buffer.from(
          `W\t${relativePath}\t${expected === null ? -1 : before.length}\t${text === null ? -1 : after.length}\n`,
          'utf8',
        ),
        before,
        after,
      ]),
    );
  }

  async list(relativeDirectory = ''): Promise<readonly DelegationFileEntry[]> {
    if (!validDelegationPath(relativeDirectory, true))
      throw new Error('Invalid read-only directory path.');
    const bytes = await this.request(`L\t${relativeDirectory}\n`);
    if (!bytes.length) return [];
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\0'))
      throw new Error('Invalid file broker directory response.');
    const entries = text
      .slice(0, -1)
      .split('\0')
      .map((entry) => {
        const name = entry.slice(1);
        if (
          (entry[0] !== 'D' && entry[0] !== 'F') ||
          name.includes('/') ||
          !validDelegationPath(name)
        )
          throw new Error('Invalid file broker entry.');
        return {
          path: relativeDirectory ? `${relativeDirectory}/${name}` : name,
          directory: entry[0] === 'D',
        };
      });
    return entries.sort((left, right) => left.path.localeCompare(right.path));
  }

  async search(
    needle: string,
    relativeDirectory = '',
    maxResults = 40,
  ): Promise<DelegationSearchResult> {
    if (
      !needle ||
      needle.length > 256 ||
      /[\0\r\n]/.test(needle) ||
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 100
    )
      throw new Error('Invalid bounded literal search.');
    const directories = [relativeDirectory];
    const matches: { path: string; line: number; text: string }[] = [];
    let filesRead = 0,
      directoriesRead = 0,
      bytesRead = 0,
      truncated = false;
    while (directories.length) {
      if (
        ++directoriesRead > 256 ||
        filesRead >= 512 ||
        bytesRead >= 16_777_216 ||
        matches.length >= maxResults
      ) {
        truncated = true;
        break;
      }
      const directory = directories.shift();
      if (directory === undefined) break;
      const entries = await this.list(directory);
      for (const entry of entries) {
        if (entry.directory) {
          if (
            directories.length < 512 &&
            entry.path.split('/').length <= 16 &&
            ![
              'node_modules',
              '.cache',
              '.playwright',
              'out',
              'out-e2e',
            ].includes(entry.path.split('/').pop() ?? '')
          )
            directories.push(entry.path);
          else truncated = true;
          continue;
        }
        if (
          filesRead >= 512 ||
          bytesRead >= 16_777_216 ||
          matches.length >= maxResults
        ) {
          truncated = true;
          break;
        }
        let text: string;
        try {
          text = await this.read(entry.path);
        } catch {
          if (this.closed) throw new Error('Read-only search was cancelled.');
          truncated = true;
          continue;
        }
        filesRead += 1;
        bytesRead += Buffer.byteLength(text, 'utf8');
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index];
          if (line?.includes(needle)) {
            matches.push({
              path: entry.path,
              line: index + 1,
              text: line.slice(0, 512),
            });
            if (matches.length >= maxResults) {
              truncated = true;
              break;
            }
          }
        }
      }
    }
    return { matches, truncated, filesRead };
  }

  async close(): Promise<void> {
    this.fail();
    await this.process.exited;
    this.process.stdout.off('data', this.onData);
    this.signal.removeEventListener('abort', this.onAbort);
  }

  private request(command: string | Buffer): Promise<Buffer> {
    const task = this.tail.then(async () => {
      const response = this.response();
      try {
        this.process.stdin.write(command, (error) => {
          if (error) this.fail();
        });
      } catch {
        this.fail();
      }
      const bytes = await response;
      this.remainingBytes -= bytes.length;
      if (this.remainingBytes < 0) {
        this.fail();
        throw new Error('Delegation file access budget exceeded.');
      }
      return bytes;
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private response(): Promise<Buffer> {
    if (this.closed || this.signal.aborted)
      return Promise.reject(
        new DelegationFileAccessError(
          'closed',
          'Delegation file access is closed.',
        ),
      );
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 5000);
      this.pending = {
        resolve: (value): void => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error): void => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private complete(bytes: Buffer): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(bytes);
  }
  private rejectPending(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }
  private fail(): void {
    this.rejectPending(
      new DelegationFileAccessError(
        'closed',
        'Delegation file access stopped.',
      ),
    );
    if (this.closed) return;
    this.closed = true;
    try {
      this.process.stdin.end();
    } catch {
      /* A disconnected pipe must not skip native termination. */
    }
    try {
      this.process.terminate();
    } catch {
      /* close still awaits native exit; the runner enforces its cleanup deadline. */
    }
  }
}
