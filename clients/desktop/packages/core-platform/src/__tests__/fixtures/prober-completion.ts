import type { Readable } from 'node:stream';
import type { FixtureCleanup, FixtureRelease } from './pipe-test-cleanup';

export interface ProberExit {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export function ownProber(
  scope: FixtureCleanup,
  child: {
    stdout: Readable;
    stderr: Readable;
    kill(): boolean;
    once(event: 'close', listener: (code: number | null) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
  },
  timeoutMs: number,
  redact: (value: string) => string,
  blocks: readonly FixtureRelease[] = [],
): {
  done: Promise<ProberExit>;
  exited: () => boolean;
  release: FixtureRelease;
} {
  let stdout = '';
  let stderr = '';
  let exited = false;
  let operationError: Error | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = Promise.withResolvers<ProberExit>();
  const release = scope.own(() => {
    try {
      if (!exited && !child.kill())
        throw new Error('Prober termination failed');
    } catch (error) {
      operationError ??=
        error instanceof Error ? error : new Error(String(error));
      release.failed = true;
    }
    // A failed termination attempt still owns a live process until close.
    return done.promise;
  });
  const timer = setTimeout(() => {
    release.failed = true;
    void release.release().catch(() => undefined);
  }, timeoutMs);
  child.once('close', (code) => {
    clearTimeout(timer);
    exited = true;
    done.resolve({
      code: release.failed ? null : code,
      stdout: redact(stdout.trim()),
      stderr: redact(`${stderr}${operationError?.message ?? ''}`.trim()),
    });
  });
  // Spawn/kill failure does not confirm process exit or stdio closure.
  child.on('error', (error) => {
    operationError ??= error;
    release.failed = true;
  });
  try {
    for (const blocked of blocks) blocked.dependsOn(release);
  } catch (error) {
    release.failed = true;
    void release.release().catch(() => undefined);
    throw error;
  }
  return { done: done.promise, exited: () => exited, release };
}
