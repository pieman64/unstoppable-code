import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isPortalPairingSuccessful,
  startBrowserPortalSession,
  submitPortalPairingCode,
} from '../portal/portalHarness.mjs';
import {
  buildWebServerEnv,
  defaultPortalWarmRequests,
  drainPortListeners,
  getPortalNextCommand,
  getPortalServerLaunch,
  getPortListenerPids,
  removePortalNextDistDir,
  retryPortalServerStartup,
  warmPortalRoute,
  warmPortalRoutes,
  wrapPortalStartupFailure,
} from '../portal/web-server.mjs';
import { createPortalServerManager } from '../portal/fixtures.mjs';

test('pins cloud agents off unless a Portal spec explicitly opts in', () => {
  const disabled = buildWebServerEnv();
  assert.equal(disabled.CANOPY_PORTAL_E2E, '1');
  assert.equal(disabled.CANOPY_PORTAL_E2E_CLOUD_AGENTS, undefined);

  const enabled = buildWebServerEnv({ cloudAgentsEnabled: true });
  assert.equal(enabled.CANOPY_PORTAL_E2E, '1');
  assert.equal(enabled.CANOPY_PORTAL_E2E_CLOUD_AGENTS, '1');
});

test('pins destructive actions off unless a Portal spec explicitly opts in', () => {
  const disabled = buildWebServerEnv();
  assert.equal(disabled.CANOPY_PORTAL_E2E, '1');
  assert.equal(disabled.CANOPY_PORTAL_E2E_DESTRUCTIVE_ACTIONS, undefined);

  const enabled = buildWebServerEnv({ destructiveActionsEnabled: true });
  assert.equal(enabled.CANOPY_PORTAL_E2E, '1');
  assert.equal(enabled.CANOPY_PORTAL_E2E_DESTRUCTIVE_ACTIONS, '1');
});

test('pins cloud stack config only when supplied', () => {
  const cloudStack = {
    coreBaseUrl: 'http://127.0.0.1:5401',
    authToken: 'local-e2e-token',
    cloudAgentId: 'cloud-assistant-id',
  };
  const env = buildWebServerEnv({
    cloudStack,
    env: { AGENTIC_CORE_BASE_URL: 'wrong' },
  });

  assert.equal(env.AGENTIC_CORE_BASE_URL, cloudStack.coreBaseUrl);
  assert.equal(env.AGENTIC_CORE_AUTH_TOKEN, cloudStack.authToken);
  assert.equal(env.AGENTIC_CORE_CLOUD_AGENT_ID, cloudStack.cloudAgentId);
  assert.equal(env.CANOPY_PORTAL_E2E, '1');
  assert.equal(env.CANOPY_PORTAL_E2E_CLOUD_AGENTS, '1');
  assert.equal(
    buildWebServerEnv({ env: { AGENTIC_CORE_BASE_URL: 'unchanged' } })
      .AGENTIC_CORE_BASE_URL,
    'unchanged',
  );
});

function browserSessionFakes({ gotoError = null } = {}) {
  const calls = [];
  const page = {
    goto: async (url) => {
      calls.push(`goto:${url}`);
      if (gotoError) throw gotoError;
    },
    close: async () => calls.push('page.close'),
  };
  const context = {
    addCookies: async (cookies) => calls.push({ cookies }),
    newPage: async () => page,
    close: async () => calls.push('context.close'),
  };
  const browser = {
    newContext: async (options) => {
      calls.push({ contextOptions: options });
      return context;
    },
    close: async () => calls.push('browser.close'),
  };
  return {
    calls,
    page,
    context,
    browser,
    dependencies: {
      launchBrowser: async () => browser,
      seedUser: async () => ({
        apiKey: 'browser-only-key',
        cookie: { name: 'portal-cookie', value: 'session' },
      }),
      seedTheme: async () => calls.push('theme'),
      colorSchemeOptions: () => ({ colorScheme: 'dark' }),
    },
  };
}

test('browser-only portal session installs routes before /chat and tears down once', async () => {
  const fake = browserSessionFakes();
  const session = await startBrowserPortalSession(
    {
      webServer: { mode: 'development', brandId: 'canopy' },
      beforeNavigate: async (page) => {
        assert.equal(page, fake.page);
        fake.calls.push('routes');
      },
    },
    fake.dependencies,
  );

  assert.equal(session.page, fake.page);
  assert.equal(session.electronApp, undefined);
  assert.deepEqual(session.desktopTransportRequests, []);
  assert.ok(
    fake.calls.indexOf('routes') < fake.calls.indexOf('goto:/chat'),
    'route setup must precede the first navigation',
  );
  const cookieCall = fake.calls.find((call) => call?.cookies);
  assert.deepEqual(cookieCall.cookies, [
    {
      name: 'portal-cookie',
      value: 'session',
      url: 'http://localhost:4061',
      secure: false,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);

  await session.teardown();
  await session.teardown();
  assert.equal(fake.calls.filter((call) => call === 'page.close').length, 1);
  assert.equal(fake.calls.filter((call) => call === 'context.close').length, 1);
  assert.equal(fake.calls.filter((call) => call === 'browser.close').length, 1);
});

test('browser-only portal session uses the production secure cookie shape', async () => {
  const fake = browserSessionFakes();
  await startBrowserPortalSession(
    { webServer: { mode: 'production', brandId: 'canopy' } },
    fake.dependencies,
  );
  const cookieCall = fake.calls.find((call) => call?.cookies);
  assert.deepEqual(cookieCall.cookies[0], {
    name: '__Secure-portal-cookie',
    value: 'session',
    domain: 'localhost',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
  });
});

test('browser-only portal session cleans partial setup and rejects desktop options', async () => {
  await assert.rejects(
    () => startBrowserPortalSession({ seedBeforeLaunch() {} }),
    /does not accept desktop-only option "seedBeforeLaunch"/,
  );

  const sentinel = new Error('chat navigation failed');
  const fake = browserSessionFakes({ gotoError: sentinel });
  await assert.rejects(
    () => startBrowserPortalSession({}, fake.dependencies),
    (error) => error === sentinel,
  );
  assert.deepEqual(fake.calls.slice(-3), [
    'page.close',
    'context.close',
    'browser.close',
  ]);
});

function fakePortalServerFactory({ failStarts = 0 } = {}) {
  const starts = [];
  const stops = [];
  let remainingFailures = failStarts;
  return {
    starts,
    stops,
    async start(options) {
      starts.push(options);
      if (remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error('injected portal start failure');
      }
      let alive = true;
      const id = starts.length;
      return {
        id,
        origin: `http://portal-${String(id)}`,
        isAlive: () => alive,
        killForTest: () => {
          alive = false;
        },
        async stop() {
          if (!alive) return;
          alive = false;
          stops.push(id);
        },
      };
    },
  };
}

test('portal server manager shares equivalent leases and owns final shutdown', async () => {
  const factory = fakePortalServerFactory();
  const manager = createPortalServerManager({ start: factory.start });
  const [first, second] = await Promise.all([
    manager.acquire({ destructiveActionsEnabled: true }),
    manager.acquire({ destructiveActionsEnabled: true }),
  ]);

  assert.equal(factory.starts.length, 1);
  assert.equal(first.id, second.id);
  await first.release();
  await first.release();
  assert.deepEqual(factory.stops, []);
  await second.release();
  assert.deepEqual(factory.stops, []);
  await manager.dispose();
  assert.deepEqual(factory.stops, [1]);
});

test('portal server manager propagates final shutdown failures', async () => {
  const stopFailure = new Error('injected portal stop failure');
  const manager = createPortalServerManager({
    start: async () => ({
      async stop() {
        throw stopFailure;
      },
    }),
  });

  const lease = await manager.acquire();
  await lease.release();
  await assert.rejects(
    () => manager.dispose(),
    (error) => error === stopFailure,
  );
  await manager.dispose();
});

test('portal server manager rejects active mismatches and restarts flag, brand, and mode changes', async () => {
  const factory = fakePortalServerFactory();
  const manager = createPortalServerManager({ start: factory.start });
  const disabled = await manager.acquire();
  await assert.rejects(
    () => manager.acquire({ destructiveActionsEnabled: true }),
    /incompatible Portal server configuration while a lease is active/,
  );
  await disabled.release();

  const enabled = await manager.acquire({ destructiveActionsEnabled: true });
  assert.equal(enabled.id, 2);
  await enabled.release();
  const branded = await manager.acquire({
    env: { CANOPY_WEB_DEFAULT_BRAND: 'unstoppable-code' },
  });
  assert.equal(branded.id, 3);
  await branded.release();
  const production = await manager.acquire({ mode: 'production' });
  assert.equal(production.id, 4);
  await production.release();
  const disabledAgain = await manager.acquire();
  assert.equal(disabledAgain.id, 5);
  assert.deepEqual(factory.stops, [1, 2, 3, 4]);
  await disabledAgain.release();
  await manager.dispose();
});

test('portal server manager restarts after the destructive-actions option changes while idle', async () => {
  const factory = fakePortalServerFactory();
  const manager = createPortalServerManager({ start: factory.start });
  const disabled = await manager.acquire();
  await disabled.release();

  const enabled = await manager.acquire({ destructiveActionsEnabled: true });
  assert.equal(enabled.id, 2);
  assert.equal(factory.starts[0].destructiveActionsEnabled, undefined);
  assert.equal(factory.starts[1].destructiveActionsEnabled, true);
  assert.deepEqual(factory.stops, [1]);
  await enabled.release();
  await manager.dispose();
});

test('portal server manager evicts failed starts and unexpectedly dead children', async () => {
  const factory = fakePortalServerFactory({ failStarts: 1 });
  const manager = createPortalServerManager({ start: factory.start });
  await assert.rejects(
    () => manager.acquire(),
    /injected portal start failure/,
  );
  const recovered = await manager.acquire();
  assert.equal(factory.starts.length, 2);
  recovered.killForTest();
  await recovered.release();
  const restarted = await manager.acquire();
  assert.equal(factory.starts.length, 3);
  assert.notEqual(restarted.id, recovered.id);
  await restarted.release();
  await manager.dispose();
});

test('portal server manager stops a lease-bound server before its dependent stub closes', async () => {
  const factory = fakePortalServerFactory();
  const lifecycle = [];
  const manager = createPortalServerManager({
    start: async (options) => {
      const server = await factory.start(options);
      return {
        ...server,
        async stop() {
          lifecycle.push('portal-stop');
          await server.stop();
        },
      };
    },
  });
  const lease = await manager.acquire({ reuseAfterRelease: false });

  await lease.release();
  lifecycle.push('stub-stop');

  assert.deepEqual(lifecycle, ['portal-stop', 'stub-stop']);
  const replacement = await manager.acquire({ reuseAfterRelease: false });
  assert.notEqual(replacement.id, lease.id);
  await replacement.release();
  await manager.dispose();
});

test('scrubs inherited Portal feature opt-ins before applying explicit test env', () => {
  const optInKeys = [
    'CANOPY_PORTAL_E2E_BROWSER_GUESTS',
    'CANOPY_PORTAL_E2E_CLOUD_AGENTS',
    'CANOPY_PORTAL_E2E_DIGESTS',
    'CANOPY_PORTAL_E2E_DESTRUCTIVE_ACTIONS',
  ];
  const originals = Object.fromEntries(
    optInKeys.map((key) => [key, process.env[key]]),
  );

  try {
    for (const key of optInKeys) process.env[key] = '1';

    const scrubbed = buildWebServerEnv();
    for (const key of optInKeys) assert.equal(scrubbed[key], undefined);

    const explicit = buildWebServerEnv({
      env: { CANOPY_PORTAL_E2E_DIGESTS: '1' },
    });
    assert.equal(explicit.CANOPY_PORTAL_E2E_DIGESTS, '1');
  } finally {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

for (const platform of ['darwin', 'linux']) {
  test('port cleanup selects listening processes only', () => {
    const calls = [];
    const pids = getPortListenerPids(4061, {
      platform,
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: '123\n456\n' };
      },
    });

    assert.deepEqual(pids, ['123', '456']);
    assert.deepEqual(calls, [
      {
        command: 'lsof',
        args: ['-tiTCP:4061', '-sTCP:LISTEN'],
        options: { encoding: 'utf8', timeout: 5_000 },
      },
    ]);
  });

  test('port cleanup waits for a late child listener and a stable clear window', async () => {
    const snapshots = [['123'], [], ['456'], [], [], []];
    const killed = [];
    const delays = [];

    assert.equal(
      await drainPortListeners(4061, {
        platform,
        getPids: () => snapshots.shift() ?? [],
        killPid: (pid) => killed.push(pid),
        wait: async (delayMs) => delays.push(delayMs),
        intervalMs: 25,
        stablePasses: 3,
        maxAttempts: 10,
      }),
      true,
    );
    assert.deepEqual(killed, ['123', '456']);
    assert.deepEqual(delays, [25, 25, 25, 25, 25]);
  });
}
test('selects dev and production Next commands without deleting production output', () => {
  assert.deepEqual(getPortalNextCommand({ mode: 'development', port: 4061 }), {
    args: ['next', 'dev', '--turbopack', '--port', '4061'],
    removeDevDist: true,
  });
  assert.deepEqual(getPortalNextCommand({ mode: 'production', port: 4061 }), {
    args: ['next', 'start', '--port', '4061'],
    removeDevDist: false,
  });
});

test('launches Portal Next through the worker-owned process-tree supervisor', () => {
  const launch = getPortalServerLaunch({
    serverWebAppDir: '/tmp/canopy/apps/web',
    command: getPortalNextCommand({ mode: 'development', port: 4061 }),
    env: { PORT: '4061' },
    ownerPid: 2468,
  });

  assert.equal(launch.executable, process.execPath);
  assert.match(launch.args[0], /process-tree-supervisor\.mjs$/);
  assert.match(launch.args[1], /node_modules\/next\/dist\/bin\/next$/);
  assert.deepEqual(launch.args.slice(2), [
    'dev',
    '--turbopack',
    '--port',
    '4061',
  ]);
  assert.equal(launch.options.env.CANOPY_E2E_OWNER_PID, '2468');
  assert.equal(
    launch.options.env.CANOPY_E2E_SUPERVISED_EXECUTABLE,
    process.execPath,
  );
  assert.equal(launch.options.detached, false);
});

test('retries a transient Next HTML 404 until a portal route is compiled', async () => {
  const responses = [
    new Response('<!doctype html><title>Not Found</title>', {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }),
    new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  ];
  const delays = [];
  const fetchImpl = async () => responses.shift();

  const response = await warmPortalRoute('http://localhost/test', undefined, {
    fetchImpl,
    retryDelayMs: 25,
    sleep: async (delay) => delays.push(delay),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(delays, [25]);
  assert.equal(responses.length, 0);
});

test('retries a transient fetch failure until a portal route responds', async () => {
  const responses = [
    new TypeError('fetch failed: ECONNRESET'),
    new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    }),
  ];
  const delays = [];
  const fetchImpl = async () => {
    const result = responses.shift();
    if (result instanceof Error) throw result;
    return result;
  };

  const response = await warmPortalRoute('http://localhost/test', undefined, {
    fetchImpl,
    retryDelayMs: 25,
    sleep: async (delay) => delays.push(delay),
  });

  assert.equal(response.status, 401);
  assert.deepEqual(delays, [25]);
  assert.equal(responses.length, 0);
});

test('reports the last fetch failure after exhausting route warm-up retries', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    throw new TypeError(`connection refused ${String(attempts)}`);
  };

  await assert.rejects(
    () =>
      warmPortalRoute('http://localhost/test', undefined, {
        fetchImpl,
        maxAttempts: 2,
        retryDelayMs: 0,
        sleep: async () => undefined,
      }),
    /Portal route fetch failed after 2 warm-up attempts: http:\/\/localhost\/test \(last: connection refused 2\)/,
  );
  assert.equal(attempts, 2);
});

test('warms cold Turbopack routes sequentially', async () => {
  const calls = [];
  let releaseFirst;
  const firstFinished = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const warmRoute = async (url) => {
    calls.push(url);
    if (url.endsWith('/first')) {
      await firstFinished;
    }
  };

  const pending = warmPortalRoutes(
    [
      { path: '/first', method: 'GET' },
      { path: '/second', method: 'GET' },
    ],
    { origin: 'http://localhost', warmRoute },
  );
  await Promise.resolve();

  assert.deepEqual(calls, ['http://localhost/first']);
  releaseFirst();
  await pending;
  assert.deepEqual(calls, [
    'http://localhost/first',
    'http://localhost/second',
  ]);
});

test('prewarms request routes whose cold compile can exceed client deadlines', () => {
  const requests = defaultPortalWarmRequests();
  assert.ok(
    requests.some(
      (request) =>
        request.path === '/api/v1/desktop-app/runs' &&
        request.method === 'POST',
    ),
  );
  assert.ok(
    requests.some(
      (request) =>
        request.path ===
          '/api/v1/desktop-app/portal/browser/sessions/warmup/file/read' &&
        request.method === 'POST',
    ),
  );
});

test('removes the Turbopack directory with bounded transient-error retries', () => {
  const calls = [];
  removePortalNextDistDir('/tmp/portal-web-app', {
    remove: (target, options) => calls.push({ target, options }),
    distDir: '.next-test',
  });

  assert.deepEqual(calls, [
    {
      target: '/tmp/portal-web-app/.next-test',
      options: {
        recursive: true,
        force: true,
        maxRetries: 50,
        retryDelay: 100,
      },
    },
  ]);
});

test('restarts once when Turbopack permanently loses a dynamic route', async () => {
  const attempts = [];
  const server = { origin: 'http://localhost' };

  assert.equal(
    await retryPortalServerStartup(async () => {
      attempts.push(attempts.length + 1);
      if (attempts.length === 1) {
        throw new Error(
          'Portal route remained an HTML 404 after 360 warm-up attempts: http://localhost/api/test',
        );
      }
      return server;
    }),
    server,
  );
  assert.deepEqual(attempts, [1, 2]);
});

test('preserves the portal startup diagnostic when failure cleanup also fails', async () => {
  const startupError = new Error(
    'Portal route remained an HTML 404 after 360 warm-up attempts',
  );
  const cleanupError = new Error('portal port did not clear');

  await assert.rejects(
    () =>
      wrapPortalStartupFailure(
        startupError,
        ['next diagnostic\n'],
        async () => {
          throw cleanupError;
        },
      ).then((error) => Promise.reject(error)),
    (error) =>
      error !== cleanupError &&
      error.cause === startupError &&
      error.message.includes(startupError.message) &&
      error.message.includes('next diagnostic') &&
      error.errors?.includes(cleanupError),
  );
});

test('does not restart for a non-route startup failure', async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      retryPortalServerStartup(async () => {
        attempts += 1;
        throw new Error('database authentication failed');
      }),
    /database authentication failed/,
  );
  assert.equal(attempts, 1);
});

test('retries a transient connect-route 404 during portal pairing', async () => {
  const results = [
    { status: 404, body: null },
    { status: 200, body: { status: 'active' } },
  ];
  const delays = [];
  const page = {
    evaluate: async () => results.shift(),
    waitForTimeout: async (delay) => {
      delays.push(delay);
    },
  };

  assert.deepEqual(
    await submitPortalPairingCode(page, {
      namespace: 'desktop-app',
      code: '123456',
      retryDelayMs: 25,
    }),
    { status: 200, body: { status: 'active' } },
  );
  assert.deepEqual(delays, [25]);
  assert.equal(results.length, 0);
});

test('retries a transient browser fetch failure during portal pairing', async () => {
  const results = [
    new TypeError('Failed to fetch'),
    { status: 200, body: { status: 'active' } },
  ];
  const delays = [];
  let activationChecks = 0;
  const page = {
    evaluate: async () => {
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    waitForTimeout: async (delay) => {
      delays.push(delay);
    },
  };

  assert.deepEqual(
    await submitPortalPairingCode(page, {
      namespace: 'desktop-app',
      code: '123456',
      retryDelayMs: 25,
      ambiguousActivationWaitMs: 25,
      isDesktopActivated: async () => {
        activationChecks += 1;
        return false;
      },
    }),
    { status: 200, body: { status: 'active' } },
  );
  assert.deepEqual(delays, [25]);
  assert.equal(activationChecks, 2);
  assert.equal(results.length, 0);
});

test('does not replay an ambiguous fetch failure after desktop activation', async () => {
  let attempts = 0;
  const delays = [];
  const page = {
    evaluate: async () => {
      attempts += 1;
      throw new TypeError('Failed to fetch');
    },
    waitForTimeout: async (delay) => {
      delays.push(delay);
    },
  };

  assert.equal(
    (
      await submitPortalPairingCode(page, {
        namespace: 'desktop-app',
        code: '123456',
        retryDelayMs: 25,
        isDesktopActivated: async () => true,
      })
    ).desktopActivated,
    true,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test('does not replay an ambiguous fetch failure while desktop activation is delayed', async () => {
  let attempts = 0;
  let activationChecks = 0;
  const delays = [];
  const page = {
    evaluate: async () => {
      attempts += 1;
      throw new TypeError('Failed to fetch');
    },
    waitForTimeout: async (delay) => {
      delays.push(delay);
    },
  };

  assert.equal(
    (
      await submitPortalPairingCode(page, {
        namespace: 'desktop-app',
        code: '123456',
        ambiguousActivationWaitMs: 15_000,
        isDesktopActivated: async () => {
          activationChecks += 1;
          return activationChecks === 2;
        },
      })
    ).desktopActivated,
    true,
  );
  assert.equal(attempts, 1);
  assert.equal(activationChecks, 2);
  assert.deepEqual(delays, [15_000]);
});

test('does not retry a non-fetch page evaluation failure', async () => {
  let attempts = 0;
  const delays = [];
  const page = {
    evaluate: async () => {
      attempts += 1;
      throw new Error('Execution context was destroyed');
    },
    waitForTimeout: async (delay) => {
      delays.push(delay);
    },
  };

  await assert.rejects(
    () =>
      submitPortalPairingCode(page, {
        namespace: 'desktop-app',
        code: '123456',
        retryDelayMs: 25,
      }),
    /Execution context was destroyed/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test('does not replay an ambiguous fetch failure when retry is disabled', async () => {
  let attempts = 0;
  const delays = [];
  const page = {
    evaluate: async () => {
      attempts += 1;
      throw new TypeError('Failed to fetch');
    },
    waitForTimeout: async (delay) => {
      delays.push(delay);
    },
  };

  await assert.rejects(
    () =>
      submitPortalPairingCode(page, {
        namespace: 'desktop-app',
        code: '000000',
        retryAmbiguousFetch: false,
        isDesktopActivated: async () => false,
      }),
    /Failed to fetch/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(delays, []);
});

test('retries the connect service explicit transient delivery failure', async () => {
  const results = [
    {
      status: 500,
      body: {
        error: 'Could not deliver the code to Canopy. Please try again.',
      },
    },
    { status: 200, body: { status: 'active' } },
  ];
  const delays = [];
  const page = {
    evaluate: async () => results.shift(),
    waitForTimeout: async (delay) => {
      delays.push(delay);
    },
  };

  assert.deepEqual(
    await submitPortalPairingCode(page, {
      namespace: 'desktop-app',
      code: '123456',
      retryDelayMs: 25,
    }),
    { status: 200, body: { status: 'active' } },
  );
  assert.deepEqual(delays, [25]);
  assert.equal(results.length, 0);
});

test('stops retrying when the desktop activated despite a transient delivery response', async () => {
  const results = [
    {
      status: 500,
      body: {
        error: 'Could not deliver the code to Canopy. Please try again.',
      },
    },
    {
      status: 404,
      body: {
        error: 'No pending remote control session was found for this account.',
      },
    },
  ];
  const delays = [];
  const page = {
    evaluate: async () => results.shift(),
    waitForTimeout: async (delay) => {
      delays.push(delay);
    },
  };

  assert.deepEqual(
    await submitPortalPairingCode(page, {
      namespace: 'desktop-app',
      code: '123456',
      retryDelayMs: 25,
      isDesktopActivated: async () => true,
    }),
    {
      status: 500,
      body: {
        error: 'Could not deliver the code to Canopy. Please try again.',
      },
      desktopActivated: true,
    },
  );
  assert.deepEqual(delays, []);
  assert.equal(results.length, 1);
});

test('bounds repeated transient delivery retries', async () => {
  let attempts = 0;
  const page = {
    evaluate: async () => {
      attempts += 1;
      return {
        status: 500,
        body: {
          error: 'Could not deliver the code to Canopy. Please try again.',
        },
      };
    },
    waitForTimeout: async () => undefined,
  };

  assert.deepEqual(
    await submitPortalPairingCode(page, {
      namespace: 'desktop-app',
      code: '123456',
      retryDelayMs: 0,
    }),
    {
      status: 500,
      body: {
        error: 'Could not deliver the code to Canopy. Please try again.',
      },
    },
  );
  assert.equal(attempts, 5);
});

test('does not retry a pairing rejection', async () => {
  let attempts = 0;
  const page = {
    evaluate: async () => {
      attempts += 1;
      return { status: 400, body: { error: 'invalid_code' } };
    },
    waitForTimeout: async () => undefined,
  };

  assert.deepEqual(
    await submitPortalPairingCode(page, {
      namespace: 'desktop-app',
      code: '000000',
    }),
    { status: 400, body: { error: 'invalid_code' } },
  );
  assert.equal(attempts, 1);
});

test('does not retry a structured pairing 404', async () => {
  let attempts = 0;
  const page = {
    evaluate: async () => {
      attempts += 1;
      return {
        status: 404,
        body: { error: 'That code did not match.' },
      };
    },
    waitForTimeout: async () => undefined,
  };

  assert.deepEqual(
    await submitPortalPairingCode(page, {
      namespace: 'desktop-app',
      code: '000000',
    }),
    { status: 404, body: { error: 'That code did not match.' } },
  );
  assert.equal(attempts, 1);
});

test('accepts an already-active desktop after a connect replay returns 404', () => {
  assert.equal(
    isPortalPairingSuccessful(
      {
        status: 404,
        body: {
          error:
            'No pending remote control session was found for this account.',
        },
      },
      { status: 'active', sessionId: 'portal-session' },
    ),
    true,
  );
  assert.equal(
    isPortalPairingSuccessful(
      { status: 404, body: { error: 'That code did not match.' } },
      { status: 'pending_auth' },
    ),
    false,
  );
});

for (const found of [
  { error: Object.assign(new Error('missing'), { code: 'ENOENT' }) },
  { error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
  { status: 2, stderr: 'failure' },
  { status: 1, stdout: '123\n' },
]) {
  test(`listener enumeration refuses failed lsof: ${found.error?.code ?? found.status}`, () => {
    assert.throws(
      () =>
        getPortListenerPids(4061, { platform: 'linux', spawn: () => found }),
      /lsof/,
    );
  });
}
test('empty lsof status one means no listeners', () =>
  assert.deepEqual(
    getPortListenerPids(4061, {
      platform: 'linux',
      spawn: () => ({ status: 1, stdout: '' }),
    }),
    [],
  ));
test('listener drain tolerates disappearing PID but rejects persistent listener', async () => {
  let calls = 0;
  assert.equal(
    await drainPortListeners(1234, {
      platform: 'linux',
      getPids: () => (calls++ ? [] : ['123']),
      killPid: () => {
        throw Object.assign(new Error(), { code: 'ESRCH' });
      },
      wait: async () => {},
      stablePasses: 1,
    }),
    true,
  );
  await assert.rejects(
    drainPortListeners(1234, {
      platform: 'linux',
      getPids: () => ['123'],
      killPid: () => {},
      wait: async () => {},
      maxAttempts: 2,
    }),
    /did not remain clear/,
  );
});
test(
  'real Linux HTTP listener exits and its port is bindable after drain',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async () => {
    const { spawn } = await import('node:child_process');
    const { once } = await import('node:events');
    const { createServer } = await import('node:net');
    const child = spawn(
      process.execPath,
      [
        '-e',
        "require('http').createServer((q,s)=>s.end('ok')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})",
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    const exited = once(child, 'exit');
    try {
      const [data] = await once(child.stdout, 'data');
      const port = Number(String(data).trim());
      assert.deepEqual(getPortListenerPids(port), [String(child.pid)]);
      assert.equal(await drainPortListeners(port), true);
      await exited;
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      await new Promise((resolve) => server.close(resolve));
    } finally {
      child.kill('SIGKILL');
    }
  },
);
