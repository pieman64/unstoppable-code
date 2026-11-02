import { AsyncResource } from 'node:async_hooks';
import { closeSync } from 'node:fs';
import { Socket } from 'node:net';

/** Staged beside the daemon executable; built from `packages/core-platform/native/windows-pipe`. */
export const WINDOWS_PIPE_SECURITY_FILE = 'windows-pipe-security.node';

/**
 * The native addon. Every pipe instance is created with an owner-only
 * descriptor in its SECURITY_ATTRIBUTES, so no permissive default ever
 * exists. Results are `unknown` and validated here.
 */
export interface WindowsPipeSecurity {
  /** Process token user SID; throws when unreadable. */
  userSid(): unknown;
  /** First instance (FILE_FLAG_FIRST_PIPE_INSTANCE); `null` when the name is taken. */
  createServer(path: string): unknown;
  /** JSON owner/DACL receipt read from the live handle. */
  describe(server: object): unknown;
  /** Starts the accept thread; `fd` is a connected instance in Node's CRT. */
  listen(
    server: object,
    onConnection: (error: unknown, fd: unknown) => void,
  ): unknown;
  /** Idempotent; no callback runs after it returns. */
  close(server: object): unknown;
}

const UNAVAILABLE = 'Named pipe security is unavailable.';
const METHODS = ['userSid', 'createServer', 'describe', 'listen', 'close'];

function isWindowsPipeSecurity(value: unknown): value is WindowsPipeSecurity {
  if (typeof value !== 'object' || value === null) return false;
  return METHODS.every(
    (method) =>
      typeof Object.getOwnPropertyDescriptor(value, method)?.value ===
      'function',
  );
}

/** Loads the addon from an explicit staged path; anything else fails closed. */
export function loadWindowsPipeSecurity(file: string): WindowsPipeSecurity {
  const module = { exports: {} };
  try {
    process.dlopen(module, file);
  } catch {
    throw new Error(UNAVAILABLE);
  }
  if (!isWindowsPipeSecurity(module.exports)) throw new Error(UNAVAILABLE);
  return module.exports;
}

// FILE_GENERIC_READ | FILE_GENERIC_WRITE. The server needs FILE_CREATE_PIPE_INSTANCE
// (inside FILE_GENERIC_WRITE) for each later instance, so the owner keeps it.
export const OWNER_PIPE_ACCESS = 0x0012019f;
const SID = /^S-1(-\d+)+$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Owner-only means: owner and the single allow ACE are this process's user,
 * the DACL is protected from inheritance, and nothing else is granted.
 * Returns `null` when private, else the reason.
 */
export function evaluatePipeDescriptor(text: unknown): string | null {
  let receipt: unknown;
  try {
    receipt = typeof text === 'string' ? JSON.parse(text) : undefined;
  } catch {
    receipt = undefined;
  }
  if (!isRecord(receipt) || !Array.isArray(receipt.aces))
    return 'receipt is malformed';
  const { user, owner } = receipt;
  if (typeof user !== 'string' || !SID.test(user))
    return 'user identity is unknown';
  if (owner !== user) return 'owned by another account';
  if (receipt.protected !== true) return 'DACL inherits entries';
  const aces: unknown[] = receipt.aces;
  const [ace, ...rest] = aces;
  if (rest.length > 0 || !isRecord(ace)) return 'DACL is not owner-only';
  if (ace.type !== 0 || ace.flags !== 0 || ace.sid !== user)
    return 'DACL is not owner-only';
  if (ace.mask !== OWNER_PIPE_ACCESS) return 'owner access mask differs';
  return null;
}

/** Verified, accepting server; connected sockets arrive through `admit`. */
export interface SecurePipeServer {
  /** Closes the pending instance and every undelivered connection. */
  close(): void;
}

/**
 * Creates the first instance, verifies its descriptor, then accepts. Any
 * startup failure closes the native server before rethrowing, so nothing is
 * published. After an accept failure the server stops accepting but keeps its
 * pending instance until `close`: pipe names are global, so releasing it early
 * would let another user claim the name a published descriptor points to.
 */
export function openSecurePipe(
  native: WindowsPipeSecurity,
  path: string,
  admit: (socket: Socket) => void,
): SecurePipeServer | 'in-use' {
  const server = native.createServer(path);
  if (server === null) return 'in-use';
  if (typeof server !== 'object') throw new Error(UNAVAILABLE);
  let closed = false;
  let failed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    native.close(server);
  };
  // Bound to this call's async context: Node 24's N-API threadsafe-function
  // callback does not restore the AsyncLocalStorage frame, so connections
  // (and their socket events) would otherwise escape the caller's closure run.
  const deliver = AsyncResource.bind((error: unknown, fd: unknown): void => {
    if (closed || failed) return;
    if (error !== null || typeof fd !== 'number' || !Number.isInteger(fd)) {
      failed = true;
      return;
    }
    let socket: Socket;
    try {
      socket = new Socket({ fd, readable: true, writable: true });
    } catch {
      closeSync(fd);
      return;
    }
    admit(socket);
  });
  try {
    if (evaluatePipeDescriptor(native.describe(server)) !== null)
      throw new Error('Pipe access unverified.');
    native.listen(server, deliver);
  } catch (error) {
    close();
    throw error;
  }
  return { close };
}
