import * as fs from 'node:fs';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { request as httpRequest } from 'node:http';
import {
  CodexMcpLauncherError,
  codexMcpRouteAuthFileName,
  ensureCodexMcpBrokerRuntimeDir,
  getCodexMcpBrokerRuntimeDir,
  isCodexMcpRouteId,
} from './rendezvous';

export {
  CodexMcpLauncherError,
  type CodexMcpLauncherErrorMessage,
} from './rendezvous';

export interface CodexMcpLaunchRequest {
  readonly capabilityId: string;
  readonly routeId: string;
}

export interface CodexMcpLauncherIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  onceSignal(signal: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  /** `process.kill(pid, 0)` succeeded. */
  isAlive(pid: number): boolean;
  /** Defaults to getCodexMcpBrokerRuntimeDir(). */
  readonly runtimeDir?: string;
}

interface BrokerLocator {
  version: 3;
  port: number;
  parentPid: number;
}

interface BrokerRouteAuth {
  version: 1;
  routeId: string;
  capabilityId: string;
  launchToken: string;
  parentPid: number;
}

export function processCodexMcpLauncherIo(): CodexMcpLauncherIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    onceSignal: (signal, listener) => {
      process.once(signal, listener);
    },
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function openOwnerOnlyFile(filePath: string): number {
  const descriptor = fs.openSync(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new CodexMcpLauncherError('Invalid MCP broker runtime file');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new CodexMcpLauncherError(
        'MCP broker runtime file permissions are too broad',
      );
    }
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      stat.uid !== process.getuid()
    ) {
      throw new CodexMcpLauncherError(
        'MCP broker runtime file has an unexpected owner',
      );
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function readLocator(runtimeDir: string, routeId: string): BrokerLocator {
  const brokerId = routeId.split('.')[0];
  if (!brokerId || !/^[a-f0-9]{32}$/.test(brokerId)) {
    throw new CodexMcpLauncherError('Invalid MCP broker route');
  }
  ensureCodexMcpBrokerRuntimeDir(runtimeDir);
  const locatorPath = path.join(runtimeDir, `${brokerId}.json`);
  const descriptor = openOwnerOnlyFile(locatorPath);
  try {
    const locator = JSON.parse(
      fs.readFileSync(descriptor, 'utf8'),
    ) as BrokerLocator;
    if (
      locator.version !== 3 ||
      !Number.isSafeInteger(locator.port) ||
      locator.port <= 0 ||
      !Number.isSafeInteger(locator.parentPid) ||
      locator.parentPid <= 0
    ) {
      throw new CodexMcpLauncherError('Invalid MCP broker locator');
    }
    return locator;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRouteAuth(
  resolveRuntimeDir: () => string,
  routeId: string,
  capabilityId: string,
): { auth: BrokerRouteAuth; runtimeDir: string } {
  if (!isCodexMcpRouteId(routeId) || !/^[a-f0-9]{64}$/.test(capabilityId)) {
    throw new CodexMcpLauncherError('Invalid MCP launcher route');
  }
  const runtimeDir = resolveRuntimeDir();
  ensureCodexMcpBrokerRuntimeDir(runtimeDir);
  const authPath = path.join(runtimeDir, codexMcpRouteAuthFileName(routeId));
  const descriptor = openOwnerOnlyFile(authPath);
  try {
    const auth = JSON.parse(
      fs.readFileSync(descriptor, 'utf8'),
    ) as BrokerRouteAuth;
    if (
      auth.version !== 1 ||
      auth.routeId !== routeId ||
      auth.capabilityId !== capabilityId ||
      !/^[a-f0-9]{64}$/.test(auth.launchToken) ||
      !Number.isSafeInteger(auth.parentPid) ||
      auth.parentPid <= 0
    ) {
      throw new CodexMcpLauncherError('Invalid MCP launcher authentication');
    }
    return { auth, runtimeDir };
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Relay one registered stdio MCP route (CAN-4117): validate the owner-only
 * route ticket and broker locator, then stream stdin to the parent broker's
 * launch route and its response to stdout.
 */
export async function runCodexMcpStdioLauncher(
  request: CodexMcpLaunchRequest,
  io: CodexMcpLauncherIo = processCodexMcpLauncherIo(),
): Promise<number> {
  const { capabilityId, routeId } = request;
  if (!capabilityId || !routeId) {
    throw new CodexMcpLauncherError('MCP launcher credentials are unavailable');
  }
  const { auth: routeAuth, runtimeDir } = readRouteAuth(
    () => io.runtimeDir ?? getCodexMcpBrokerRuntimeDir(),
    routeId,
    capabilityId,
  );
  const locator = readLocator(runtimeDir, routeId);
  if (locator.parentPid !== routeAuth.parentPid) {
    throw new CodexMcpLauncherError('MCP broker identity mismatch');
  }
  if (!io.isAlive(locator.parentPid)) {
    throw new CodexMcpLauncherError('MCP broker parent is no longer running');
  }
  return await new Promise<number>((resolve, reject) => {
    const launchRequest = httpRequest({
      hostname: '127.0.0.1',
      port: locator.port,
      path: `/launch/${routeId}`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${routeAuth.launchToken}`,
        'content-type': 'application/octet-stream',
      },
    });
    launchRequest.once('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new CodexMcpLauncherError('MCP launch route is unavailable'));
        return;
      }
      response.pipe(io.stdout);
      response.once('end', () => resolve(0));
      response.once('error', reject);
    });
    launchRequest.once('error', reject);
    io.onceSignal('SIGTERM', () => launchRequest.destroy());
    io.onceSignal('SIGINT', () => launchRequest.destroy());
    io.stdin.pipe(launchRequest);
  });
}
