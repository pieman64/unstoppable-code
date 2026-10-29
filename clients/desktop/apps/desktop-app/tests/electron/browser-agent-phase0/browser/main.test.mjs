import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

test('an unhandled rejection writes an unqualified crashed report and exits', async () => {
  const handlers = new Map();
  const reports = [];
  const exits = [];
  const switches = [];
  // Execute the entry point with host dependencies supplied by the fixture.
  // Keep readiness pending so no Electron windows or network listeners open.
  const source = readFileSync(
    new URL('./app/main.mjs', import.meta.url),
    'utf8',
  ).replace(/^import .* from .*;\n/gm, '');
  runInNewContext(source, {
    path,
    process: {
      env: {
        S03_PROBE_CONFIG: JSON.stringify({
          reportPath: '/probe/report.json',
          workDir: '/probe',
          deadlineMs: 1000,
          expectedElectron: 'test',
        }),
      },
      platform: 'linux',
      arch: 'test',
      versions: { electron: 'test' },
      on: (event, handler) => handlers.set(event, handler),
    },
    app: {
      setName() {},
      setPath() {},
      on() {},
      commandLine: { appendSwitch: (...args) => switches.push(args) },
      whenReady: () => new Promise(() => {}),
      exit: (code) => exits.push(code),
    },
    VECTORS: [],
    aggregate: () => ({ qualified: true, reasons: [] }),
    withTimeout: (promise) => promise,
    setTimeout: () => 1,
    writeFileSync: (file, contents) => reports.push(JSON.parse(contents)),
  });
  assert.deepEqual(
    switches.filter(([name]) => name === 'password-store'),
    [['password-store', 'gnome-libsecret']],
  );
  assert.equal(
    switches.some(([name]) => name === 'use-mock-keychain'),
    false,
  );
  handlers.get('unhandledRejection')(new Error('infrastructure failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.length, 1, 'fatal rejection publishes a report');
  assert.equal(reports[0].outcome, 'crashed');
  assert.equal(reports[0].summary.qualified, false);
  assert.ok(reports[0].summary.reasons.includes('probe outcome crashed'));
  assert.match(reports[0].errors[0], /unhandled:.*infrastructure failed/s);
  assert.deepEqual(exits, [3]);
});
