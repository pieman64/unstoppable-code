import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { CanopyAppDriver } from './canopyApp.mjs';
import { seedDemoWorkspaces } from './demoWorkspaces.mjs';
import { closeCanopy, launchCanopy } from './launchCanopy.mjs';
import { seedWorktreeChat } from './seeders/index.mjs';

const WORKTREE_BRANCH = 'demo-main';

function row(window, relativePath) {
  return window.locator(
    `[data-testid="files-tree-row"][data-path="${relativePath}"]`,
  );
}

function folder(window, relativePath) {
  return window.locator(
    `[data-testid="files-tree-folder"][data-path="${relativePath}"]`,
  );
}

async function openExplorer(window) {
  const app = new CanopyAppDriver(window);
  await app.waitForShell({ timeout: 30_000 });
  await app.openMainPage();
  await app.selectWorktree(WORKTREE_BRANCH);
  await window.getByTestId('panel-add-tab-group-chat').click();
  await window.getByTestId('panel-add-menu-item-file-explorer').click();
  const explorer = window.getByTestId('files-tree-tab');
  await expect(explorer).toBeVisible();
  return explorer;
}

/** The single panel of `kind` in the worktree layout, with its group. */
async function findPanelOfKind(window, kind) {
  const matches = await window.evaluate((panelKind) => {
    const found = [];
    const visit = (node) => {
      if (node.type === 'leaf') {
        for (const panel of node.panels) {
          if (panel.kind === panelKind) {
            found.push({ panelId: panel.panelId, groupId: node.groupId });
          }
        }
        return;
      }
      node.children.forEach(visit);
    };
    visit(window.__canopyPanelTestApi.getSerializedLayout().root);
    return found;
  }, kind);
  expect(matches, `one ${kind} panel`).toHaveLength(1);
  return matches[0];
}

async function observeExplorerLoadingFlashes(explorer) {
  await explorer.evaluate((element) => {
    const state = { flashes: 0 };
    const inspect = () => {
      if (
        element.querySelector('[data-testid="loading-placeholder"]') ||
        element.textContent?.includes('Loading…')
      ) {
        state.flashes += 1;
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(element, { childList: true, subtree: true });
    window.__fileExplorerLoadingObserver = observer;
    window.__fileExplorerLoadingState = state;
  });
}

async function readExplorerLoadingFlashes(explorer) {
  return explorer.evaluate(() => {
    window.__fileExplorerLoadingObserver?.disconnect();
    return window.__fileExplorerLoadingState?.flashes ?? 0;
  });
}

test('file explorer supports selection, keyboard navigation, and the complete context menu', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-explorer-ui-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  for (const name of ['select-a.txt', 'select-b.txt', 'select-c.txt']) {
    writeFileSync(path.join(worktreePath, name), `${name}\n`, 'utf8');
  }
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: 'explorer-ui-chat', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const explorer = await openExplorer(window);
    const first = row(window, 'select-a.txt');
    const second = row(window, 'select-b.txt');
    const third = row(window, 'select-c.txt');
    await expect(first).toBeVisible({ timeout: 20_000 });

    await first.click({ button: 'right' });
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await window.keyboard.press('Escape');
    await second.click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });
    await expect(second).toHaveAttribute('aria-selected', 'true');

    await third.click({ modifiers: ['Shift'] });
    await expect(second).toHaveAttribute('aria-selected', 'true');
    await expect(third).toHaveAttribute('aria-selected', 'true');

    await third.focus();
    await third.press('ArrowUp');
    await expect(second).toBeFocused();
    await second.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await expect
      .poll(() =>
        explorer.locator('[role="treeitem"][aria-selected="true"]').count(),
      )
      .toBeGreaterThan(3);

    await second.click({ button: 'right' });
    const menu = window.getByTestId('files-tree-action-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('role', 'menu');
    await expect(menu).toHaveCSS('flex-direction', 'column');
    await expect(
      menu.locator('[data-testid="files-tree-action-copy"] svg'),
    ).toHaveCount(1);
    for (const label of [
      'Open',
      'Send to chat',
      'Cut',
      'Copy',
      'Copy path',
      'Copy relative path',
      'Rename',
      'Delete',
    ]) {
      await expect(
        menu.getByRole('menuitem', { name: label, exact: true }),
      ).toBeVisible();
    }
    await expect(
      menu.getByTestId('files-tree-action-open-in-file-manager'),
    ).toBeVisible();
    const openInAppItem = menu.getByTestId('files-tree-action-open-in-app');
    await expect(openInAppItem).toBeVisible();
    await expect(openInAppItem.locator('img')).toBeVisible();
    const openInAppLabel = await openInAppItem.getAttribute('aria-label');
    expect(openInAppLabel).toMatch(/^Open in .+/);
    await openInAppItem.hover();
    await expect(
      window.getByRole('tooltip').filter({ hasText: openInAppLabel }),
    ).toBeVisible();
    await expect(
      menu.getByRole('menuitem', { name: 'Open to the side' }),
    ).toBeVisible();
    await expect(
      menu.getByRole('menuitem', {
        name: 'Open with default application',
      }),
    ).toBeVisible();

    await menu
      .getByRole('menuitem', { name: 'Copy relative path', exact: true })
      .click();
    await expect(menu).toBeHidden();

    await second.click({ button: 'right' });
    await menu
      .getByRole('menuitem', { name: 'Copy path', exact: true })
      .click();
    await expect(menu).toBeHidden();

    const viewport = window.viewportSize();
    expect(viewport, 'Electron renderer viewport').not.toBeNull();
    await second.evaluate(
      (element, { clientX, clientY }) => {
        element.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            buttons: 2,
            clientX,
            clientY,
          }),
        );
      },
      { clientX: viewport.width - 1, clientY: viewport.height - 1 },
    );
    await expect(menu).toBeVisible();
    const edgeGeometry = await menu.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    expect(edgeGeometry.left).toBeGreaterThanOrEqual(8);
    expect(edgeGeometry.top).toBeGreaterThanOrEqual(8);
    expect(edgeGeometry.right).toBeLessThanOrEqual(
      edgeGeometry.viewportWidth - 8,
    );
    expect(edgeGeometry.bottom).toBeLessThanOrEqual(
      edgeGeometry.viewportHeight - 8,
    );

    await explorer.getByTestId('files-tree-scroll').evaluate((element) => {
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(menu).toBeHidden();
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('file explorer creates, renames, copies, moves, and deletes filesystem entries', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-explorer-ops-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  mkdirSync(path.join(worktreePath, 'source'), { recursive: true });
  mkdirSync(path.join(worktreePath, 'target'), { recursive: true });
  mkdirSync(path.join(worktreePath, 'search-parent'), { recursive: true });
  mkdirSync(path.join(worktreePath, 'cut-source'), { recursive: true });
  mkdirSync(path.join(worktreePath, 'cut-target'), { recursive: true });
  mkdirSync(path.join(worktreePath, 'cut-tree'), { recursive: true });
  mkdirSync(path.join(worktreePath, 'cut-tree-target'), { recursive: true });
  mkdirSync(path.join(worktreePath, 'delete-source'), { recursive: true });
  writeFileSync(path.join(worktreePath, 'source', 'move-me.txt'), 'move me\n');
  writeFileSync(path.join(worktreePath, 'target-search.txt'), 'search\n');
  writeFileSync(path.join(worktreePath, 'cut-source', 'first.txt'), 'first\n');
  writeFileSync(
    path.join(worktreePath, 'cut-source', 'second.txt'),
    'second\n',
  );
  writeFileSync(
    path.join(worktreePath, 'cut-target', 'second.txt'),
    'conflict\n',
  );
  writeFileSync(path.join(worktreePath, 'cut-tree', 'child.txt'), 'child\n');
  writeFileSync(path.join(worktreePath, 'cut-tree-other.txt'), 'other\n');
  writeFileSync(
    path.join(worktreePath, 'cut-tree-target', 'cut-tree-other.txt'),
    'conflict\n',
  );
  writeFileSync(
    path.join(worktreePath, 'delete-source', 'first.txt'),
    'first\n',
  );
  writeFileSync(
    path.join(worktreePath, 'delete-source', 'second.txt'),
    'second\n',
  );
  writeFileSync(
    path.join(worktreePath, 'search-parent', 'search-child.txt'),
    'nested search\n',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: 'explorer-ops-chat', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const explorer = await openExplorer(window);
    const targetFolder = folder(window, 'target');
    await expect(targetFolder).toBeVisible({ timeout: 20_000 });

    await explorer.getByTestId('files-tree-collapse-all').click();
    await expect(targetFolder).toHaveCount(0);
    await explorer.getByTestId('files-tree-new-file').click();
    await expect(
      explorer.getByTestId('files-tree-inline-editor'),
    ).toBeVisible();
    await explorer.getByTestId('files-tree-inline-editor').press('Escape');
    await expect(targetFolder).toBeVisible();

    await explorer.getByTestId('files-tree-search-toggle').click();
    await explorer.getByTestId('files-tree-search-input').fill('target-search');
    await expect(row(window, 'target-search.txt')).toBeVisible();
    await explorer.getByTestId('files-tree-new-file').click();
    await expect(explorer.getByTestId('files-tree-search-input')).toHaveCount(
      0,
    );
    await expect(
      explorer.getByTestId('files-tree-inline-editor'),
    ).toBeVisible();
    await explorer.getByTestId('files-tree-inline-editor').press('Escape');

    await explorer.getByTestId('files-tree-search-toggle').click();
    await explorer.getByTestId('files-tree-search-input').fill('search-child');
    const nestedSearchResult = row(window, 'search-parent/search-child.txt');
    await expect(nestedSearchResult).toBeVisible();
    await nestedSearchResult.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'New file…' }).click();
    await expect(explorer.getByTestId('files-tree-search-input')).toHaveCount(
      0,
    );
    const searchCreateEditor = explorer.getByTestId('files-tree-inline-editor');
    await expect(searchCreateEditor).toBeVisible();
    await searchCreateEditor.fill('created-from-search.txt');
    await searchCreateEditor.press('Enter');
    await expect
      .poll(() =>
        existsSync(
          path.join(worktreePath, 'search-parent', 'created-from-search.txt'),
        ),
      )
      .toBe(true);
    await expect(explorer.getByRole('alert')).toHaveCount(0);

    await targetFolder.click();
    await explorer.getByRole('button', { name: 'New folder…' }).click();
    const editor = explorer.getByTestId('files-tree-inline-editor');
    await expect(editor).toBeVisible();
    await editor.fill('nested-parent/nested-child');
    await editor.press('Enter');
    await expect
      .poll(() =>
        existsSync(
          path.join(worktreePath, 'target', 'nested-parent', 'nested-child'),
        ),
      )
      .toBe(true);
    await expect(explorer.getByRole('alert')).toHaveCount(0);

    await targetFolder.click();
    await explorer.getByRole('button', { name: 'New folder…' }).click();
    await expect(editor).toBeVisible();
    await editor.fill('nested');
    await editor.press('Enter');
    await expect
      .poll(() => existsSync(path.join(worktreePath, 'target', 'nested')))
      .toBe(true);

    const nestedFolder = folder(window, 'target/nested');
    await expect(nestedFolder).toBeVisible();
    await nestedFolder.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'New file…' }).click();
    await expect(editor).toBeVisible();
    await editor.fill('created.txt');
    await editor.press('Enter');
    await expect
      .poll(() =>
        existsSync(path.join(worktreePath, 'target', 'nested', 'created.txt')),
      )
      .toBe(true);

    const created = row(window, 'target/nested/created.txt');
    await created.focus();
    await created.press('F2');
    await editor.fill('renamed.txt');
    await editor.press('Enter');
    await expect
      .poll(() =>
        existsSync(path.join(worktreePath, 'target', 'nested', 'renamed.txt')),
      )
      .toBe(true);

    const renamedFile = row(window, 'target/nested/renamed.txt');
    await renamedFile.focus();
    await renamedFile.press('F2');
    await expect(editor).toHaveValue('renamed.txt');
    await editor.fill('');
    await editor.press('Enter');
    await expect(explorer.getByRole('alert')).toContainText(
      'Enter a file or folder name.',
    );
    await expect(explorer.getByRole('alert')).not.toContainText(
      'Names cannot contain path separators.',
    );
    await editor.fill('renamed.txt');
    await explorer.getByTestId('files-tree-refresh').click();
    await expect(editor).toHaveCount(0);
    await expect(explorer.getByRole('alert')).toHaveCount(0);
    expect(
      existsSync(path.join(worktreePath, 'target', 'nested', 'renamed.txt')),
    ).toBe(true);

    await renamedFile.focus();
    await renamedFile.press(
      process.platform === 'darwin' ? 'Meta+C' : 'Control+C',
    );
    await nestedFolder.focus();
    await nestedFolder.press(
      process.platform === 'darwin' ? 'Meta+V' : 'Control+V',
    );
    await expect
      .poll(() =>
        existsSync(
          path.join(worktreePath, 'target', 'nested', 'renamed copy.txt'),
        ),
      )
      .toBe(true);

    const sourceFolder = folder(window, 'source');
    await sourceFolder.click();
    const moveMe = row(window, 'source/move-me.txt');
    await expect(moveMe).toBeVisible();
    await moveMe.dragTo(targetFolder);
    await expect
      .poll(
        () =>
          existsSync(path.join(worktreePath, 'target', 'move-me.txt')) &&
          !existsSync(path.join(worktreePath, 'source', 'move-me.txt')),
      )
      .toBe(true);

    const cutSource = folder(window, 'cut-source');
    const cutTarget = folder(window, 'cut-target');
    await cutSource.click();
    await cutSource.press('Space');
    const cutFirst = row(window, 'cut-source/first.txt');
    const cutSecond = row(window, 'cut-source/second.txt');
    await cutFirst.focus();
    await cutFirst.press('Space');
    await cutSecond.focus();
    await cutSecond.press('Space');
    await expect(cutFirst).toHaveAttribute('aria-selected', 'true');
    await expect(cutSecond).toHaveAttribute('aria-selected', 'true');
    await cutSecond.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Cut', exact: true }).click();
    await cutTarget.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await expect
      .poll(
        () =>
          existsSync(path.join(worktreePath, 'cut-target', 'first.txt')) &&
          !existsSync(path.join(worktreePath, 'cut-source', 'first.txt')),
      )
      .toBe(true);
    await expect(explorer.getByRole('alert')).toContainText('already exists');

    unlinkSync(path.join(worktreePath, 'cut-target', 'second.txt'));
    await cutTarget.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await expect
      .poll(
        () =>
          existsSync(path.join(worktreePath, 'cut-target', 'second.txt')) &&
          !existsSync(path.join(worktreePath, 'cut-source', 'second.txt')),
      )
      .toBe(true);
    expect(
      readFileSync(path.join(worktreePath, 'cut-target', 'second.txt'), 'utf8'),
    ).toBe('second\n');

    const cutTree = folder(window, 'cut-tree');
    const cutTreeTarget = folder(window, 'cut-tree-target');
    await cutTree.click();
    const cutTreeChild = row(window, 'cut-tree/child.txt');
    const cutTreeOther = row(window, 'cut-tree-other.txt');
    await cutTreeChild.click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });
    await cutTreeOther.click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });
    await cutTreeOther.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Cut', exact: true }).click();
    await cutTreeTarget.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await expect
      .poll(
        () =>
          existsSync(path.join(worktreePath, 'cut-tree-target', 'cut-tree')) &&
          !existsSync(path.join(worktreePath, 'cut-tree')),
      )
      .toBe(true);
    await expect(explorer.getByRole('alert')).toContainText('already exists');

    unlinkSync(
      path.join(worktreePath, 'cut-tree-target', 'cut-tree-other.txt'),
    );
    await cutTreeTarget.click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await expect
      .poll(
        () =>
          existsSync(
            path.join(worktreePath, 'cut-tree-target', 'cut-tree-other.txt'),
          ) && !existsSync(path.join(worktreePath, 'cut-tree-other.txt')),
      )
      .toBe(true);

    const deleteSource = folder(window, 'delete-source');
    await deleteSource.click();
    await deleteSource.press('Space');
    const deleteFirst = row(window, 'delete-source/first.txt');
    const deleteSecond = row(window, 'delete-source/second.txt');
    await deleteFirst.focus();
    await deleteFirst.press('Space');
    await deleteSecond.focus();
    await deleteSecond.press('Space');
    await deleteSecond.press('Delete');
    unlinkSync(path.join(worktreePath, 'delete-source', 'second.txt'));
    await window.getByTestId('files-tree-delete-confirm-button').click();
    await expect
      .poll(() =>
        existsSync(path.join(worktreePath, 'delete-source', 'first.txt')),
      )
      .toBe(false);
    await expect(explorer.getByRole('alert')).toBeVisible();

    writeFileSync(
      path.join(worktreePath, 'delete-source', 'second.txt'),
      'second\n',
    );
    await window.getByTestId('files-tree-delete-confirm-button').click();
    await expect
      .poll(() =>
        existsSync(path.join(worktreePath, 'delete-source', 'second.txt')),
      )
      .toBe(false);
    await expect(window.getByTestId('files-tree-delete-confirm')).toHaveCount(
      0,
    );

    await row(window, 'target/move-me.txt').click({ button: 'right' });
    await window.getByRole('menuitem', { name: 'Delete' }).click();
    await window.getByRole('button', { name: /Delete/ }).click();
    await expect
      .poll(() => existsSync(path.join(worktreePath, 'target', 'move-me.txt')))
      .toBe(false);
    expect(
      readFileSync(
        path.join(worktreePath, 'target', 'nested', 'renamed.txt'),
        'utf8',
      ),
    ).toBe('');

    if ((await targetFolder.getAttribute('aria-expanded')) !== 'true') {
      await targetFolder.click();
    }
    if ((await nestedFolder.getAttribute('aria-expanded')) !== 'true') {
      await nestedFolder.click();
    }
    const renamed = row(window, 'target/nested/renamed.txt');
    const copied = row(window, 'target/nested/renamed copy.txt');
    await renamed.focus();
    await renamed.press('Space');
    await copied.focus();
    await copied.press('Space');
    await expect(renamed).toHaveAttribute('aria-selected', 'true');
    await expect(copied).toHaveAttribute('aria-selected', 'true');
    await copied.press('Delete');
    await window.getByRole('button', { name: /Delete/ }).click();
    await expect
      .poll(() =>
        existsSync(path.join(worktreePath, 'target', 'nested', 'renamed.txt')),
      )
      .toBe(false);
    await expect
      .poll(() =>
        existsSync(
          path.join(worktreePath, 'target', 'nested', 'renamed copy.txt'),
        ),
      )
      .toBe(false);

    mkdirSync(path.join(worktreePath, 'bulk-parent'), { recursive: true });
    writeFileSync(
      path.join(worktreePath, 'bulk-parent', 'child.txt'),
      'child\n',
    );
    await expect(folder(window, 'bulk-parent')).toBeVisible({
      timeout: 10_000,
    });
    const bulkParent = folder(window, 'bulk-parent');
    await bulkParent.click();
    const bulkChild = row(window, 'bulk-parent/child.txt');
    await expect(bulkChild).toBeVisible();
    await bulkChild.click({
      modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
    });
    await expect(bulkParent).toHaveAttribute('aria-selected', 'true');
    await expect(bulkChild).toHaveAttribute('aria-selected', 'true');
    await bulkChild.press('Delete');
    await window.getByTestId('files-tree-delete-confirm-button').click();
    await expect
      .poll(() => existsSync(path.join(worktreePath, 'bulk-parent')))
      .toBe(false);
    await expect(window.getByTestId('files-tree-delete-confirm')).toHaveCount(
      0,
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('file explorer expands and drags without loading flashes and creates from in-tree placeholders', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-explorer-inline-create-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  mkdirSync(path.join(worktreePath, 'destination'), { recursive: true });
  writeFileSync(
    path.join(worktreePath, 'destination', 'existing.txt'),
    'old\n',
  );
  writeFileSync(path.join(worktreePath, 'drag-me.txt'), 'drag\n');
  writeFileSync(
    path.join(worktreePath, 'drag-via-sibling.txt'),
    'drag sibling\n',
  );
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: 'explorer-inline-create-chat', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const explorer = await openExplorer(window);
    const destination = folder(window, 'destination');
    await expect(destination).toBeVisible({ timeout: 20_000 });
    await expect(explorer).toHaveAttribute('data-watching', 'true');
    await expect(
      explorer.getByRole('button', { name: 'Refresh files' }),
    ).toBeEnabled();

    await observeExplorerLoadingFlashes(explorer);
    await destination.click();
    await expect(destination).toHaveAttribute('aria-selected', 'true');
    await expect(row(window, 'destination/existing.txt')).toBeVisible();
    expect(await readExplorerLoadingFlashes(explorer)).toBe(0);

    await explorer.getByRole('button', { name: 'New file…' }).click();
    const placeholder = explorer.getByTestId(
      'files-tree-inline-editor-container',
    );
    const editor = explorer.getByTestId('files-tree-inline-editor');
    await expect(placeholder).toHaveAttribute(
      'data-parent-path',
      'destination',
    );
    await expect(placeholder).toHaveAttribute('data-create-kind', 'file');
    await expect(placeholder).toBeVisible();
    await editor.fill('cancelled.txt');
    await editor.press('Escape');
    await expect(placeholder).toHaveCount(0);
    expect(
      existsSync(path.join(worktreePath, 'destination', 'cancelled.txt')),
    ).toBe(false);

    await explorer.getByRole('button', { name: 'New file…' }).click();
    await expect(placeholder).toHaveAttribute(
      'data-parent-path',
      'destination',
    );
    await editor.fill('blur-created.txt');
    await explorer.getByRole('button', { name: 'Search files' }).click();
    await expect
      .poll(() =>
        existsSync(path.join(worktreePath, 'destination', 'blur-created.txt')),
      )
      .toBe(true);

    await destination.click();
    await expect(destination).toHaveAttribute('aria-selected', 'true');
    await explorer.getByRole('button', { name: 'New folder…' }).click();
    await expect(placeholder).toHaveAttribute(
      'data-parent-path',
      'destination',
    );
    await expect(placeholder).toHaveAttribute('data-create-kind', 'directory');
    await editor.fill('enter-created');
    await editor.press('Enter');
    await expect
      .poll(() =>
        existsSync(path.join(worktreePath, 'destination', 'enter-created')),
      )
      .toBe(true);

    if ((await destination.getAttribute('aria-expanded')) !== 'true') {
      await destination.click();
    }
    await row(window, 'drag-via-sibling.txt').click({ button: 'right' });
    await window
      .getByTestId('files-tree-action-menu')
      .getByRole('menuitem', { name: 'Copy', exact: true })
      .click();
    await observeExplorerLoadingFlashes(explorer);
    await row(window, 'drag-me.txt').dragTo(destination);
    await expect
      .poll(() =>
        existsSync(path.join(worktreePath, 'destination', 'drag-me.txt')),
      )
      .toBe(true);
    expect(await readExplorerLoadingFlashes(explorer)).toBe(0);
    await destination.click({ button: 'right' });
    await expect(
      window
        .getByTestId('files-tree-action-menu')
        .getByRole('menuitem', { name: 'Paste', exact: true }),
    ).toBeEnabled();
    await window.keyboard.press('Escape');

    const sibling = row(window, 'destination/existing.txt');
    const draggedViaSibling = row(window, 'drag-via-sibling.txt');
    const dataTransfer = await window.evaluateHandle(() => new DataTransfer());
    await draggedViaSibling.dispatchEvent('dragstart', { dataTransfer });
    await sibling.dispatchEvent('dragover', { dataTransfer });
    await expect(destination).toHaveClass(/ring-1/);
    await sibling.dispatchEvent('drop', { dataTransfer });
    await expect
      .poll(() =>
        existsSync(
          path.join(worktreePath, 'destination', 'drag-via-sibling.txt'),
        ),
      )
      .toBe(true);
    await expect
      .poll(() => existsSync(path.join(worktreePath, 'drag-via-sibling.txt')))
      .toBe(false);

    await explorer.getByRole('button', { name: 'New file…' }).click();
    await expect(editor).toHaveValue('');
    await explorer.getByText('Files', { exact: true }).click();
    await expect(placeholder).toHaveCount(0);
    await expect(explorer.getByRole('alert')).toHaveCount(0);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// The Refresh files control is the shared FilesTreeRefreshButton. With early
// access off it draws the catalog refresh glyph through RefreshSpinner in the
// compact desktop row (14px, no tooltip wrapper) and relists the tree on click.
test('file explorer refresh control relists the tree with the catalog glyph', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-explorer-refresh-control-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: 'explorer-refresh-control-chat', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const explorer = await openExplorer(window);
    const refresh = explorer.getByRole('button', { name: 'Refresh files' });
    await expect(refresh).toHaveAttribute('data-testid', 'files-tree-refresh');
    await expect(refresh).toBeEnabled({ timeout: 20_000 });
    const glyph = refresh.locator('svg');
    await expect(glyph).toHaveAttribute('data-app-icon', 'true');
    await expect(glyph).toHaveAttribute('width', '14px');
    await expect(glyph).not.toHaveClass(/animate-spin/);

    writeFileSync(
      path.join(worktreePath, 'refresh-control-added.txt'),
      'added\n',
    );
    await refresh.click();
    await expect(row(window, 'refresh-control-added.txt')).toBeVisible({
      timeout: 20_000,
    });
    await expect(refresh).toBeEnabled();
    await expect(glyph).not.toHaveClass(/animate-spin/);
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('file explorer auto-expands only a directly hovered folder after 500ms', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-explorer-hover-expand-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  mkdirSync(path.join(worktreePath, 'hover-target'), { recursive: true });
  mkdirSync(path.join(worktreePath, 'sibling-parent'), { recursive: true });
  writeFileSync(
    path.join(worktreePath, 'hover-target', 'nested.txt'),
    'nested\n',
  );
  writeFileSync(
    path.join(worktreePath, 'sibling-parent', 'sibling.txt'),
    'sibling\n',
  );
  writeFileSync(path.join(worktreePath, 'hover-source.txt'), 'source\n');
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: 'explorer-hover-expand-chat', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const explorer = await openExplorer(window);
    const hoverTarget = folder(window, 'hover-target');
    const siblingParent = folder(window, 'sibling-parent');
    await expect(hoverTarget).toBeVisible({ timeout: 20_000 });
    await siblingParent.click();
    const sibling = row(window, 'sibling-parent/sibling.txt');
    await expect(sibling).toBeVisible();
    if ((await hoverTarget.getAttribute('aria-expanded')) === 'true') {
      await hoverTarget.click();
    }

    const dataTransfer = await window.evaluateHandle(() => new DataTransfer());
    const source = row(window, 'hover-source.txt');
    await source.dispatchEvent('dragstart', { dataTransfer });
    await hoverTarget.dispatchEvent('dragover', { dataTransfer });
    await window.waitForTimeout(200);
    await sibling.dispatchEvent('dragover', { dataTransfer });
    await expect(siblingParent).toHaveClass(/ring-1/);
    await window.waitForTimeout(700);
    await expect(hoverTarget).toHaveAttribute('aria-expanded', 'false');

    await hoverTarget.dispatchEvent('dragover', { dataTransfer });
    await window.waitForTimeout(350);
    await expect(hoverTarget).toHaveAttribute('aria-expanded', 'false');
    await expect(hoverTarget).toHaveAttribute('aria-expanded', 'true', {
      timeout: 500,
    });
    await source.dispatchEvent('dragend', { dataTransfer });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('file explorer detects external mutations only while its panel is visible', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-explorer-watch-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: 'explorer-watch-chat', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    const explorer = await openExplorer(window);
    await expect(explorer).toHaveAttribute('data-watching', 'true');
    const stablePath = 'README.md';
    const stableRow = explorer.locator(
      `[data-testid="files-tree-row"][data-path="${stablePath}"]`,
    );
    await expect(stableRow).toBeVisible();
    // Opening the explorer can finish an initial directory fetch and sticky
    // layout pass after the first row becomes visible. Let the panel's 250ms
    // geometry transition finish, then start measuring only once the initial
    // tree has been mutation-quiet, so the assertion below isolates work
    // caused by the manual refresh itself.
    await window.waitForTimeout(300);
    await explorer.evaluate(
      (element) =>
        new Promise((resolve) => {
          let quietTimer = 0;
          const observer = new MutationObserver(() => {
            window.clearTimeout(quietTimer);
            quietTimer = window.setTimeout(() => {
              observer.disconnect();
              resolve(undefined);
            }, 100);
          });
          observer.observe(element, { childList: true, subtree: true });
          quietTimer = window.setTimeout(() => {
            observer.disconnect();
            resolve(undefined);
          }, 100);
        }),
    );
    await explorer.evaluate((element, stablePath) => {
      const refreshButton = element.querySelector(
        '[data-testid="files-tree-refresh"]',
      );
      const originalGetBoundingClientRect =
        HTMLElement.prototype.getBoundingClientRect;
      const state = {
        measurements: 0,
        sawRefreshStart: false,
        resolveRefresh: null,
      };
      HTMLElement.prototype.getBoundingClientRect = function () {
        if (element.contains(this) && this.matches('[data-file-tree-folder]')) {
          state.measurements += 1;
        }
        return originalGetBoundingClientRect.call(this);
      };
      const refreshComplete = new Promise((resolve) => {
        state.resolveRefresh = resolve;
      });
      const observer = new MutationObserver(() => {
        if (refreshButton?.hasAttribute('disabled')) {
          state.sawRefreshStart = true;
        } else if (state.sawRefreshStart) {
          state.resolveRefresh?.();
        }
      });
      if (refreshButton) {
        observer.observe(refreshButton, { attributes: true });
      }
      window.__fileExplorerRefreshMeasurement = {
        state,
        refreshComplete,
        observer,
        originalGetBoundingClientRect,
        stableRow: element.querySelector(
          `[data-testid="files-tree-row"][data-path="${stablePath}"]`,
        ),
      };
    }, stablePath);

    await explorer.getByRole('button', { name: 'Refresh files' }).click();
    await explorer.evaluate(
      () => window.__fileExplorerRefreshMeasurement.refreshComplete,
    );
    expect(
      await explorer.evaluate(
        () => window.__fileExplorerRefreshMeasurement.state.measurements,
      ),
    ).toBe(0);

    writeFileSync(
      path.join(worktreePath, 'external-created.txt'),
      'external\n',
    );
    await expect(row(window, 'external-created.txt')).toBeVisible({
      timeout: 10_000,
    });
    expect(
      await explorer.evaluate(
        (element, stablePath) =>
          window.__fileExplorerRefreshMeasurement.stableRow?.isSameNode(
            element.querySelector(
              `[data-testid="files-tree-row"][data-path="${stablePath}"]`,
            ),
          ) ?? false,
        stablePath,
      ),
    ).toBe(true);

    await explorer.evaluate(() => {
      const measurement = window.__fileExplorerRefreshMeasurement;
      measurement.observer.disconnect();
      HTMLElement.prototype.getBoundingClientRect =
        measurement.originalGetBoundingClientRect;
    });

    await window
      .locator('[role="tab"][data-panel-kind="chat"]')
      .first()
      .click();
    await expect(explorer).not.toBeVisible();
    await expect(explorer).toHaveAttribute('data-watching', 'false');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

// Two visible surfaces on one worktree share a watch: closing one must not
// stop live updates in the other.
test('file explorer keeps live updates after another tree on the same worktree closes', async () => {
  const userDataDir = mkdtempSync(
    path.join(os.tmpdir(), 'canopy-explorer-shared-watch-'),
  );
  const demoSeed = seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  const worktreePath = demoSeed.workspaces[0]?.worktreePath;
  expect(worktreePath, 'seeded worktree path').toBeTruthy();
  seedWorktreeChat({
    userDataDir,
    workspaceId: 'demo-ts-pnpm-vite',
    worktreeId: WORKTREE_BRANCH,
    providerType: 'claude',
    tabs: [{ id: 'explorer-shared-watch-chat', title: 'Chat' }],
  });

  const { electronApp } = await launchCanopy({ userDataDir });
  try {
    const window = await electronApp.firstWindow();
    await openExplorer(window);
    const explorer = window
      .getByTestId('panel-content-file-explorer')
      .getByTestId('files-tree-tab');

    // A File tab's embedded tree is the second surface. Move the explorer
    // beside it so both stay visible, and so both hold the watch.
    await window.getByTestId('panel-add-tab-group-chat').click();
    await window.getByTestId('panel-add-menu-item-new-file').click();
    const embedded = window
      .getByTestId('file-tab-tree')
      .getByTestId('files-tree-tab');
    await expect(embedded).toBeVisible();
    // Panels added from the menu get generated ids; read them from the layout.
    const explorerPanel = await findPanelOfKind(window, 'file-explorer');
    const filePanel = await findPanelOfKind(window, 'file-diff');
    await window.evaluate((panelId) => {
      window.__canopyPanelTestApi.setFixedTopology(false);
      window.__canopyPanelTestApi.movePanel(panelId, 'group-chat', 'right');
    }, explorerPanel.panelId);
    await expect
      .poll(
        async () => (await findPanelOfKind(window, 'file-explorer')).groupId,
      )
      .not.toBe(filePanel.groupId);
    await expect(explorer).toBeVisible();
    await expect(embedded).toBeVisible();
    await expect(explorer).toHaveAttribute('data-watching', 'true');
    await expect(embedded).toHaveAttribute('data-watching', 'true');

    const treeRow = (surface, relativePath) =>
      surface.locator(
        `[data-testid="files-tree-row"][data-path="${relativePath}"]`,
      );
    writeFileSync(path.join(worktreePath, 'shared-before.txt'), 'before\n');
    await expect(treeRow(explorer, 'shared-before.txt')).toBeVisible({
      timeout: 10_000,
    });
    await expect(treeRow(embedded, 'shared-before.txt')).toBeVisible({
      timeout: 10_000,
    });

    // A remount or a re-run watch effect would re-arm the watch and hide a
    // dropped subscription: mark the element and record every disarm.
    await explorer.evaluate((element) => {
      element.dataset.sharedWatchProbe = 'kept';
      const disarms = [];
      new MutationObserver(() => {
        if (element.dataset.watching !== 'true') disarms.push(Date.now());
      }).observe(element, {
        attributes: true,
        attributeFilter: ['data-watching'],
      });
      window.__sharedWatchDisarms = disarms;
    });

    const fileTab = window.getByTestId(`panel-tab-${filePanel.panelId}`);
    await fileTab.hover();
    await window.getByTestId(`panel-tab-close-${filePanel.panelId}`).click();
    await expect(fileTab).toHaveCount(0);
    await expect(window.getByTestId('file-tab-tree')).toHaveCount(0);
    await expect(explorer).toBeVisible();
    await expect(explorer).toHaveAttribute('data-shared-watch-probe', 'kept');
    await expect(explorer).toHaveAttribute('data-watching', 'true');

    // Two separate changes: without the watch, the 30 s diff-stats poll can
    // refresh the tree once, but not twice within these waits.
    writeFileSync(path.join(worktreePath, 'shared-after.txt'), 'after\n');
    await expect(treeRow(explorer, 'shared-after.txt')).toBeVisible({
      timeout: 10_000,
    });
    unlinkSync(path.join(worktreePath, 'shared-before.txt'));
    await expect(treeRow(explorer, 'shared-before.txt')).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(explorer).toHaveAttribute('data-shared-watch-probe', 'kept');
    expect(await window.evaluate(() => window.__sharedWatchDisarms)).toEqual(
      [],
    );
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});
