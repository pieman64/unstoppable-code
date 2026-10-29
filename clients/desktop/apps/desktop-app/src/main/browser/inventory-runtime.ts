import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import {
  BrowserInventoryQueue,
  type BrowserInventoryWorker,
} from '@canopy/desktop-shared/node/browser-profiles/inventory-queue';
import {
  getResourceMonitorService,
  type ResourceRegistrationHandle,
} from '../resource-monitor';

/** One app-lifetime queue; labels and resource metadata contain no visited sites. */
export const browserInventoryQueue = new BrowserInventoryQueue(() => {
  const child = utilityProcess.fork(
    join(__dirname, 'browser-profile-inventory-worker.js'),
    [],
    {
      serviceName: 'browser-profile-inventory',
      stdio: 'ignore',
    },
  );
  let registration: ResourceRegistrationHandle | undefined;
  child.once('spawn', () => {
    try {
      if (!Number.isInteger(child.pid) || Number(child.pid) < 1)
        throw new Error('Missing inventory worker PID.');
      registration = getResourceMonitorService().registerProcess({
        id: `browser-inventory:${randomUUID()}`,
        groupId: 'browser',
        kind: 'electron-utility',
        label: 'Browser profile inventory',
        pid: child.pid,
        startedAt: new Date().toISOString(),
        metadata: { type: 'generic' },
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* Queue keeps ownership until exit. */
      }
    }
  });
  child.once('exit', () => {
    try {
      registration?.unregister();
    } catch {
      /* Do not strand the queue's actual-exit notification. */
    }
  });
  function once(event: 'exit', listener: (value: number) => void): unknown;
  function once(event: 'error', listener: (value: Error) => void): unknown;
  function once(
    event: 'exit' | 'error',
    listener: ((value: number) => void) | ((value: Error) => void),
  ): unknown {
    if (event === 'exit') {
      child.once('exit', (code) => {
        Reflect.apply(listener, undefined, [code]);
      });
    } else {
      child.once('error', () => {
        Reflect.apply(listener, undefined, [
          new Error('Browser inventory worker failed.'),
        ]);
      });
    }
    return undefined;
  }
  const worker: BrowserInventoryWorker = {
    postMessage: (value): void => child.postMessage(value),
    kill: (): void => {
      child.kill();
    },
    on: (_event, listener): unknown => child.on('message', listener),
    once,
  };
  return worker;
});
