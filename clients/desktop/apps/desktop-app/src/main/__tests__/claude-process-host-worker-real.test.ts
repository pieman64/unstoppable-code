/**
 * The real process host worker driving real child processes (CAN-4833): a CLI
 * that ignores SIGTERM, and a subprocess of it that does too, must not survive
 * the host's kill.
 */
import { EventEmitter } from 'node:events';
import type { ParentPort } from 'electron';
import type { ClaudeProcessHostResponse } from '../agents/claude-process-host-protocol';
import { startClaudeProcessHost } from '../agents/claude-process-host-worker';

class RecordingParentPort extends EventEmitter implements ParentPort {
  readonly responses: ClaudeProcessHostResponse[] = [];
  readonly postMessage = (response: ClaudeProcessHostResponse): void => {
    this.responses.push(response);
    this.emit('response', response);
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function nextResponse(
  parent: RecordingParentPort,
  matches: (response: ClaudeProcessHostResponse) => boolean,
  timeoutMs: number,
): Promise<ClaudeProcessHostResponse> {
  const seen = parent.responses.find(matches);
  if (seen) return Promise.resolve(seen);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      parent.off('response', listener);
      reject(new Error('Timed out waiting for a host response'));
    }, timeoutMs);
    const listener = (response: ClaudeProcessHostResponse): void => {
      if (!matches(response)) return;
      clearTimeout(timer);
      parent.off('response', listener);
      resolve(response);
    };
    parent.on('response', listener);
  });
}

// The CLI stand-in ignores SIGTERM, starts a subprocess that ignores it too,
// then reports both pids.
const IGNORES_SIGTERM = `
process.on('SIGTERM', () => {});
const { spawn } = require('node:child_process');
const sub = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
setTimeout(() => process.stdout.write(JSON.stringify({ pid: process.pid, sub: sub.pid }) + '\\n'), 200);
setInterval(() => {}, 1000);
`;

const posixIt = process.platform === 'win32' ? it.skip : it;

describe('Claude process host worker with real processes', () => {
  const survivors: number[] = [];

  afterEach(() => {
    for (const pid of survivors.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  posixIt(
    'SIGKILLs the process group of a CLI that ignores SIGTERM',
    async () => {
      const parent = new RecordingParentPort();
      startClaudeProcessHost(parent, () => undefined);
      parent.emit('message', {
        data: {
          type: 'spawn',
          requestId: 'stubborn',
          command: process.execPath,
          args: ['-e', IGNORES_SIGTERM],
          cwd: process.cwd(),
          env: { ...process.env },
          captureStderr: false,
        },
      });

      const ready = await nextResponse(
        parent,
        (response) =>
          response.type === 'stdout' && response.requestId === 'stubborn',
        5_000,
      );
      if (ready.type !== 'stdout') throw new Error('Expected stdout');
      const pids: unknown = JSON.parse(
        Buffer.from(ready.dataBase64, 'base64').toString('utf8'),
      );
      if (
        typeof pids !== 'object' ||
        pids === null ||
        typeof Reflect.get(pids, 'pid') !== 'number' ||
        typeof Reflect.get(pids, 'sub') !== 'number'
      )
        throw new Error('Expected the stand-in to report its pids');
      const cli = Number(Reflect.get(pids, 'pid'));
      const subprocess = Number(Reflect.get(pids, 'sub'));
      survivors.push(cli, subprocess);

      parent.emit('message', {
        data: { type: 'kill', requestId: 'stubborn', signal: 'SIGTERM' },
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(isAlive(cli)).toBe(true);

      const exit = await nextResponse(
        parent,
        (response) =>
          response.type === 'exit' && response.requestId === 'stubborn',
        8_000,
      );
      expect(exit).toMatchObject({ type: 'exit', signal: 'SIGKILL' });
      expect(isAlive(cli)).toBe(false);
      // Signals are delivered asynchronously; give the subprocess a moment.
      for (let tick = 0; tick < 20 && isAlive(subprocess); tick += 1)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(isAlive(subprocess)).toBe(false);
    },
    20_000,
  );
});
