import { resolve } from 'node:path';
import type { PlatformProcessInspection } from '@canopy/core-runtime';
import { createProcessInspector } from '../../supervision/inspect';
import { windowsProcessObserver } from '../../supervision/windows-process';
import { NODE_SUPERVISION } from '../../supervision/shared';

// The IPC channel is the independent lifeline; no inspector result creates it.
process.on('disconnect', () => process.exit(0));
const watchdog = setTimeout(() => process.exit(2), 180_000);
process.on('message', async (message: unknown): Promise<void> => {
  if (message === 'exit') {
    clearTimeout(watchdog);
    process.disconnect();
    return;
  }
  if (
    typeof message !== 'object' ||
    message === null ||
    !('kind' in message) ||
    message.kind !== 'observe' ||
    !('pids' in message) ||
    !Array.isArray(message.pids)
  )
    return;
  try {
    const os =
      process.platform === 'win32'
        ? 'win32'
        : process.platform === 'darwin'
          ? 'darwin'
          : 'linux';
    const inspect = createProcessInspector(os, {
      ...NODE_SUPERVISION,
      windowsProcess: windowsProcessObserver(
        resolve(
          import.meta.dirname,
          '../../../../..',
          '.cache/bin/win32-x64/canopy-process-identity.exe',
        ),
      ),
    });
    const results: PlatformProcessInspection[] = [];
    const pids: unknown[] = message.pids;
    if (pids.length > 2)
      throw new Error('Observer accepts at most two targets');
    for (const pid of pids) {
      if (typeof pid !== 'number') throw new Error('Invalid observer PID');
      results.push(await inspect({ pid }));
    }
    process.send?.({ kind: 'observed', results });
  } catch {
    process.send?.({ kind: 'failed' });
  }
});
process.send?.({ kind: 'ready', pid: process.pid });
