import { execFile } from 'node:child_process';

/** One login-shell lookup: stdout of a clean exit, otherwise undefined. */
export type LoginShellProbe = (request: {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly maxBuffer: number;
}) => Promise<string | undefined>;

export const execFileLoginShellProbe: LoginShellProbe = (request) =>
  new Promise((resolve) => {
    const child = execFile(
      request.file,
      [...request.args],
      {
        encoding: 'utf8',
        env: request.env,
        timeout: request.timeoutMs,
        maxBuffer: request.maxBuffer,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
    // The login shell can take seconds with heavy shell init; never let the
    // pending refresh keep a short-lived CLI process alive.
    child.unref?.();
  });
