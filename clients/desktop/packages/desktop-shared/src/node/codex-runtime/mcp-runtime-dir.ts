import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
      throw new Error('Invalid MCP broker runtime directory');
    }
  } else {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  }

  const stat = fs.lstatSync(runtimeDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Invalid MCP broker runtime directory');
  }
  if (process.platform === 'win32') {
    return;
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('MCP broker runtime directory permissions are too broad');
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('MCP broker runtime directory has an unexpected owner');
  }
}
