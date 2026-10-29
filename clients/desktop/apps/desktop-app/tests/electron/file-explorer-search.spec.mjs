import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKTREE_BRANCH = 'demo-main';
const CHAT_TAB_ID = 'file-explorer-search-chat';
const SEARCH_ROOT_DIR = 'e2e-search';
const SEARCH_NESTED_DIR = 'nested';
const NESTED_FILE = 'needle-widget.txt';
const NESTED_RELATIVE_PATH = `${SEARCH_ROOT_DIR}/${SEARCH_NESTED_DIR}/${NESTED_FILE}`;
const DECOY_FILE = 'e2e-search-decoy.txt';
const INDEX_EXCLUDED_FILE = 'node_modules/e2e-explorer-visible.txt';
const FILLER_FILE_COUNT = 120;
const PRODUCTION = process.env.CAN4604_PRODUCTION === '1';

test('file explorer search filters the tree and keeps folder parentage', async ({}, testInfo) => {
  if (PRODUCTION) test.setTimeout(120_000);
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-file-explorer-search-'),
  );
  const demoSeed = seedDemoWorkspaces({
    userDataDir,
    apps: ['ts-pnpm-vite'],
  });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  mkdirSync(path.join(worktreePath, SEARCH_ROOT_DIR, SEARCH_NESTED_DIR), {
    recursive: true,
  });
  writeFileSync(
    path.join(worktreePath, NESTED_RELATIVE_PATH),
    'nested search target\n',
    'utf8',
  );
  writeFileSync(
    path.join(worktreePath, DECOY_FILE),
    'top-level decoy\n',
    'utf8',
  );
  mkdirSync(path.join(worktreePath, 'node_modules'), { recursive: true });
  writeFileSync(
    path.join(worktreePath, INDEX_EXCLUDED_FILE),
    'visible in explorer search\n',
    'utf8',
  );
  for (let index = 0; index < FILLER_FILE_COUNT; index += 1) {
    writeFileSync(
      path.join(
        worktreePath,
        `e2e-search-filler-${String(index).padStart(3, '0')}.txt`,
      ),
      `filler ${index}\n`,
      'utf8',
    );
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: CHAT_TAB_ID, title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({
    userDataDir,
    ...(PRODUCTION
      ? {
          buildKind: 'production',
          productionWindowMode: 'headless',
          electronArgs: [`--user-data-dir=${userDataDir}`],
          productionAdapterArchivePath: testInfo.outputPath(
            'production.adapter.cjs',
          ),
        }
      : {}),
  });

  try {
    const window = await electronApp.firstWindow();
    const app = new CanopyAppDriver(window);
    await app.waitForShell({ timeout: 30_000 });
    if (PRODUCTION) {
      for (const profilePath of await electronApp.evaluate(({ app }) =>
        ['userData', 'sessionData'].map((key) => app.getPath(key)),
      ))
        expect(realpathSync(profilePath)).toBe(realpathSync(userDataDir));
      expect(
        await electronApp.evaluate(
          () => typeof globalThis.__CANOPY_WORK_COUNTERS__,
        ),
      ).toBe('undefined');
      expect(
        await window.evaluate(() => typeof globalThis.__CANOPY_REACT_WORK__),
      ).toBe('undefined');
    }
    await app.openMainPage();
    await app.selectWorktree(WORKTREE_BRANCH);

    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-file-explorer').click();
    await expect(
      window.getByTestId('panel-content-file-explorer'),
    ).toBeVisible();

    const explorer = window.getByTestId('files-tree-tab');
    const decoyRow = window.locator(
      `[data-testid="files-tree-row"][data-path="${DECOY_FILE}"]`,
    );
    const nestedRow = window.locator(
      `[data-testid="files-tree-row"][data-path="${NESTED_RELATIVE_PATH}"]`,
    );

    // Baseline: the repo root is expanded, so the decoy shows; the nested
    // target is inside a collapsed folder and is not rendered at all.
    await expect(decoyRow).toBeVisible({ timeout: 20_000 });
    await expect(nestedRow).toHaveCount(0);

    const evidenceTarget = {
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: WORKTREE_BRANCH,
      operation: 'directory',
      repoId: 'demo-ts-pnpm-vite',
      relativeDir: SEARCH_ROOT_DIR,
    };
    const rendererBefore = await window.evaluate(
      (target) =>
        globalThis.__CANOPY_FILES_RENDERER_EVIDENCE__.snapshot(target),
      evidenceTarget,
    );
    const mainBefore = await electronApp.evaluate(() =>
      globalThis.__CANOPY_FILES_MAIN_EVIDENCE__.snapshot(),
    );
    const host = await electronApp.browserWindow(window);
    const senderId = await host.evaluate((win) => win.webContents.id);
    expect(mainBefore.source).toBe('desktop-main-files-singleton-v1');
    expect(rendererBefore.source).toBe('desktop-renderer-file-list-store-v1');
    expect(mainBefore.route).not.toBeNull();
    await explorer
      .locator('[data-testid="files-tree-folder"]', {
        hasText: SEARCH_ROOT_DIR,
      })
      .click();
    await expect(
      explorer.locator('[data-testid="files-tree-folder"]', {
        hasText: SEARCH_NESTED_DIR,
      }),
    ).toBeVisible();
    const readRenderer = () =>
      window.evaluate(
        ({ target, cursor }) =>
          globalThis.__CANOPY_FILES_RENDERER_EVIDENCE__.snapshot(
            target,
            cursor,
          ),
        { target: evidenceTarget, cursor: rendererBefore.cursor },
      );
    await expect
      .poll(async () => (await readRenderer()).currentSuccess)
      .toBe(true);
    await window.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    const rendererAfter = await readRenderer();
    expect(rendererAfter).toMatchObject({
      complete: true,
      currentSuccess: true,
      settled: true,
      hasError: false,
    });
    expect(
      rendererAfter.entries
        .filter((entry) => entry.matchesTarget)
        .map((entry) => entry.phase),
    ).toEqual(['started', 'success']);
    const mainAfter = await electronApp.evaluate(
      (_, cursor) => globalThis.__CANOPY_FILES_MAIN_EVIDENCE__.snapshot(cursor),
      mainBefore.route.cursor,
    );
    expect(mainAfter.route.complete).toBe(true);
    expect(mainAfter.route.disposed).toBe(false);
    expect(mainAfter.route.generation).toBe(mainBefore.route.generation);
    expect(mainAfter.counters.generation).toBe(mainBefore.counters.generation);
    expect(mainAfter.counters.overflow).toBe(0);
    expect(mainAfter.counters.invocations.roots).toBe(
      mainBefore.counters.invocations.roots,
    );
    expect(rendererAfter.itemCount).toBe(1);
    expect(rendererAfter.version).toBeGreaterThan(rendererBefore.version);
    await expect(
      explorer.locator('[data-testid="files-tree-folder"]', {
        hasText: SEARCH_NESTED_DIR,
      }),
    ).toBeVisible();
    expect(mainAfter.counters.invocations.directory).toBeGreaterThan(
      mainBefore.counters.invocations.directory,
    );
    const directoryReads = mainAfter.route.entries.filter(
      (entry) => entry.operation === 'directory',
    );
    expect(directoryReads).toHaveLength(mainAfter.route.entries.length);
    expect(directoryReads.map((entry) => entry.phase)).toEqual([
      'started',
      'success',
    ]);
    expect(directoryReads[1].request).toBe(directoryReads[0].request);
    expect(directoryReads[1].backend).toBe(directoryReads[0].backend);
    for (const entry of directoryReads) {
      expect(entry.senderId).toBe(senderId);
      expect(entry.generation).toBe(mainBefore.route.generation);
    }
    const backend = directoryReads[0].backend;
    expect(backend).toBe(mainBefore.route.enabled ? 'daemon' : 'direct');
    expect(
      mainAfter.counters.invocations.directory -
        mainBefore.counters.invocations.directory,
    ).toBe(1);
    for (const selected of ['direct', 'daemon']) {
      const key = `files.directory.${selected}`;
      expect(
        mainAfter.counters.route[key] - mainBefore.counters.route[key],
      ).toBe(selected === backend ? 1 : 0);
    }
    if (backend === 'daemon') {
      expect(
        mainAfter.counters.route['files.directory.daemon.served'] -
          mainBefore.counters.route['files.directory.daemon.served'],
      ).toBe(1);
    }
    expect(rendererAfter.cursor.observerId).toBe(
      rendererBefore.cursor.observerId,
    );
    expect(mainAfter.route.cursor.observerId).toBe(
      mainBefore.route.cursor.observerId,
    );

    const scroll = explorer.getByTestId('files-tree-scroll');
    await expect
      .poll(() =>
        scroll.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      )
      .toBe(true);
    await scroll.evaluate((element) => {
      element.scrollTop = 360;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(300);
    await window.waitForTimeout(200);

    // Open search through the visible panel control after scrolling.
    const searchInput = explorer.getByTestId('files-tree-search-input');
    await expect(searchInput).toHaveCount(0);
    await explorer.getByTestId('files-tree-search-toggle').click();
    await expect(searchInput).toBeVisible();
    await expect(searchInput).toBeFocused();

    await searchInput.fill('needle-widget');

    // The match renders under every ancestor folder, even though none of them
    // were expanded before the search.
    await expect(nestedRow).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeLessThan(100);
    await expect(
      explorer.locator('[data-testid="files-tree-folder"]', {
        hasText: SEARCH_ROOT_DIR,
      }),
    ).toBeVisible();
    await expect(
      explorer.locator('[data-testid="files-tree-folder"]', {
        hasText: SEARCH_NESTED_DIR,
      }),
    ).toBeVisible();
    // Non-matching siblings drop out of the filtered tree.
    await expect(decoyRow).toHaveCount(0);

    // A query with no hits reports itself rather than showing an empty tree.
    await searchInput.fill('zzz-no-such-file-zzz');
    await expect(explorer.getByTestId('files-tree-search-empty')).toBeVisible({
      timeout: 20_000,
    });

    // Escape closes the tray and restores the unfiltered tree.
    await searchInput.press('Escape');
    await expect(searchInput).toHaveCount(0);
    await expect(decoyRow).toBeVisible({ timeout: 20_000 });
    await expect(nestedRow).toHaveCount(0);
    await expect
      .poll(() => scroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(300);

    // File-indexing exclusions affect Cmd+P and @ mentions only. The same
    // node_modules file remains explorer-visible and therefore searchable.
    await explorer.getByTestId('files-tree-search-toggle').click();
    await searchInput.fill('e2e-explorer-visible');
    await expect(
      window.locator(
        `[data-testid="files-tree-row"][data-path="${INDEX_EXCLUDED_FILE}"]`,
      ),
    ).toBeVisible({ timeout: 20_000 });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Cmd+P uses the same real disk index as mentions, with a separately ranked,
// incrementally revealed result list. More than two pages reproduce the cap.
for (const flow of ['ranking', 'scrolling', 'keyboard', 'stale-window']) {
  test(`Cmd+P README search ${flow}`, async () => {
    const userDataDir = mkdtempSync(
      path.join(os.tmpdir(), 'canopy-quick-open-'),
    );
    const seed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
    const root = seed.workspaces[0].worktreePath;
    for (let index = 0; index < 120; index += 1) {
      const directory = path.join(
        root,
        'docs',
        'planning',
        `topic-${String(index).padStart(3, '0')}`,
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, 'README.md'),
        `# Planning topic ${index}\n`,
      );
    }
    writeFileSync(
      path.join(root, 'README.md'),
      '# Root README search target\n',
    );
    seedWorktreeChat({
      userDataDir,
      workspaceId: 'demo-ts-pnpm-vite',
      worktreeId: WORKTREE_BRANCH,
      providerType: 'claude',
      tabs: [{ id: CHAT_TAB_ID, title: 'File search' }],
    });
    const { electronApp } = await launchCanopy({ userDataDir });
    try {
      const window = await electronApp.firstWindow();
      const app = new CanopyAppDriver(window);
      await app.waitForShell({ timeout: 30_000 });
      await app.openMainPage();
      await app.selectWorktree(WORKTREE_BRANCH);
      await window.keyboard.press(
        `${process.platform === 'darwin' ? 'Meta' : 'Control'}+p`,
      );
      const palette = window.getByTestId('file-search-palette');
      await expect(palette).toBeVisible();
      const input = palette.getByTestId('file-search-palette-input');
      const results = palette.getByTestId('file-search-palette-result');
      if (flow === 'stale-window') {
        await expect(results).toHaveCount(50);
        await input.press('ArrowUp');
        await expect.poll(() => results.count()).toBeLessThanOrEqual(50);
        await expect(results.last()).toHaveAttribute('aria-selected', 'true');
        await palette.evaluate((element) => {
          window.__fileSearchFalseEmptyObserved = false;
          new MutationObserver(() => {
            if (element.textContent?.includes('No matching files')) {
              window.__fileSearchFalseEmptyObserved = true;
            }
          }).observe(element, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        });
        await input.fill('topic-119/README.md');
        await expect(results).toHaveCount(1);
        expect(
          await window.evaluate(
            () => window.__fileSearchFalseEmptyObserved ?? false,
          ),
        ).toBe(false);
        await input.press('Escape');
        await expect(palette).toHaveCount(0);
        return;
      }
      await input.fill('README.md');
      await expect(results.first().locator('mark').first()).toHaveText(
        'README.md',
      );
      await expect(results).toHaveCount(50);
      const scroll = palette.getByTestId('file-search-palette-scroll');
      if (flow === 'ranking') {
        await expect(results.first()).toHaveAttribute('data-path', 'README.md');
        await input.press('Enter');
        await expect(palette).toHaveCount(0);
        await expect(window.getByTestId('file-viewer')).toContainText(
          'Root README search target',
        );
      } else if (flow === 'scrolling') {
        const observedPaths = new Set(
          await results.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-path')),
          ),
        );
        for (const page of [
          {
            firstPath: 'README.md',
            lastPath: 'docs/planning/topic-048/README.md',
            nextFirstPath: 'docs/planning/topic-049/README.md',
          },
          {
            firstPath: 'docs/planning/topic-049/README.md',
            lastPath: 'docs/planning/topic-098/README.md',
            nextFirstPath: 'docs/planning/topic-099/README.md',
          },
        ]) {
          await scroll.evaluate((element) => {
            element.scrollTop = element.scrollHeight - element.clientHeight - 1;
          });
          await expect(results.first()).toHaveAttribute(
            'data-path',
            page.firstPath,
          );
          await expect(results.last()).toHaveAttribute(
            'data-path',
            page.lastPath,
          );
          await expect(results.last()).toBeInViewport();
          await scroll.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          await expect(results.first()).toHaveAttribute(
            'data-path',
            page.nextFirstPath,
          );
          expect(await results.count()).toBeLessThanOrEqual(50);
          await expect(
            palette.locator(
              '[data-testid="file-search-palette-result"][aria-selected="true"]',
            ),
          ).toBeVisible();
          for (const resultPath of await results.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-path')),
          )) {
            observedPaths.add(resultPath);
          }
        }
        expect(observedPaths.size).toBe(121);
        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        expect(await results.count()).toBeLessThanOrEqual(50);
        await expect(results.last()).toBeInViewport();
        await input.fill('topic-119/README.md');
        await expect(results).toHaveCount(1);
        await input.fill('README.md');
        await expect(results).toHaveCount(50);
        await expect
          .poll(() => scroll.evaluate((element) => element.scrollTop))
          .toBe(0);
        await input.fill('no-such-file-zzzz');
        await expect(palette).toContainText('No matching files');
        await input.fill('');
        await expect(results).toHaveCount(50);
        const firstEmptyQueryPath = await results
          .first()
          .getAttribute('data-path');
        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await expect
          .poll(() => results.first().getAttribute('data-path'))
          .not.toBe(firstEmptyQueryPath);
        expect(await results.count()).toBeLessThanOrEqual(50);
        await input.press('Escape');
        await expect(palette).toHaveCount(0);
      } else {
        await input.press('ArrowUp');
        await expect.poll(() => results.count()).toBeLessThanOrEqual(50);
        await expect(results.last()).toHaveAttribute('aria-selected', 'true');
        for (let index = 0; index < 21; index += 1)
          await input.press('ArrowUp');
        await expect(
          palette.locator(
            '[data-testid="file-search-palette-result"][aria-selected="true"]',
          ),
        ).toHaveAttribute('data-path', 'docs/planning/topic-098/README.md');
        await input.press('ArrowDown');
        await expect(
          palette.locator(
            '[data-testid="file-search-palette-result"][aria-selected="true"]',
          ),
        ).toHaveAttribute('data-path', 'docs/planning/topic-099/README.md');
        await input.fill('topic-119/README.md');
        await expect(results).toHaveCount(1);
        await input.fill('README.md');
        await expect(results).toHaveCount(50);
        for (let index = 0; index < 50; index += 1)
          await input.press('ArrowDown');
        await expect(results).toHaveCount(50);
        const selectedResult = palette.locator(
          '[data-testid="file-search-palette-result"][aria-selected="true"]',
        );
        await expect(selectedResult).toHaveAttribute(
          'data-path',
          'docs/planning/topic-049/README.md',
        );
        await input.press('ArrowUp');
        await expect(selectedResult).toHaveAttribute(
          'data-path',
          'docs/planning/topic-048/README.md',
        );
        await input.press('ArrowDown');
        await expect(selectedResult).toHaveAttribute(
          'data-path',
          'docs/planning/topic-049/README.md',
        );
        await input.press('Enter');
        await expect(palette).toHaveCount(0);
        await expect(window.getByTestId('file-viewer')).toContainText(
          'Planning topic',
        );
      }
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  });
}
