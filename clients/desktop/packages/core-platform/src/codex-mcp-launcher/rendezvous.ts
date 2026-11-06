import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type CodexMcpLauncherErrorMessage =
  | 'MCP launcher credentials are unavailable'
  | 'Invalid MCP broker runtime file'
  | 'MCP broker runtime file permissions are too broad'
  | 'MCP broker runtime file has an unexpected owner'
  | 'Invalid MCP broker route'
  | 'Invalid MCP broker locator'
  | 'Invalid MCP launcher route'
  | 'Invalid MCP launcher authentication'
  | 'MCP broker identity mismatch'
  | 'MCP broker parent is no longer running'
  | 'MCP launch route is unavailable'
  | 'Invalid MCP broker runtime directory'
  | 'MCP broker runtime directory permissions are too broad'
  | 'MCP broker runtime directory has an unexpected owner';

/** A launcher or rendezvous refusal; the message is always fixed text. */
export class CodexMcpLauncherError extends Error {
  constructor(message: CodexMcpLauncherErrorMessage) {
    super(message);
    this.name = 'CodexMcpLauncherError';
  }
}

export const CODEX_MCP_STDIO_LAUNCHER_COMMAND = '__codex-mcp-stdio-launcher';

const CODEX_MCP_ROUTE_ID_PATTERN = /^[a-f0-9]{32}\.[a-f0-9]{48}$/;

export function isCodexMcpRouteId(value: string): boolean {
  return CODEX_MCP_ROUTE_ID_PATTERN.test(value);
}

export function codexMcpRouteAuthFileName(routeId: string): string {
  if (!isCodexMcpRouteId(routeId)) {
    throw new CodexMcpLauncherError('Invalid MCP broker route');
  }
  return `${routeId}.auth.json`;
}

/**
 * Locate the parent-owned MCP broker without relying on environment variables
 * inherited by the Codex app-server's MCP launcher children. Codex deliberately
 * sanitizes that child environment, including Canopy's data-directory
 * override, so the rendezvous must be derivable independently in both
 * processes.
 */
export function getCodexMcpBrokerRuntimeDir(): string {
  const user = os.userInfo();
  const userNamespace = createHash('sha256')
    .update(`${user.uid}:${user.username}:${path.resolve(user.homedir)}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(os.tmpdir(), `canopy-codex-mcp-brokers-${userNamespace}`);
}

export function ensureCodexMcpBrokerRuntimeDir(runtimeDir: string): void {
  if (fs.existsSync(runtimeDir)) {
    const existing = fs.lstatSync(runtimeDir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new CodexMcpLauncherError('Invalid MCP broker runtime directory');
    }
  } else {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  }

  const stat = fs.lstatSync(runtimeDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new CodexMcpLauncherError('Invalid MCP broker runtime directory');
  }
  if (process.platform === 'win32') {
    return;
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new CodexMcpLauncherError(
      'MCP broker runtime directory permissions are too broad',
    );
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new CodexMcpLauncherError(
      'MCP broker runtime directory has an unexpected owner',
    );
  }
}
