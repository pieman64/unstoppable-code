import * as path from 'node:path';
import type { LoginShellProbe } from '../../pipelines/config-paths';
import type { ExecutionHostPort } from './port';

/**
 * Login-shell PATH lookups as port probes: each runs in an owned tree that a
 * timeout stops whole. A shell that is not fully qualified is not probed,
 * since probes never search PATH.
 */
export function createPortLoginShellProbe(
  port: ExecutionHostPort,
): LoginShellProbe {
  return async (request) => {
    if (!path.isAbsolute(request.file)) return undefined;
    const result = await port.probe({
      executable: request.file,
      args: request.args,
      environment: request.env,
      timeoutMs: request.timeoutMs,
      maxOutputBytes: request.maxBuffer,
    });
    return result.ok ? result.stdout : undefined;
  };
}
