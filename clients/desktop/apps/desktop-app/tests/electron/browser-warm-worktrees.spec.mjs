// Exercises the graduated native Browser view lifecycle through real
// worktree navigation. Pages come from an in-test loopback server.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import {
  cleanupDemoWorkspaces,
  seedDemoWorkspaces,
} from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { collectLeaves, getLayout } from './panelHarness.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

async function pageServer() {
  const requests = new Map();
  const server = http.createServer((request, response) => {
    const page = request.url ?? '/';
    requests.set(page, (requests.get(page) ?? 0) + 1);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<html><head><title>Warm ${page}</title></head><body>${page}</body></html>`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing server port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function seedWorktrees(userDataDir) {
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const workspace = demoSeed.workspaces[0];
  const file = path.join(
    userDataDir,
    'workspaces',
    workspace.id,
    'worktrees.json',
  );
  const catalog = JSON.parse(readFileSync(file, 'utf8'));
  const first = catalog.worktrees[0];
  const ids = [first.id];
  for (const id of ['warm-y', 'warm-z', 'warm-a', 'warm-b']) {
    const worktreePath = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'worktrees',
      id,
    );
    execFileSync('git', ['worktree', 'add', '-b', id, worktreePath], {
      cwd: workspace.repoPath,
    });
    catalog.worktrees.push({
      ...first,
      id,
      path: worktreePath,
      branchName: id,
      createdAt: new Date().toISOString(),
    });
    ids.push(id);
  }
  writeFileSync(file, `${JSON.stringify(catalog, null, 2)}\n`);
  for (const id of ids) {
    seedWorktreeChat({
      userDataDir,
      workspaceId: workspace.id,
      worktreeId: id,
      providerType: 'claude',
      tabs: [{ id: `${id}-chat`, title: `Chat ${id}` }],
    });
    const dataDir = path.join(
      userDataDir,
      'workspaces',
      workspace.id,
      'worktree-data',
      id,
    );
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, 'panel-layout-mode.json'),
      JSON.stringify({ version: 1, mode: 'advanced' }),
    );
  }
  return { ids, demoSeed };
}

async function nativeView(electronApp, url) {
  return electronApp.evaluate(({ BrowserWindow }, targetUrl) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const visit = (view) => {
        for (const child of view.children) {
          if (
            'webContents' in child &&
            child.webContents.getURL() === targetUrl
          ) {
            return { id: child.webContents.id, visible: child.getVisible() };
          }
          const nested = visit(child);
          if (nested) return nested;
        }
        return null;
      };
      const found = visit(win.contentView);
      if (found) return found;
    }
    return null;
  }, url);
}

async function openPage(window, origin, id) {
  const before = await getLayout(window);
  const groupId = collectLeaves(before.root)[0]?.groupId;
  expect(groupId).toBeTruthy();
  // The add-panel menu lives on the tab row's + button.
  await window.getByTestId(`panel-add-tab-${groupId}`).click();
  await window.getByTestId('panel-add-menu-item-browser').click();
  const layout = await getLayout(window);
  const browserId = collectLeaves(layout.root)
    .flatMap((leaf) => leaf.panels)
    .find((panel) => panel.kind === 'browser')?.instance?.browserId;
  expect(browserId).toBeTruthy();
  const pane = window.getByTestId(`browser-pane-${browserId}`);
  await expect(pane).toHaveAttribute('data-browser-state', 'live', {
    timeout: 30_000,
  });
  const input = pane.getByTestId('browser-url-input');
  await input.fill(`${origin}/${id}`);
  await input.press('Enter');
}

test('preserves warm native views, evicts the oldest, and ignores the legacy preference', async () => {
  test.setTimeout(240_000);
  const server = await pageServer();
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'canopy-warm-views-'));
  const { ids, demoSeed } = seedWorktrees(userDataDir);
  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    await app.openMainPage();
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: true,
      }),
    );
    await app.selectWorktree(ids[0]);
    await expect(window.getByTestId('panel-grid-root')).toBeVisible();

    const originals = new Map();
    for (const id of ids.slice(0, 4)) {
      await app.selectWorktree(id);
      await openPage(window, server.origin, id);
      const url = `${server.origin}/${id}`;
      await expect
        .poll(() => nativeView(electronApp, url))
        .toMatchObject({ visible: true });
      originals.set(id, (await nativeView(electronApp, url)).id);
      for (const previous of ids.slice(0, originals.size - 1)) {
        await expect
          .poll(() => nativeView(electronApp, `${server.origin}/${previous}`))
          .toMatchObject({ id: originals.get(previous), visible: false });
      }
    }

    // X is the oldest warm worktree while A is active. Returning to X must
    // keep its native view and page load, then evict Y instead.
    const x = ids[0];
    const y = ids[1];
    const requestsBefore = server.requests.get(`/${x}`);
    await app.selectWorktree(x);
    await expect
      .poll(() => nativeView(electronApp, `${server.origin}/${x}`))
      .toMatchObject({ id: originals.get(x), visible: true });
    expect(server.requests.get(`/${x}`)).toBe(requestsBefore);

    await app.selectWorktree(ids[4]);
    await openPage(window, server.origin, ids[4]);
    await expect
      .poll(() => nativeView(electronApp, `${server.origin}/${ids[4]}`))
      .toMatchObject({ visible: true });
    await expect
      .poll(() => nativeView(electronApp, `${server.origin}/${y}`))
      .toBeNull();

    const retained = [ids[0], ids[2], ids[3]];
    const retainedRequests = new Map();
    for (const id of retained) {
      await expect
        .poll(() => nativeView(electronApp, `${server.origin}/${id}`))
        .toMatchObject({ id: originals.get(id), visible: false });
      retainedRequests.set(id, server.requests.get(`/${id}`));
    }
    await window.evaluate(() =>
      window.api.experiments.setChoice({
        experimentId: 'early-access',
        enabled: false,
      }),
    );
    // Changing the legacy choice must preserve every warm native view.
    for (const id of retained) {
      await expect
        .poll(() => nativeView(electronApp, `${server.origin}/${id}`))
        .toMatchObject({ id: originals.get(id), visible: false });
      expect(server.requests.get(`/${id}`)).toBe(retainedRequests.get(id));
    }
    await expect
      .poll(() => nativeView(electronApp, `${server.origin}/${ids[4]}`))
      .toMatchObject({ visible: true });
  } finally {
    await closeCanopy(electronApp, userDataDir);
    await server.close();
    cleanupDemoWorkspaces(demoSeed);
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(`${userDataDir}-secure`, { recursive: true, force: true });
  }
});
