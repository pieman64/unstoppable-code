import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import {
  startPortalWebServer,
  getPortListenerPids,
} from '../portal/web-server.mjs';
import { PORTAL_WEB_PORT } from '../portal/config.mjs';

test(
  'real Linux Portal Next server stops idempotently and releases its port',
  {
    skip:
      process.platform !== 'linux' ||
      process.env.CANOPY_LINUX_UI_HARNESS_ACCEPTANCE !== '1',
    timeout: 180_000,
  },
  async () => {
    const server = await startPortalWebServer({ warmRoutes: false });
    const record = { pid: server.pid, origin: server.origin };
    try {
      const response = await fetch(`${server.origin}/.well-known/canopy`);
      assert.equal(response.ok, true);
      await server.stop();
      await server.stop();
      assert.equal(server.isAlive(), false);
      assert.deepEqual(getPortListenerPids(PORTAL_WEB_PORT), []);
      const listener = createServer();
      await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(PORTAL_WEB_PORT, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => listener.close(resolve));
      record.stopped = true;
      record.portRebound = true;
    } finally {
      await server.stop();
      const dir = path.join(
        process.env.CANOPY_E2E_ARTIFACT_ROOT ?? '.playwright/can-3180-native',
        'portal',
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'teardown.json'),
        JSON.stringify(record, null, 2),
      );
    }
  },
);
