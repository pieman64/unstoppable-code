import { expect, test } from '@playwright/test';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';

test('renderer health traverses the authenticated in-memory relay; admin and spoofed callers are denied', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    const reply = await page.evaluate(() =>
      window.canopyCore.invoke({
        kind: 'request',
        method: 'core.runtime.health.get',
        params: {},
      }),
    );
    expect(reply.ok).toBe(true);
    expect(reply.value.runtime.profile).toBe('core+worker');
    expect(reply.value.runtime.daemonEpoch).toBeTruthy();
    const workspaces = await page.evaluate(() =>
      window.canopyCore.invoke({
        kind: 'request',
        method: 'core.workspace.list',
        params: {},
      }),
    );
    expect(workspaces.ok).toBe(true);
    expect(['starting', 'ready', 'degraded']).toContain(
      reply.value.runtime.state,
    );
    const denied = await page.evaluate(async () =>
      Promise.all([
        window.canopyCore.invoke({
          kind: 'request',
          method: 'core.runtime.initialize',
          params: {},
        }),
        window.canopyCore.invoke({
          kind: 'request',
          method: 'core.client.lease.acquire',
          params: {},
        }),
        window.canopyCore.invoke({
          kind: 'request',
          method: 'core.runtime.health.get',
          params: {},
          caller: { principalId: 'admin' },
        }),
      ]),
    );
    for (const result of denied) expect(result.ok).toBe(false);
    const opened = await page.evaluate(() =>
      window.canopyCore.invoke({
        kind: 'openStream',
        method: 'core.runtime.events',
        params: { cursor: null },
      }),
    );
    expect(opened.ok).toBe(true);
    expect(opened.value.subscriptionId).toBeTruthy();
    const closed = await page.evaluate(
      (subscriptionId) =>
        window.canopyCore.invoke({
          kind: 'closeStream',
          subscriptionId,
        }),
      opened.value.subscriptionId,
    );
    expect(closed.ok).toBe(true);
    const stale = await page.evaluate(
      (subscriptionId) =>
        window.canopyCore.invoke({
          kind: 'readStream',
          subscriptionId,
        }),
      opened.value.subscriptionId,
    );
    expect(stale.ok).toBe(false);
    const registered = await page.evaluate(() =>
      window.canopyCore.invoke({
        kind: 'request',
        method: 'core.client.capabilities.register',
        params: {
          capabilities: [
            {
              name: 'core.presentation.notice',
              version: 1,
              inputSchema: {},
              outputSchema: {},
            },
          ],
          _meta: { idempotencyKey: 'electron-registration' },
        },
      }),
    );
    expect(registered.ok).toBe(true);
    expect(registered.value.registrationRevision).toBe(1);
    await page.getByTestId('sidebar-nav-app-advisor').click();
    await expect
      .poll(
        () =>
          electronApp
            .windows()
            .find((window) => window.url().includes('app-advisor'))
            ?.url(),
        { timeout: 30_000 },
      )
      .toBeTruthy();
    const advisor = electronApp
      .windows()
      .find((window) => window.url().includes('app-advisor'));
    await expect(
      advisor.getByTestId('app-advisor-workspace-surface'),
    ).toBeVisible();
    const advisorHealth = await advisor.evaluate(() =>
      window.canopyCore.invoke({
        kind: 'request',
        method: 'core.runtime.health.get',
        params: {},
      }),
    );
    expect(advisorHealth.ok).toBe(true);
    const advisorWorkspaces = await advisor.evaluate(() =>
      window.canopyCore.invoke({
        kind: 'request',
        method: 'core.workspace.list',
        params: {},
      }),
    );
    expect(advisorWorkspaces.ok).toBe(false);
    expect(advisorWorkspaces.error.kind).toBe('capability_unavailable');
    expect(
      (await page.evaluate(() => window.canopyCore.invoke({ kind: 'close' })))
        .ok,
    ).toBe(true);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('cancelled link navigation preserves relay streams and capability registrations', async () => {
  const { electronApp, userDataDir } = await launchCanopy();
  try {
    const page = await electronApp.firstWindow();
    await expect(page.getByTestId('app-sidebar')).toBeVisible();
    const originalUrl = page.url();
    await electronApp.evaluate(({ BrowserWindow }, url) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === url,
      );
      if (!window) throw new Error('Relay renderer window missing');
      window.webContents.once('will-navigate', (event) =>
        event.preventDefault(),
      );
    }, originalUrl);
    const opened = await page.evaluate(() =>
      window.canopyCore.invoke({
        kind: 'openStream',
        method: 'core.runtime.events',
        params: { cursor: null },
      }),
    );
    expect(opened.ok).toBe(true);
    const register = () =>
      page.evaluate(() =>
        window.canopyCore.invoke({
          kind: 'request',
          method: 'core.client.capabilities.register',
          params: {
            capabilities: [
              {
                name: 'core.presentation.notice',
                version: 1,
                inputSchema: {},
                outputSchema: {},
              },
            ],
            _meta: { idempotencyKey: 'cancelled-navigation-registration' },
          },
        }),
      );
    const registered = await register();
    expect(registered.ok).toBe(true);
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'file:///tmp/can3773-cancelled-navigation.html';
      link.textContent = 'Relay navigation regression';
      link.dataset.testid = 'relay-cancelled-navigation';
      document.body.appendChild(link);
    });
    await page
      .getByTestId('relay-cancelled-navigation')
      .click({ noWaitAfter: true });
    const preserved = await electronApp.evaluate(
      async ({ BrowserWindow }, input) => {
        const window = BrowserWindow.getAllWindows().find(
          (candidate) => candidate.webContents.getURL() === input.url,
        );
        if (!window)
          throw new Error('Cancelled navigation replaced the document');
        return window.webContents.executeJavaScript(`(async () => {
        const registered = await window.canopyCore.invoke(${JSON.stringify({
          kind: 'request',
          method: 'core.client.capabilities.register',
          params: {
            capabilities: [
              {
                name: 'core.presentation.notice',
                version: 1,
                inputSchema: {},
                outputSchema: {},
              },
            ],
            _meta: { idempotencyKey: 'cancelled-navigation-next-registration' },
          },
        })});
        const closed = await window.canopyCore.invoke(${JSON.stringify({ kind: 'closeStream', subscriptionId: input.subscriptionId })});
        return { registered, closed };
      })()`);
      },
      { url: originalUrl, subscriptionId: opened.value.subscriptionId },
    );
    expect(preserved.closed).toEqual({ ok: true, value: null });
    expect(preserved.registered.ok).toBe(true);
    expect(preserved.registered.value.registrationRevision).toBe(
      registered.value.registrationRevision + 1,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
