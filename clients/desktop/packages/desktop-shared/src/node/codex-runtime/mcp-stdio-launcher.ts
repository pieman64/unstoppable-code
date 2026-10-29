import * as fs from 'node:fs';
import * as path from 'node:path';
import { constants } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { codexMcpRouteAuthFileName, isCodexMcpRouteId } from './mcp-stdio-auth';
import {
  ensureCodexMcpBrokerRuntimeDir,
  getCodexMcpBrokerRuntimeDir,
} from './mcp-runtime-dir';

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

function openOwnerOnlyFile(filePath: string): number {
  const descriptor = fs.openSync(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new Error('Invalid MCP broker runtime file');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('MCP broker runtime file permissions are too broad');
    }
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      stat.uid !== process.getuid()
    ) {
      throw new Error('MCP broker runtime file has an unexpected owner');
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function readLocator(routeId: string): BrokerLocator {
  const brokerId = routeId.split('.')[0];
  if (!brokerId || !/^[a-f0-9]{32}$/.test(brokerId)) {
    throw new Error('Invalid MCP broker route');
  }
  const runtimeDir = getCodexMcpBrokerRuntimeDir();
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
      throw new Error('Invalid MCP broker locator');
    }
    return locator;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRouteAuth(routeId: string, capabilityId: string): BrokerRouteAuth {
  if (!isCodexMcpRouteId(routeId) || !/^[a-f0-9]{64}$/.test(capabilityId)) {
    throw new Error('Invalid MCP launcher route');
  }
  const runtimeDir = getCodexMcpBrokerRuntimeDir();
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
      throw new Error('Invalid MCP launcher authentication');
    }
    return auth;
  } finally {
    fs.closeSync(descriptor);
  }
}

export async function runCodexMcpStdioLauncher(): Promise<number> {
  const capabilityId = process.argv[3];
  const routeId = process.argv[4];
  if (!capabilityId || !routeId) {
    throw new Error('MCP launcher credentials are unavailable');
  }
  const routeAuth = readRouteAuth(routeId, capabilityId);
  const locator = readLocator(routeId);
  if (locator.parentPid !== routeAuth.parentPid) {
    throw new Error('MCP broker identity mismatch');
  }
  try {
    process.kill(locator.parentPid, 0);
  } catch {
    throw new Error('MCP broker parent is no longer running');
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
        reject(new Error('MCP launch route is unavailable'));
        return;
      }
      response.pipe(process.stdout);
      response.once('end', () => resolve(0));
      response.once('error', reject);
    });
    launchRequest.once('error', reject);
    process.once('SIGTERM', () => launchRequest.destroy());
    process.once('SIGINT', () => launchRequest.destroy());
    process.stdin.pipe(launchRequest);
  });
}
