import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPortalPage } from '../portal/viewportSession.mjs';

test('finalizes and attaches video when portal setup fails', async () => {
  const sentinel = new Error('navigation failed');
  let closeCount = 0;
  let finalized = false;
  const attachments = [];
  const page = {
    goto: async () => {
      throw sentinel;
    },
    on: () => undefined,
    video: () => ({
      path: async () => {
        assert.equal(finalized, true);
        return '/tmp/portal-video.webm';
      },
    }),
  };
  const context = {
    addCookies: async () => undefined,
    newPage: async () => page,
    close: async () => {
      closeCount += 1;
      finalized = true;
    },
  };
  const session = {
    browser: { newContext: async () => context },
    seeded: { cookie: { name: 'portal', value: 'session' } },
  };
  const testInfo = {
    project: { name: 'electron', use: {} },
    outputPath: (name) => `/tmp/${name}`,
    attach: async (name, options) => attachments.push({ name, ...options }),
  };

  await assert.rejects(
    () =>
      openPortalPage(session, testInfo, {
        video: 'on',
        waitForShell: false,
      }),
    (error) => error === sentinel,
  );

  assert.equal(closeCount, 1);
  assert.deepEqual(attachments, [
    {
      name: 'video',
      path: '/tmp/portal-video.webm',
      contentType: 'video/webm',
    },
  ]);
});

test('retain-on-failure records manual contexts and discards passing video', async () => {
  const attachments = [];
  let contextOptions = null;
  const page = {
    goto: async () => undefined,
    on: () => undefined,
    video: () => ({
      path: async () => '/tmp/missing-passing-portal-video.webm',
    }),
  };
  const context = {
    addCookies: async () => undefined,
    newPage: async () => page,
    close: async () => undefined,
  };
  const session = {
    browser: {
      newContext: async (options) => {
        contextOptions = options;
        return context;
      },
    },
    seeded: { cookie: { name: 'portal', value: 'session' } },
  };
  const testInfo = {
    status: 'passed',
    expectedStatus: 'passed',
    project: { name: 'portal', use: { video: 'retain-on-failure' } },
    outputPath: (name) => `/tmp/${name}`,
    attach: async (name, options) => attachments.push({ name, ...options }),
  };

  const view = await openPortalPage(session, testInfo, {
    waitForShell: false,
  });
  await view.close();

  assert.deepEqual(contextOptions.recordVideo, {
    dir: '/tmp/video',
    size: { width: 375, height: 812 },
  });
  assert.deepEqual(attachments, []);
});

test('retain-on-failure attaches finalized manual-context video on failure', async () => {
  const attachments = [];
  const page = {
    goto: async () => undefined,
    on: () => undefined,
    video: () => ({
      path: async () => '/tmp/missing-failed-portal-video.webm',
    }),
  };
  const context = {
    addCookies: async () => undefined,
    newPage: async () => page,
    close: async () => undefined,
  };
  const session = {
    browser: { newContext: async () => context },
    seeded: { cookie: { name: 'portal', value: 'session' } },
  };
  const testInfo = {
    status: 'failed',
    expectedStatus: 'passed',
    project: { name: 'portal', use: { video: 'retain-on-failure' } },
    outputPath: (name) => `/tmp/${name}`,
    attach: async (name, options) => attachments.push({ name, ...options }),
  };

  const view = await openPortalPage(session, testInfo, {
    waitForShell: false,
  });
  await view.close();

  assert.deepEqual(attachments, [
    {
      name: 'video',
      path: '/tmp/missing-failed-portal-video.webm',
      contentType: 'video/webm',
    },
  ]);
});

test('retain-on-failure honors an explicit failure while the test status is still passing', async () => {
  const attachments = [];
  const page = {
    goto: async () => undefined,
    on: () => undefined,
    video: () => ({
      path: async () => '/tmp/missing-in-body-failed-portal-video.webm',
    }),
  };
  const context = {
    addCookies: async () => undefined,
    newPage: async () => page,
    close: async () => undefined,
  };
  const session = {
    browser: { newContext: async () => context },
    seeded: { cookie: { name: 'portal', value: 'session' } },
  };
  const testInfo = {
    status: 'passed',
    expectedStatus: 'passed',
    project: { name: 'portal', use: { video: 'retain-on-failure' } },
    outputPath: (name) => `/tmp/${name}`,
    attach: async (name, options) => attachments.push({ name, ...options }),
  };

  const view = await openPortalPage(session, testInfo, {
    waitForShell: false,
  });
  await view.close(testInfo, { failed: true });

  assert.deepEqual(attachments, [
    {
      name: 'video',
      path: '/tmp/missing-in-body-failed-portal-video.webm',
      contentType: 'video/webm',
    },
  ]);
});

test('exposes a Fast Refresh quiet-window gate for a portal page', async () => {
  let consoleListener = null;
  const page = {
    goto: async () => undefined,
    on: (event, listener) => {
      assert.equal(event, 'console');
      consoleListener = listener;
    },
    video: () => null,
  };
  const context = {
    addCookies: async () => undefined,
    newPage: async () => page,
    close: async () => undefined,
  };
  const session = {
    browser: { newContext: async () => context },
    seeded: { cookie: { name: 'portal', value: 'session' } },
  };
  const testInfo = {
    project: { name: 'electron', use: {} },
    outputPath: (name) => `/tmp/${name}`,
    attach: async () => undefined,
  };

  const view = await openPortalPage(session, testInfo, {
    waitForShell: false,
  });
  consoleListener({ text: () => '[Fast Refresh] done in 100ms' });
  assert.equal(
    await view.waitForFastRefreshQuiet({ quietMs: 0, capMs: 1 }),
    undefined,
  );
  await view.close();
});

test('runs page setup before the first portal navigation', async () => {
  const calls = [];
  const page = {
    goto: async () => calls.push('navigate'),
    on: () => undefined,
    video: () => null,
  };
  const context = {
    addCookies: async () => undefined,
    newPage: async () => page,
    close: async () => undefined,
  };
  const session = {
    browser: { newContext: async () => context },
    seeded: { cookie: { name: 'portal', value: 'session' } },
  };
  const testInfo = {
    project: { name: 'electron', use: {} },
    outputPath: (name) => `/tmp/${name}`,
    attach: async () => undefined,
  };

  const view = await openPortalPage(session, testInfo, {
    waitForShell: false,
    beforeNavigate: async (openedPage) => {
      assert.equal(openedPage, page);
      calls.push('setup');
    },
  });

  assert.deepEqual(calls, ['setup', 'navigate']);
  await view.close();
});
