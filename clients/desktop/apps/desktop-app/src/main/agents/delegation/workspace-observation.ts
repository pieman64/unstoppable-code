import os from 'node:os';
import type { AgentDelegationWorkspaceObservation } from '@canopy/protocol/delegation';
import { getGitExecutableCommand } from '@canopy/desktop-shared/lib/git-executable';
import { spawnClaudeCodeProcessOffMain } from '../claude-process-host-runner';

/** One bounded, read-only Git observation. File reads remain live afterwards. */
export async function observeDelegationWorkspace(
  cwd: string,
  signal: AbortSignal,
): Promise<AgentDelegationWorkspaceObservation> {
  const unknown = (): AgentDelegationWorkspaceObservation => ({
    consistency: 'live_shared_worktree',
    headRevision: null,
    dirty: null,
    observedAt: Date.now(),
  });
  if (signal.aborted) return unknown();
  try {
    const child = spawnClaudeCodeProcessOffMain({
      command: getGitExecutableCommand(process.env),
      args: [
        '--no-optional-locks',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.untrackedCache=false',
        'status',
        '--porcelain=v2',
        '--branch',
        '-z',
        '--untracked-files=normal',
      ],
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: os.homedir(),
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...(process.platform === 'win32'
          ? {
              SystemRoot:
                process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
            }
          : {}),
      },
      signal,
    });
    return await new Promise<AgentDelegationWorkspaceObservation>((resolve) => {
      let bytes = 0;
      let invalid = false;
      const chunks: Buffer[] = [];
      const stop = (): void => {
        invalid = true;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(stop, 3_000);
      signal.addEventListener('abort', stop, { once: true });
      child.stdin.on('error', () => undefined);
      child.on('error', () => {
        invalid = true;
      });
      child.stdout.on('data', (chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > 65_536) {
          stop();
          return;
        }
        if (!invalid) chunks.push(Buffer.from(chunk));
      });
      child.once('exit', (code): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        const observation = unknown();
        if (!invalid && !signal.aborted && code === 0) {
          const records = Buffer.concat(chunks).toString('utf8').split('\0');
          const oid = records
            .find((line) => line.startsWith('# branch.oid '))
            ?.slice(13);
          if (
            oid &&
            (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid) || oid === '(initial)')
          ) {
            resolve({
              ...observation,
              headRevision: oid === '(initial)' ? null : oid,
              dirty: records.some((line) => /^(?:1 |2 |u |\? )/.test(line)),
            });
            return;
          }
        }
        resolve(observation);
      });
      try {
        child.stdin.end();
      } catch {
        stop();
      }
    });
  } catch {
    return unknown();
  }
}
