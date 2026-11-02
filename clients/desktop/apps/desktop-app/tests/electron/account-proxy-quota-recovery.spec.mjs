// Runtime integration through public preload APIs. Actual account-proxy HTTP
// traffic uses the bundled provider; pipeline continuation uses the protocol
// fixture so we can assert the retained thread and durable completed outputs.
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { seedPipelineExecution } from './seeders/seedPipelineExecution.mjs';
import {
  DEFAULT_MOCK_BASE_URL,
  registerScenario,
  seedWorktreeChat,
} from './seeders/index.mjs';
import { withBundledBinaryOverridesScrubbed } from './seeders/bundledBinaryOverrides.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import {
  FAKE_PROXY_MANAGEMENT_KEY,
  defaultFakeProxyState,
  startFakeAccountProxy,
} from './fixtures/fake-account-proxy.mjs';
import {
  createFixture,
  closeFixture,
  conversationRequests,
  protocolEntries,
  seedPreferences,
} from './codexPipelineRuntime.mjs';

const projectId = 'demo-ts-pnpm-vite';
const worktreeId = 'demo-main';
const chatId = 'quota-chat';
const scope = { projectId, worktreeId };

async function connect(window, proxy) {
  await window.evaluate(() =>
    window.api.savePreferences({ accountProxyEnabled: true }),
  );
  const result = await window.evaluate(
    ({ url, managementKey }) =>
      window.api.accountProxy.connect({ url, managementKey }),
    {
      url: proxy.url,
      managementKey: FAKE_PROXY_MANAGEMENT_KEY,
    },
  );
  expect(result.ok).toBe(true);
  return result;
}

function cool(account, resetAt) {
  account.status = 'error';
  account.status_message = 'quota exceeded';
  account.unavailable = true;
  account.next_retry_after = new Date(resetAt).toISOString();
  account.cooldowns = [
    {
      scope: 'credential',
      reason: 'quota',
      retry_at: account.next_retry_after,
    },
  ];
  account.quota = {
    signals: {
      'anthropic-ratelimit-unified-5h-utilization': '1',
      'anthropic-ratelimit-unified-5h-reset': String(
        Math.floor(resetAt / 1000),
      ),
    },
  };
}

for (const recovery of ['timed reset', 'external reset', 'added account']) {
  test(`a live proxy request continues automatically after ${recovery}`, async () => {
    test.setTimeout(180_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-proxy-quota-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedWorktreeChat({
      userDataDir,
      workspaceId: projectId,
      worktreeId,
      providerType: 'claude',
      tabs: [{ id: chatId, title: 'Quota recovery', model: 'sonnet' }],
    });
    const marker = `Canopy-CPROXYQUOTA-${recovery.replaceAll(' ', '-')}`;
    const reply = `Recovered after ${recovery}`;
    await registerScenario(DEFAULT_MOCK_BASE_URL, marker, {
      llm: { steps: [{ text: reply, stopReason: 'end_turn' }] },
    });
    const state = defaultFakeProxyState();
    state.files = state.files.filter(
      (file) => file.email === 'sam@example.com',
    );
    state.config['api-keys'].claude = [];
    const account = state.files.find((file) => file.provider === 'claude');
    const fresh = structuredClone(account);
    let blocked = true;
    let resetAt;
    const proxy = await startFakeAccountProxy({
      state,
      upstreamUrl: DEFAULT_MOCK_BASE_URL,
      modelRefusal: () => {
        resetAt ??=
          Date.now() + (recovery === 'timed reset' ? 10_000 : 3_600_000);
        if (recovery === 'timed reset' && Date.now() >= resetAt)
          blocked = false;
        if (!blocked) return undefined;
        cool(account, resetAt);
        return {
          status: 429,
          body: {
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Quota reached' },
          },
        };
      },
    });
    let electronApp;
    try {
      ({ electronApp } = await withBundledBinaryOverridesScrubbed(() =>
        launchCanopy({ userDataDir }),
      ));
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      await connect(window, proxy);
      await window.evaluate((request) => window.api.chat.sendMessage(request), {
        ...scope,
        chatId,
        userMessageId: 'quota-prompt',
        text: `[${marker}] Continue this task.`,
        providerType: 'claude',
        model: 'sonnet',
        approvalMode: 'full_access',
      });
      await expect
        .poll(() => proxy.modelRequests.length, { timeout: 60_000 })
        .toBeGreaterThan(0);
      const checksBefore = proxy.requests.filter((request) =>
        request.path.endsWith('/credentials'),
      ).length;
      if (recovery === 'external reset') {
        account.status = 'active';
        account.unavailable = false;
        account.cooldowns = [];
        delete account.next_retry_after;
        // Keep passive utilization at 100%; a purchase need not refresh it.
        blocked = false;
      } else if (recovery === 'added account') {
        fresh.auth_index = 'f00df00df00df00d';
        fresh.email = 'added@example.com';
        fresh.name = 'claude-added@example.com.json';
        state.files.push(fresh);
        blocked = false;
      }
      await expect
        .poll(
          async () => {
            const tabs = await window.evaluate(
              (request) => window.api.chat.loadTabs(request),
              scope,
            );
            return JSON.stringify(tabs).includes(reply);
          },
          { timeout: 90_000, intervals: [1000] },
        )
        .toBe(true);
      const calls = proxy.modelRequests.filter(
        (request) => request.sessionId === proxy.modelRequests[0].sessionId,
      );
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(new Set(calls.map((request) => request.sessionId)).size).toBe(1);
      const checksAfter = proxy.requests.filter((request) =>
        request.path.endsWith('/credentials'),
      ).length;
      expect(checksAfter - checksBefore).toBeLessThanOrEqual(4);
    } finally {
      if (electronApp) await closeCanopy(electronApp, userDataDir);
      await proxy.close();
    }
  });
}

test('a paused pipeline automatically resumes its original thread and keeps completed steps', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-pipeline-quota-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  const fixture = createFixture('proxy-quota', 'Pipeline recovered');
  const proxy = await startFakeAccountProxy();
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await connect(window, proxy);
    const pipeline = {
      name: 'Proxy quota pipeline',
      on: 'dispatch',
      jobs: {
        verify: {
          steps: [
            { id: 'completed', run: 'echo preserved >> completed-once.txt' },
            {
              id: 'agent',
              uses: 'builtin/agent-prompt',
              timeout_minutes: 1,
              with: {
                model: 'gpt-6-sol',
                permission_preset: 'read_only',
                prompt: 'Continue pipeline work after capacity returns.',
              },
            },
          ],
        },
      },
    };
    const cwd = path.join(
      userDataDir,
      'workspaces',
      projectId,
      'worktrees',
      worktreeId,
    );
    const result = await window.evaluate(
      ({ pipeline, options }) => window.pipelines.execute(pipeline, options),
      {
        pipeline,
        options: {
          cwd,
          pipelineId: 'quota-pipeline',
          scope: 'worktree',
          ...scope,
        },
      },
    );
    expect(result.success).toBe(true);
    const executionId = result.data.id;
    const readState = async () =>
      (
        await window.evaluate(
          (id) => window.pipelines.getExecution(id),
          executionId,
        )
      ).data;
    await expect
      .poll(async () => (await readState())?.status, { timeout: 30_000 })
      .toBe('paused');
    const paused = await readState();
    expect(paused.status_reasons[0].account_proxy_connection_id).toBeTruthy();
    const checkpoint = paused.jobs.verify.steps.agent.agent_recovery;
    expect(checkpoint.strategy).toBe('continue_session');
    expect(checkpoint.session_id).toBeTruthy();
    cool(
      proxy.state.files.find((file) => file.provider === 'codex'),
      Date.now() + 3_600_000,
    );
    const completed = structuredClone(paused.jobs.verify.steps.completed);
    writeFileSync(fixture.releasePath, 'capacity restored');
    const added = structuredClone(
      defaultFakeProxyState().files.find((file) => file.provider === 'codex'),
    );
    added.auth_index = '1234123412341234';
    proxy.state.files.push(added);
    await expect
      .poll(async () => (await readState())?.status, {
        timeout: 90_000,
        intervals: [1000],
      })
      .toBe('success');
    const finished = await readState();
    expect(finished.jobs.verify.steps.completed).toEqual(completed);
    const requests = conversationRequests(fixture.logPath);
    expect(
      requests.some(
        (request) =>
          request.method === 'thread/resume' &&
          request.params.threadId === checkpoint.session_id,
      ),
    ).toBe(true);
    const turns = requests.filter(
      (request) =>
        request.method === 'turn/start' &&
        request.params.threadId === checkpoint.session_id,
    );
    expect(turns).toHaveLength(2);
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    await proxy.close();
  }
});

test('a successful proxy chat does not auto-resume after an early quota notice', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-quota-notice-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'codex',
    tabs: [{ id: chatId, title: 'Successful chat', model: 'gpt-6-sol' }],
  });
  const reply = 'Successful work needs no continuation';
  const fixture = createFixture('proxy-quota-notice', reply);
  const proxy = await startFakeAccountProxy();
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await connect(window, proxy);
    await window.evaluate((request) => window.api.chat.sendMessage(request), {
      ...scope,
      chatId,
      userMessageId: 'successful-prompt',
      text: 'Complete this task.',
      providerType: 'codex',
      model: 'gpt-6-sol',
      approvalMode: 'full_access',
    });
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await window.evaluate(
              (request) => window.api.chat.loadTabs(request),
              scope,
            ),
          ).includes(reply),
        { timeout: 45_000 },
      )
      .toBe(true);
    expect(
      protocolEntries(fixture.logPath).some(
        (entry) =>
          entry.direction === 'server' &&
          entry.message.method === 'account/rateLimits/updated',
      ),
    ).toBe(true);
    const registryPath = path.join(userDataDir, 'usage-limited-chats.json');
    const entries = existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, 'utf8')).entries
      : [];
    expect(entries.filter((entry) => entry.chatId === chatId)).toEqual([]);
    const turns = conversationRequests(fixture.logPath).filter(
      (request) => request.method === 'turn/start',
    );
    expect(turns).toHaveLength(1);
  } finally {
    await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    await proxy.close();
  }
});

test('a successful root chat does not auto-resume after a child quota failure', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-child-quota-'),
  );
  const fakeCliPath = path.join(userDataDir, 'fake-claude-pressure-cli.mjs');
  const logPath = path.join(userDataDir, 'quota-child.log');
  copyFileSync(
    new URL('./fixtures/fake-claude-pressure-cli.mjs', import.meta.url),
    fakeCliPath,
  );
  chmodSync(fakeCliPath, 0o755);
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'claude',
    tabs: [
      { id: chatId, title: 'Successful root chat', providerType: 'claude' },
    ],
  });
  const proxy = await startFakeAccountProxy();
  const { electronApp } = await withBundledBinaryOverridesScrubbed(() =>
    launchCanopy({
      userDataDir,
      env: {
        CLAUDE_CODE_EXECUTABLE: fakeCliPath,
        CANOPY_CLAUDE_PRESSURE_LOG: logPath,
      },
    }),
  );
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await connect(window, proxy);
    await window.evaluate((request) => window.api.chat.sendMessage(request), {
      ...scope,
      chatId,
      userMessageId: 'successful-root-prompt',
      text: 'Complete root despite child quota.',
      providerType: 'claude',
      approvalMode: 'full_access',
    });
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await window.evaluate(
              (request) => window.api.chat.loadTabs(request),
              scope,
            ),
          ).includes('Root work completed despite child quota'),
        { timeout: 45_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          existsSync(logPath) &&
          readFileSync(logPath, 'utf8').includes('quota-child-terminal'),
      )
      .toBe(true);
    const registryPath = path.join(userDataDir, 'usage-limited-chats.json');
    const entries = existsSync(registryPath)
      ? JSON.parse(readFileSync(registryPath, 'utf8')).entries
      : [];
    expect(entries.filter((entry) => entry.chatId === chatId)).toEqual([]);
    expect(
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(
          (line) => line && JSON.parse(line).type === 'quota-child-terminal',
        ),
    ).toHaveLength(1);
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await proxy.close();
  }
});

test('Stop then Dismiss during a capacity read keeps the interrupted chat stopped', async () => {
  test.setTimeout(180_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-proxy-stop-race-'),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  seedPreferences(userDataDir);
  seedWorktreeChat({
    userDataDir,
    workspaceId: projectId,
    worktreeId,
    providerType: 'codex',
    tabs: [{ id: chatId, title: 'Stopped quota recovery', model: 'gpt-6-sol' }],
  });
  const fixture = createFixture(
    'proxy-quota',
    'This stopped turn must not resume',
  );
  let hold = false;
  let entered;
  const pendingRead = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const releaseRead = new Promise((resolve) => {
    release = resolve;
  });
  const proxy = await startFakeAccountProxy({
    beforeCredentialsRead: async () => {
      if (!hold) return;
      hold = false;
      entered();
      await releaseRead;
    },
  });
  const { electronApp } = await launchCanopy({ userDataDir, env: fixture.env });
  try {
    const window = await electronApp.firstWindow();
    await new CanopyAppDriver(window).waitForShell();
    await connect(window, proxy);
    cool(
      proxy.state.files.find((file) => file.provider === 'codex'),
      Date.now() + 3_600_000,
    );
    await window.evaluate((request) => window.api.chat.sendMessage(request), {
      ...scope,
      chatId,
      userMessageId: 'stop-race-prompt',
      text: 'Begin this task.',
      providerType: 'codex',
      model: 'gpt-6-sol',
      approvalMode: 'full_access',
    });
    await expect
      .poll(
        async () => {
          const groups = await window.evaluate(() =>
            window.api.listUsageLimitedIdleSessions({}),
          );
          return groups
            .flatMap((group) => group.sessions)
            .some(
              (session) => session.kind === 'chat' && session.chatId === chatId,
            );
        },
        { timeout: 45_000 },
      )
      .toBe(true);
    await window.evaluate(
      (target) => window.api.enqueueResumeQueue({ targets: [target] }),
      {
        kind: 'chat',
        ...scope,
        chatId,
      },
    );
    const modal = window.getByTestId('resume-queue-modal');
    hold = true;
    if (!(await modal.isVisible())) {
      // A single-session chip opens its chat; its trailing action opens the
      // queue.
      await expect(window.getByTestId('resume-queue-sidebar')).toContainText(
        'Stopped quota recovery',
      );
      const openQueue = window.getByTestId('resume-queue-sidebar-open-queue');
      await expect(openQueue).toBeVisible();
      await expect(openQueue).toBeEnabled();
      // Hidden Linux windows do not advance the frames used by click's
      // stability check. Verify the real control, then send the mouse click.
      await openQueue.click({ force: true });
    }
    await expect(modal).toBeVisible();
    // A management read is an actual asynchronous boundary of the collector.
    await expect.poll(() => !hold, { timeout: 60_000 }).toBe(true);
    await pendingRead;
    const stop = modal.getByRole('button', {
      name: 'Stop remaining',
      exact: true,
    });
    await expect(stop).toBeVisible();
    await expect(stop).toBeEnabled();
    await stop.click({ force: true });
    await expect
      .poll(async () => {
        const queue = await window.evaluate(() => window.api.getResumeQueue());
        return queue.entries.every((entry) => entry.status === 'stopped');
      })
      .toBe(true);
    const done = modal.getByRole('button', { name: 'Done', exact: true });
    await expect(done).toBeVisible();
    await expect(done).toBeEnabled();
    await done.click({ force: true });
    await expect(modal).not.toBeVisible();
    proxy.state.files = defaultFakeProxyState().files;
    writeFileSync(fixture.releasePath, 'capacity restored after Stop');
    release();
    // Observe two collector scan intervals. A stale enrollment must never
    // appear, even if the resumed provider would finish immediately.
    const observationEndsAt = Date.now() + 12_000;
    await expect
      .poll(
        async () => {
          const queue = await window.evaluate(() =>
            window.api.getResumeQueue(),
          );
          expect(queue.entries).toHaveLength(0);
          expect(
            conversationRequests(fixture.logPath).filter(
              (request) => request.method === 'turn/start',
            ),
          ).toHaveLength(1);
          return Date.now() >= observationEndsAt;
        },
        { timeout: 15_000, intervals: [100, 500] },
      )
      .toBe(true);
  } finally {
    release();
    try {
      await closeFixture(electronApp, userDataDir, fixture.runtimeDir);
    } finally {
      await proxy.close();
    }
  }
});

for (const location of ['project', 'local']) {
  test(`automatically enrolled ${location} pipeline shows its display label`, async () => {
    test.setTimeout(90_000);
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-proxy-pipeline-label-'),
    );
    seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    seedPreferences(userDataDir);
    const proxy = await startFakeAccountProxy();
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      await new CanopyAppDriver(window).waitForShell();
      const connection = await connect(window, proxy);
      const executionId = '123e4567-e89b-42d3-a456-426614174021';
      const reasonId = '123e4567-e89b-42d3-a456-426614174022';
      const detectedAt = '2026-04-10T12:00:00.000Z';
      seedPipelineExecution({
        userDataDir,
        ...(location === 'project'
          ? { workspaceId: projectId, worktreeId }
          : {}),
        execution: {
          id: executionId,
          pipelineName: 'Recovered pipeline label',
          status: 'paused',
          cwd: path.join(
            userDataDir,
            'workspaces',
            projectId,
            'worktrees',
            worktreeId,
          ),
          jobs: [
            { id: 'build', steps: [{ id: 'compile', run: 'echo recovered' }] },
          ],
          stepResults: {
            'build.compile': {
              status: 'paused',
              agent_recovery: {
                version: 1,
                reason_id: reasonId,
                action: 'agent-prompt',
                provider: 'codex',
                had_agent_activity: false,
                strategy: 'restart_step',
                recovery_count: 0,
                paused_at: detectedAt,
                failure_message: 'Quota reached',
                account_proxy_connection_id: connection.status.connection.id,
              },
            },
          },
          stateOverrides: {
            version: 6,
            status_reasons: [
              {
                id: reasonId,
                kind: 'provider_usage_limit',
                code: 'usage_limit_exceeded',
                provider: 'codex',
                account_scope: 'native',
                account_proxy_connection_id: connection.status.connection.id,
                detected_at: detectedAt,
                source: {
                  job_id: 'build',
                  step_id: 'compile',
                  attempt: 0,
                  iteration: 1,
                },
              },
            ],
          },
        },
      });
      const expectedName =
        location === 'local'
          ? 'Local workflows'
          : JSON.parse(
              readFileSync(
                path.join(userDataDir, 'workspaces', 'index.json'),
                'utf8',
              ),
            ).workspaces.find((entry) => entry.id === projectId).name;
      await expect
        .poll(
          async () => {
            const queue = await window.evaluate(() =>
              window.api.getResumeQueue(),
            );
            return queue.entries.find(
              (entry) =>
                entry.target.kind === 'pipeline' &&
                entry.target.executionId === executionId,
            )?.workspaceName;
          },
          { timeout: 45_000 },
        )
        .toBe(expectedName);
      const button = window.getByTestId('resume-queue-sidebar');
      const modal = window.getByTestId('resume-queue-modal');
      if (!(await modal.isVisible())) {
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
        // The single-session chip opens its session (here the pipeline run);
        // its trailing action opens the queue.
        await expect(
          window.getByTestId('resume-queue-sidebar-title'),
        ).toContainText('Recovered pipeline label');
        const openQueue = window.getByTestId('resume-queue-sidebar-open-queue');
        await expect(openQueue).toBeVisible();
        await expect(openQueue).toBeEnabled();
        await openQueue.click({ force: true });
      }
      await expect(
        modal.locator('li').filter({ hasText: 'Recovered pipeline label' }),
      ).toContainText(expectedName);
    } finally {
      await closeCanopy(electronApp, userDataDir);
      await proxy.close();
    }
  });
}
